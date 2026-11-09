[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$From = (Join-Path $PSScriptRoot '../release/CO-AGENT-win32-x64'),
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs/CO-AGENT'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
    [switch]$NoShortcuts, [switch]$Uninstall, [switch]$Yes,
    # v0.50: the daily-concept task calls Codex every day, so it is registered only on request.
    # -DailyConcept registers it, -NoDailyConcept removes it, neither keeps whatever is there.
    [switch]$DailyConcept, [switch]$NoDailyConcept,
    [hashtable]$Dependencies = @{}
)
. (Join-Path $PSScriptRoot 'install-common.ps1')

function Register-CoDailyTask {
    param([string]$InstallDir)
    $action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'CO-AGENT.exe') -Argument '--daily-concept'
    $trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '09:00' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 3)).Repetition
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'CO-AGENT 每日概念' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}
function Remove-CoDailyTask {
    # Enumerate without suppressing service/permission errors; absent is idempotent.
    $existing = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'CO-AGENT 每日概念' })
    if ($existing.Count) { Unregister-ScheduledTask -TaskName 'CO-AGENT 每日概念' -Confirm:$false -ErrorAction Stop }
}
function Get-CoDailyDependencies([hashtable]$Overrides) {
    # An injected installer must not fall through to the real task scheduler.
    # Existing isolated installer fixtures inject process/shortcut dependencies.
    $deps = @{ RegisterDailyTask = {}; RemoveDailyTask = {} }
    if (!$Overrides.Count) {
        $deps.RegisterDailyTask = { param($target) Register-CoDailyTask $target }
        $deps.RemoveDailyTask = { Remove-CoDailyTask }
    }
    foreach ($key in @('RegisterDailyTask', 'RemoveDailyTask')) {
        if ($Overrides.ContainsKey($key)) { $deps[$key] = $Overrides[$key] }
    }
    return $deps
}

function Install-CoAgent {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$From = (Join-Path $script:CoSource 'release/CO-AGENT-win32-x64'),
        [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs/CO-AGENT'),
        [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
        [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
        [switch]$NoShortcuts, [switch]$DailyConcept, [switch]$NoDailyConcept, [hashtable]$Dependencies = @{}
    )
    if ($DailyConcept -and $NoDailyConcept) { throw '-DailyConcept 和 -NoDailyConcept 不能同时使用' }
    $source = [IO.Path]::GetFullPath($From).TrimEnd('\', '/')
    if (!(Test-Path -LiteralPath $source -PathType Container)) { throw "离线打包目录不存在：$source；请先运行 npm run package" }
    foreach ($file in @('CO-AGENT.exe', 'resources/app/src/server.mjs', 'resources/app/package.json')) {
        if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw "打包文件缺失：$file；请先运行 npm run package" }
    }
    Assert-CoNoLinks $source
    $target = Assert-CoTarget $InstallDir
    if ((Test-CoInside $source $target) -or (Test-CoInside $target $source)) { throw '安装目录与打包来源重叠，拒绝替换' }
    Assert-CoOwned $target -AllowEmpty
    $shortcuts = @()
    if (!$NoShortcuts) { $shortcuts = Get-CoShortcutPaths $DesktopDir $StartMenuDir }
    $deps = Get-CoDependencies $Dependencies
    if (!$PSCmdlet.ShouldProcess($target, '安装/更新 CO-AGENT 桌面应用')) { return }
    Stop-CoInstalled $target 0 $deps
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    # Recheck ownership immediately before deletion; every resolved child stays within target.
    Assert-CoOwned $target -AllowEmpty
    # The marker survives cleanup and copy so a failed install can be retried; it is rewritten below.
    Clear-CoOwnedContents $target $deps
    foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $target $entry.Name) -Recurse -Force
    }
    @{app='CO-AGENT';installDir=$target} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target '.co-agent-install.json') -Encoding utf8
    $exe = Join-Path $target 'CO-AGENT.exe'
    if (!$NoShortcuts) {
        foreach ($file in $shortcuts) {
            New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
            & $deps.Shortcut $file $exe '' $exe $target
        }
    }
    $daily = Get-CoDailyDependencies $Dependencies
    if ($DailyConcept) { & $daily.RegisterDailyTask $target }
    elseif ($NoDailyConcept) { & $daily.RemoveDailyTask }
    Write-Output "CO-AGENT 安装完成：$target；入口：$exe；运行数据：$(Get-CoDataDir)"
}

function Uninstall-CoAgentDaily {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs/CO-AGENT'),
        [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
        [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
        [switch]$Yes, [switch]$NoShortcuts, [hashtable]$Dependencies = @{}
    )
    $target = Assert-CoTarget $InstallDir
    Assert-CoOwned $target
    if (!$NoShortcuts) { $null = Get-CoShortcutPaths $DesktopDir $StartMenuDir }
    if (!$Yes -and !$WhatIfPreference) {
        if ((Read-Host "确认卸载 CO-AGENT：$target？运行数据将保留。输入 YES") -cne 'YES') { Write-Output '已取消卸载'; return }
    }
    if (!$PSCmdlet.ShouldProcess($target, '移除每日概念计划任务并卸载 CO-AGENT，保留运行数据')) { return }
    $daily = Get-CoDailyDependencies $Dependencies
    & $daily.RemoveDailyTask
    # Reuse the existing validated, path-scoped removal without expanding A1.
    # Dot-sourcing a script binds its param() defaults in THIS scope. Preserve
    # the validated arguments so they cannot become the user's real shortcuts.
    $uninstallArguments = @{ InstallDir=$target; DesktopDir=$DesktopDir; StartMenuDir=$StartMenuDir; Yes=$true; NoShortcuts=$NoShortcuts; Dependencies=$Dependencies }
    . (Join-Path $PSScriptRoot 'uninstall.ps1')
    Uninstall-CoAgent @uninstallArguments
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $parameters = @{} + $PSBoundParameters
        $parameters.Remove('Uninstall')
        if ($Uninstall) {
            if ($DailyConcept) { throw '卸载时不能使用 -DailyConcept' }
            # Uninstalling always removes the task.
            foreach ($key in @('From', 'DailyConcept', 'NoDailyConcept')) { $parameters.Remove($key) }
            Uninstall-CoAgentDaily @parameters
        }
        else { $parameters.Remove('Yes'); Install-CoAgent @parameters }
    } catch { Write-Error $_; exit 1 }
}
