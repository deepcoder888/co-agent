Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:CoSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-CoDataDir {
    if ($env:CO_AGENT_DATA_DIR) { return [IO.Path]::GetFullPath($env:CO_AGENT_DATA_DIR) }
    if ($env:AGENT_HUB_DATA_DIR) { return [IO.Path]::GetFullPath($env:AGENT_HUB_DATA_DIR) }
    return Join-Path $env:LOCALAPPDATA 'CO-AGENT'
}
function Test-CoInside($parent, $child) {
    $parent = [IO.Path]::GetFullPath($parent).TrimEnd('\', '/')
    $child = [IO.Path]::GetFullPath($child).TrimEnd('\', '/')
    return $child.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Assert-CoNoLinks($target) {
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝操作链接或 junction：$target" }
        if ($item.PSIsContainer) {
            # Enumerate one level at a time; never traverse a reparse point.
            foreach ($entry in Get-ChildItem -LiteralPath $target -Force) { Assert-CoNoLinks $entry.FullName }
        }
    }
}
function Assert-CoTarget($target) {
    $absolute = [IO.Path]::GetFullPath($target).TrimEnd('\', '/')
    $root = [IO.Path]::GetPathRoot($absolute).TrimEnd('\', '/')
    if ($absolute -eq $root) { throw '安装目录不能是磁盘根目录' }
    $protected = @($script:CoSource, (Get-CoDataDir), (Join-Path $env:LOCALAPPDATA 'CO-AGENT'), (Join-Path $env:LOCALAPPDATA 'Agent Hub'),
        (Join-Path $HOME '.codex'), (Join-Path $HOME '.claude'))
    foreach ($entry in $protected) {
        if ((Test-CoInside $entry $absolute) -or (Test-CoInside $absolute $entry)) { throw "安装目录与仓库、运行数据或只读目录重叠：$absolute" }
    }
    # Reject links in the target's ancestry as well as in its managed trees.
    $ancestor = $absolute
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "安装目录祖先是链接：$ancestor" }
        }
        $ancestor = Split-Path -Path $ancestor -Parent
    }
    return $absolute
}
function Get-CoPort {
    $data = Get-CoDataDir
    $file = Join-Path $data 'config.json'
    if (!(Test-Path -LiteralPath $file) -and !$env:CO_AGENT_DATA_DIR -and !$env:AGENT_HUB_DATA_DIR) { $file = Join-Path $env:LOCALAPPDATA 'Agent Hub/config.json' }
    $port = 47821
    if (Test-Path -LiteralPath $file) {
        $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($config.PSObject.Properties.Name -contains 'port') { $port = $config.port }
    }
    if ($port -isnot [int] -and $port -isnot [long]) { throw '配置中的 port 必须为整数' }
    if ($port -lt 1 -or $port -gt 65535) { throw '窗口启动器需要 1–65535 的固定端口' }
    return $port
}
function Get-CoDependencies($overrides) {
    $deps = @{
        ResolveNode = { $command = Get-Command node -CommandType Application -ErrorAction Stop; [IO.Path]::GetFullPath($command.Source) }
        Health = { param($port) try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 } catch { $null } }
        Process = { param($processId) Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop }
        Processes = { Get-CimInstance Win32_Process -ErrorAction Stop }
        # Electron's child processes exit with the main process, so one may be gone before its own turn; only a survivor is an error.
        Stop = { param($processId) try { Stop-Process -Id $processId -ErrorAction Stop } catch { if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw } } }
        WaitExit = {
            param($processIds, $seconds)
            # One shared deadline: stopped processes must exit and release file handles before cleanup.
            $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
            foreach ($processId in $processIds) {
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if (!$process) { continue }
                $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
                if (!$process.WaitForExit($remaining)) { throw "CO-AGENT 进程 $processId 未在 $seconds 秒内退出，未清理安装目录" }
            }
        }
        Remove = { param($path) Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
        Sleep = { param($milliseconds) Start-Sleep -Milliseconds $milliseconds }
        RemoveTimeoutMs = 10000
        RemoveDelayMs = 250
        Shortcut = {
            param($file, $target, $arguments, $icon, $working)
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($file)
            $shortcut.TargetPath = $target; $shortcut.Arguments = $arguments
            $shortcut.IconLocation = $icon; $shortcut.WorkingDirectory = $working
            $shortcut.Save()
        }
    }
    foreach ($key in $overrides.Keys) { $deps[$key] = $overrides[$key] }
    return $deps
}
function Stop-CoInstalled($install, $port, $deps) {
    $exe = [IO.Path]::GetFullPath((Join-Path $install 'CO-AGENT.exe'))
    $server = [IO.Path]::GetFullPath((Join-Path $install 'src/server.mjs'))
    $escaped = [regex]::Escape($server).Replace('\\', '[\\/]')
    $stopped = [System.Collections.Generic.List[object]]::new()
    foreach ($running in @(& $deps.Processes)) {
        $processId = $running.ProcessId
        if (($processId -isnot [int] -and $processId -isnot [long] -and $processId -isnot [uint32]) -or $processId -le 0) { continue }
        if (!$running.ExecutablePath) { continue }
        try { $executable = [IO.Path]::GetFullPath($running.ExecutablePath) } catch { continue }
        $isDesktop = $executable.Equals($exe, [StringComparison]::OrdinalIgnoreCase)
        $isLegacy = [IO.Path]::GetFileName($executable).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
            $running.CommandLine -match ('(?:^|\s)(?:"' + $escaped + '"|' + $escaped + ')(?=\s|$)')
        if ($isDesktop -or $isLegacy) { & $deps.Stop $processId; $stopped.Add($processId) }
    }
    if ($stopped.Count) { & $deps.WaitExit @($stopped.ToArray()) 15 }
}
function Assert-CoOwned($target, [switch]$AllowEmpty) {
    if (!(Test-Path -LiteralPath $target)) { return }
    if (!(Test-Path -LiteralPath $target -PathType Container)) { throw '安装目标必须为目录' }
    Assert-CoNoLinks $target
    if ($AllowEmpty -and @(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { return }
    $marker = Join-Path $target '.co-agent-install.json'
    if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { throw '缺少 CO-AGENT 安装标识，拒绝清空目录' }
    $record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($record.app -ne 'CO-AGENT' -or ![IO.Path]::IsPathFullyQualified($record.installDir) -or
        ![IO.Path]::GetFullPath($record.installDir).TrimEnd('\', '/').Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
        throw '安装标识不匹配，拒绝清空目录'
    }
}
function Remove-CoEntry($path, $deps) {
    # Bounded exponential waits: 250 + 500 + 1000 + 2000 + 4000 ms, then rethrow the file error.
    $waited = 0
    $delay = [Math]::Max(1, $deps.RemoveDelayMs)
    while ($true) {
        if ($waited -and !(Test-Path -LiteralPath $path)) { return }
        try { & $deps.Remove $path; return }
        catch [System.IO.IOException], [System.UnauthorizedAccessException] {
            if ($waited + $delay -gt $deps.RemoveTimeoutMs) { throw }
            & $deps.Sleep $delay
            $waited += $delay
            $delay *= 2
        }
    }
}
function Clear-CoOwnedContents($target, $deps) {
    # Keep the marker so a cleanup that fails on a locked file can be retried; callers remove or rewrite it last.
    $marker = [IO.Path]::GetFullPath((Join-Path $target '.co-agent-install.json'))
    foreach ($entry in Get-ChildItem -LiteralPath $target -Force) {
        $destination = [IO.Path]::GetFullPath($entry.FullName)
        if ($destination -eq $marker) { continue }
        if (!(Test-CoInside $target $destination) -or $destination -eq $target) { throw '清理路径越界' }
        Remove-CoEntry $destination $deps
    }
}
function Get-CoShortcutPaths($desktop, $startMenu) {
    $paths = @((Join-Path $desktop 'CO-AGENT.lnk'), (Join-Path $startMenu 'CO-AGENT.lnk'))
    foreach ($file in $paths) {
        foreach ($protected in @((Get-CoDataDir), (Join-Path $env:LOCALAPPDATA 'CO-AGENT'), (Join-Path $env:LOCALAPPDATA 'Agent Hub'),
            $script:CoSource, (Join-Path $HOME '.codex'), (Join-Path $HOME '.claude'))) {
            if (Test-CoInside $protected $file) { throw "快捷方式不能位于运行数据或只读目录：$file" }
        }
        $ancestor = [IO.Path]::GetFullPath($file)
        while ($ancestor) {
            if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "快捷方式路径是链接：$ancestor" }
            $ancestor = Split-Path -Path $ancestor -Parent
        }
    }
    return $paths
}
