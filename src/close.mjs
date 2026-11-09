import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicWrite } from './fsutil.mjs';
import { killProcessTree } from './concepts/runner.mjs';
import { processAlive } from './launch/verify.mjs';
import { scrubEnvironment } from './launch/spawner.mjs';

const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff && pid !== process.pid;
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const preamble = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$spec = [IO.File]::ReadAllText($env:CO_AGENT_CLOSE_SPEC, [Text.Encoding]::UTF8) | ConvertFrom-Json
`;
export const PROCESS_HELPER = preamble + String.raw`
$targetPid = [uint32]$spec.pid
if ($targetPid -eq 0) { throw 'PID 无效' }
$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $targetPid)
if ($null -eq $p) { [Console]::Out.Write('null'); exit 0 }
@{pid=[long]$p.ProcessId;name=[string]$p.Name;creationDate=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress
`;

// The native boundary is injected into CloseExact in tests: no real enumeration or WM_CLOSE.
export const WINDOW_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CoAgentWindowCloser {
    public class Window { public IntPtr Handle; public bool Visible; public string ClassName; public string Title; }
    public class Result { public bool windowClosed; public string windowReason; }
    public delegate bool EnumCallback(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    static Window ReadWindow(IntPtr hwnd) {
        var cls = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        var title = new StringBuilder(GetWindowTextLength(hwnd) + 2);
        GetWindowText(hwnd, title, title.Capacity);
        return new Window { Handle=hwnd, Visible=IsWindowVisible(hwnd), ClassName=cls.ToString(), Title=title.ToString() };
    }
    static bool Matches(Window w, string title) {
        return w != null && w.Visible && w.Handle != IntPtr.Zero &&
            String.Equals(w.ClassName, "CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) &&
            String.Equals(w.Title, title, StringComparison.Ordinal);
    }
    public static Result CloseExact(string title, Func<Window[]> enumerate, Func<IntPtr,bool> post) {
        if (String.IsNullOrEmpty(title)) return new Result { windowReason="终端窗口已不存在" };
        var matches = new List<Window>();
        foreach (var w in enumerate()) if (Matches(w, title)) matches.Add(w);
        if (matches.Count == 0) return new Result { windowReason="终端窗口已不存在" };
        if (matches.Count == 1) {
            bool sent = post(matches[0].Handle);
            return new Result { windowClosed=sent, windowReason=sent ? null : "终端窗口关闭请求失败" };
        }
        return new Result { windowReason="有多个同名终端窗口，请手动关闭" };
    }
    public static Result Run(string title) {
        return CloseExact(title, () => {
            var windows = new List<Window>();
            if (!EnumWindows((hwnd, param) => { windows.Add(ReadWindow(hwnd)); return true; }, IntPtr.Zero))
                throw new InvalidOperationException("无法枚举终端窗口");
            return windows.ToArray();
        }, hwnd => Matches(ReadWindow(hwnd), title) && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero));
    }
}`;
export const WINDOW_HELPER = preamble + "\nAdd-Type -TypeDefinition @'\n" + WINDOW_SOURCE + "\n'@\n[CoAgentWindowCloser]::Run([string]$spec.title) | ConvertTo-Json -Compress\n";

async function runHelper(script, request, config, { spawnImpl = spawn } = {}) {
  if (process.env.NODE_TEST_CONTEXT && spawnImpl === spawn) throw new Error('测试必须注入关闭辅助程序');
  const specFile = path.join(config.dataDir, 'close', `${randomUUID()}.json`);
  await atomicWrite(specFile, JSON.stringify(request) + '\n');
  try {
    return await new Promise((resolve, reject) => {
      let child, timer, settled = false, stdout = '', stderr = '';
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const stop = error => { child?.kill?.(); finish(error); }; // Only this helper, never the target or WT.
      try {
        child = spawnImpl(config.pwshExe, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], {
          shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'],
          env: { ...scrubEnvironment(process.env).env, CO_AGENT_CLOSE_SPEC: specFile },
        });
        timer = setTimeout(() => stop(new Error('关闭辅助程序超时')), 10000);
        child.once('error', finish);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => { stdout += data; if (stdout.length > 65536) stop(new Error('辅助程序输出过大')); });
        child.stderr.on('data', data => { stderr += data; if (stderr.length > 65536) stop(new Error('辅助程序错误输出过大')); });
        child.once('close', (code, signal) => {
          if (code !== 0 || signal) { finish(new Error(`关闭辅助程序失败（${signal || code}）：${stderr.trim()}`)); return; }
          try { finish(null, JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch { finish(new Error('关闭辅助程序返回无效 JSON')); }
        });
      } catch (error) { finish(error); }
    });
  } finally { await fs.rm(specFile, { force: true }); }
}

export async function queryProcess(pid, config, options) {
  if (!validPid(pid)) throw new Error('PID 无效');
  return runHelper(PROCESS_HELPER, { pid }, config, options);
}
export function identityMatches(record, identity) {
  const created = Date.parse(record.createdAt), observed = Date.parse(identity?.creationDate);
  // Every launcher records its PowerShell host PID, never a desktop/WT/CLI PID.
  return identity?.pid === record.pid && /^(?:pwsh|powershell)\.exe$/i.test(identity?.name || '') &&
    Number.isFinite(created) && Number.isFinite(observed) && observed >= created - 60000 && observed <= created + 180000;
}
export async function closeTerminalWindow(record, config, options) {
  if (typeof record.title !== 'string' || !record.title) return { windowClosed: false, windowReason: '终端窗口已不存在' };
  const result = await runHelper(WINDOW_HELPER, { title: record.title }, config, options);
  if (typeof result?.windowClosed !== 'boolean') throw new Error('终端窗口辅助程序返回格式无效');
  return { windowClosed: result.windowClosed, ...(!result.windowClosed ? { windowReason: result.windowReason || '终端窗口关闭请求失败' } : {}) };
}

export function createCloser(config, sessions, options = {}) {
  const { isAlive = processAlive, queryProcess: query = pid => queryProcess(pid, config), killTree = killProcessTree,
    closeWindow = record => closeTerminalWindow(record, config), now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  let work = Promise.resolve();
  async function one(item) {
    const outcome = result => ({ ...item, result });
    const record = sessions.registeredRecord(item.type, item.id);
    if (!record || record.closedAt) return outcome('not-running');
    if (!validPid(record.pid)) return outcome('pid-mismatch');
    if (process.env.NODE_TEST_CONTEXT && ['isAlive','queryProcess','killTree','closeWindow'].some(key => typeof options[key] !== 'function'))
      throw new Error('测试必须注入进程查询、存活检查、tree-kill 和窗口辅助程序');
    if (!isAlive(record.pid)) return outcome('not-running');
    try {
      if (!identityMatches(record, await query(record.pid))) return outcome('pid-mismatch');
      if (!isAlive(record.pid)) return outcome('not-running');
      const deadline = now() + 10000;
      await killTree({ pid: record.pid });
      while (isAlive(record.pid)) {
        if (now() >= deadline) throw new Error('进程树在 10 秒内未确认退出');
        await sleep(Math.min(50, deadline - now()));
      }
      let window = { windowClosed: false };
      if (record.terminalFallback !== 'no-wt') {
        try { window = await closeWindow(record); }
        catch (error) { window = { windowClosed: false, windowReason: `终端窗口需手动关闭：${error.message}` }; }
      }
      await sessions.markClosed(item.type, item.id, new Date(now()).toISOString());
      return { ...outcome('closed'), ...window };
    } catch (error) { return { ...outcome('failed'), error: error.message }; }
  }
  return {
    close(body) {
      if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50 ||
          body.items.some(item => !item || Object.keys(item).length !== 2 || !['launch','joint'].includes(item.type) || !validId(item.id)))
        return Promise.reject(Object.assign(new Error('items 必须为 1–50 个有效的 type 和 id'), { status: 400 }));
      const items = body.items.map(({ type, id }) => ({ type, id }));
      const next = work.then(async () => {
        const results = [];
        for (const item of items) results.push(await one(item));
        return { items: results };
      });
      work = next.catch(() => {}); return next;
    },
    idle: () => work,
  };
}
