import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

export function terminalArgs(specFile) {
  return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'launcher', 'launch.ps1'), '-SpecFile', specFile];
}

// Constant code only. Paths travel through environment variables, never code interpolation.
export const HELPER = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Quote-TerminalArgument {
    param([string]$Value, [bool]$ForWt = $false)
    if ($ForWt) { $Value = $Value.Replace(';', '\;') }
    # Windows argv parsing requires doubling trailing backslashes inside quotes.
    $Value = [regex]::Replace($Value, '\\+$', { param($m) $m.Value + $m.Value })
    return '"' + $Value + '"'
}
function Wait-TerminalPid {
    param([int]$TimeoutMs = 15000)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $env:AH_PIDFILE -PathType Leaf)) {
        if ($clock.ElapsedMilliseconds -ge $TimeoutMs) { throw "pidfile 等待超时（$TimeoutMs ms）：$env:AH_PIDFILE" }
        Start-Sleep -Milliseconds 50
    }
    $text = [IO.File]::ReadAllText($env:AH_PIDFILE).Trim()
    $terminalPid = 0
    if ($text -notmatch '^\d+$' -or -not [int]::TryParse($text, [ref]$terminalPid) -or $terminalPid -le 0) { throw 'pidfile 未包含有效终端 PID' }
    return $terminalPid
}
function Invoke-AgentTerminal {
    param([object[]]$Screens)
    $terminal = @('-NoLogo','-NoExit','-ExecutionPolicy','Bypass','-File',$env:AH_SCRIPT,'-SpecFile',$env:AH_SPEC)
    $display = $null; $x = $null; $y = $null; $fallback = $null
    if ($env:AH_WT) {
        $screen = if ($env:AH_DISPLAY -eq 'secondary') { $Screens | Where-Object { -not $_.Primary } | Select-Object -First 1 } else { $Screens | Where-Object { $_.Primary } | Select-Object -First 1 }
        if (-not $screen -and $env:AH_DISPLAY -eq 'secondary') {
            $screen = $Screens | Where-Object { $_.Primary } | Select-Object -First 1
            $fallback = 'primary'
        }
        if (-not $screen) { throw '无法找到目标显示器' }
        $display = $screen.DeviceName; $x = [int]$screen.Bounds.X + 40; $y = [int]$screen.Bounds.Y + 40
        $a = @('-w','new','--pos',"$x,$y")
        if ($env:AH_MODE -eq 'fullscreen') { $a += '--fullscreen' }
        elseif ($env:AH_MODE -eq 'maximized') { $a += '--maximized' }
        $a += @('--title',$env:AH_TITLE,'--suppressApplicationTitle','-d',$env:AH_CWD,$env:AH_PWSH) + $terminal
        $quoted = $a | ForEach-Object { Quote-TerminalArgument -Value $_ -ForWt $true }
        Start-Process -FilePath $env:AH_WT -ArgumentList ($quoted -join ' ') | Out-Null
    } else {
        $quoted = $terminal | ForEach-Object { Quote-TerminalArgument -Value $_ }
        Start-Process -FilePath $env:AH_PWSH -WorkingDirectory $env:AH_CWD -ArgumentList ($quoted -join ' ') | Out-Null
    }
    $result = @{pid=(Wait-TerminalPid);display=$display;x=$x;y=$y;mode=$env:AH_MODE;fallback=$fallback}
    if (-not $env:AH_WT) { $result.terminalFallback = 'no-wt' }
    return ($result | ConvertTo-Json -Compress)
}
try {
    $screens = @()
    if ($env:AH_WT) {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CoAgentDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
        if (-not [CoAgentDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw '无法启用 per-monitor v2 DPI 感知' }
        Add-Type -AssemblyName System.Windows.Forms
        $screens = [System.Windows.Forms.Screen]::AllScreens
    }
    [Console]::Out.Write((Invoke-AgentTerminal -Screens $screens))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}`;

export function helperArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HELPER];
}

export function terminalEnvironment(specFile, config) {
  const values = { AH_PWSH: config.pwshExe, AH_CWD: config.launchProject,
    AH_SCRIPT: path.join(projectRoot, 'launcher', 'launch.ps1'), AH_SPEC: path.resolve(specFile),
    AH_WT: config.wtExe ?? '', AH_DISPLAY: config.terminalDisplay ?? 'secondary', AH_MODE: config.terminalWindowMode ?? 'fullscreen',
    AH_TITLE: config.terminalTitle ?? 'CO-AGENT', AH_PIDFILE: config.terminalPidFile ?? path.resolve(specFile).replace(/\.json$/i, '') + '.pid' };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || /["\r\n]/.test(value)) throw new Error(`启动路径或参数 ${key} 包含双引号或换行，无法安全启动`);
  }
  if (!['primary', 'secondary'].includes(values.AH_DISPLAY) || !['fullscreen', 'maximized', 'normal'].includes(values.AH_MODE)) throw new Error('终端显示器或窗口模式无效');
  return values;
}

// Mirrors the constant helper's argv for API inspection, never used as shell code.
export function terminalPreview(specFile, config, { x, y } = {}) {
  const env = terminalEnvironment(specFile, config), terminal = terminalArgs(specFile);
  const wt = env.AH_WT ? ['-w', 'new', '--pos', x === undefined ? '<x>,<y>' : `${x},${y}`,
    ...(env.AH_MODE === 'normal' ? [] : [`--${env.AH_MODE}`]), '--title', env.AH_TITLE,
    '--suppressApplicationTitle', '-d', env.AH_CWD, env.AH_PWSH, ...terminal] : null;
  const quote = value => '"' + value.replaceAll(';', '\\;').replace(/\\+$/, match => match + match) + '"';
  return { helper: helperArgs(), terminal, wt, wtArgumentList: wt?.map(quote).join(' ') ?? null };
}

export function applyTerminalResult(record, config, result) {
  const { pid, display, x, y, mode, fallback, terminalFallback } = result;
  Object.assign(record, { pid, display, x, y, terminalWindowMode: mode, fallback });
  if (terminalFallback) record.terminalFallback = terminalFallback;
  record.argvPreview = terminalPreview(record.specFile, config, { x, y });
}

export function scrubEnvironment(original) {
  const env = { ...original }, scrubbedEnv = [];
  const host = /^(?:CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|CLAUDE_PLUGIN_|CLAUDE_PREVIEW_|CODEX_TOOLKIT_|CODEX_THREAD_ID$|CODEX_SANDBOX|OCTOPUS_WORKER$|ELECTRON_)/i;
  for (const key of Object.keys(env)) if (host.test(key)) { delete env[key]; scrubbedEnv.push(key); }
  return { env, scrubbedEnv };
}

// The only child-process boundary. Tests always supply a recording replacement.
export async function spawnTerminal(specFile, config, spawnImpl = spawn, originalEnv = process.env) {
  const paths = terminalEnvironment(specFile, config);
  let child;
  try {
    child = spawnImpl(config.pwshExe, helperArgs(), {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...scrubEnvironment(originalEnv).env, ...paths },
    });
  } catch (error) { throw new Error(`隐藏启动辅助进程无法启动：${error.message}`); }
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const diagnostic = () => `stderr：${stderr.trim() || '（空）'}`;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error(`隐藏启动辅助进程超时（20000 ms）；${diagnostic()}`));
      try { child.kill(); } catch { /* The helper may already have exited; no replacement is launched. */ }
    }, 20000);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(new Error(`隐藏启动辅助进程无法启动：${error.message}；${diagnostic()}`)));
    // close, unlike exit, guarantees that stdout and stderr have drained.
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        finish(new Error(`隐藏启动辅助进程失败（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）；${diagnostic()}`));
        return;
      }
      let result;
      try { result = JSON.parse(stdout.trim()); } catch { /* Invalid output is diagnosed below. */ }
      if (!result || !Number.isSafeInteger(result.pid) || result.pid <= 0) {
        finish(new Error(`隐藏启动辅助进程未返回有效终端 PID；${diagnostic()}`));
        return;
      }
      if (result.mode !== paths.AH_MODE || (result.fallback !== null && result.fallback !== 'primary') ||
          (paths.AH_WT ? typeof result.display !== 'string' || !result.display || !Number.isSafeInteger(result.x) || !Number.isSafeInteger(result.y) || result.terminalFallback !== undefined :
            result.terminalFallback !== 'no-wt' || result.display !== null || result.x !== null || result.y !== null)) {
        finish(new Error(`隐藏启动辅助进程返回的终端信息无效；${diagnostic()}`)); return;
      }
      finish(null, result);
    });
  });
}
