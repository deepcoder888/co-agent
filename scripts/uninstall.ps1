[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs/CO-AGENT'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
    [switch]$Yes, [switch]$NoShortcuts
)
# v0.53: Windows PowerShell 5.1 (powershell.exe, "Run with PowerShell") cannot run these scripts. The UTF-8 BOM lets it
# parse them; this check then stops with one clear message before anything PowerShell 7 needs.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "CO-AGENT 需要 PowerShell 7（pwsh），这里是 Windows PowerShell $($PSVersionTable.PSVersion)，没有做任何改动。" -ForegroundColor Red
    Write-Host '请先安装 PowerShell 7：winget install --id Microsoft.PowerShell --source winget'
    Write-Host "然后运行：pwsh -File `"$PSCommandPath`""
    Write-Host "CO-AGENT needs PowerShell 7 (pwsh); this is Windows PowerShell $($PSVersionTable.PSVersion), nothing was changed." -ForegroundColor Red
    Write-Host "Install PowerShell 7 (winget install --id Microsoft.PowerShell --source winget), then run: pwsh -File `"$PSCommandPath`""
    if ([Environment]::UserInteractive -and !([Environment]::GetCommandLineArgs() -match '^-NonI')) { Read-Host '按回车键关闭' | Out-Null }
    exit 1
}
. (Join-Path $PSScriptRoot 'install-common.ps1')
function Uninstall-CoAgent {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs/CO-AGENT'),
        [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
        [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
        [switch]$Yes, [switch]$NoShortcuts, [hashtable]$Dependencies = @{}
    )
    $target = Assert-CoTarget $InstallDir
    $dataDir = Get-CoDataDir
    $shortcuts = @()
    if (!$NoShortcuts) { $shortcuts = Get-CoShortcutPaths $DesktopDir $StartMenuDir }
    Assert-CoOwned $target
    if (!$Yes -and !$WhatIfPreference) {
        if ((Read-Host "确认卸载 CO-AGENT：$target？运行数据将保留。输入 YES") -cne 'YES') { Write-Output '已取消卸载'; return }
    }
    if (!$PSCmdlet.ShouldProcess($target, '卸载 CO-AGENT，保留运行数据')) { return }
    $deps = Get-CoDependencies $Dependencies
    Stop-CoInstalled $target 0 $deps
    if (!$NoShortcuts) {
        foreach ($file in $shortcuts) {
            Assert-CoNoLinks $file
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }
    # Assert-CoTarget checked the resolved absolute target against all data/protected paths.
    # Remove the marker only after every other entry is gone, so a locked file leaves a retryable install.
    if (Test-Path -LiteralPath $target) { Assert-CoOwned $target; Clear-CoOwnedContents $target $deps; Remove-CoEntry $target $deps }
    Write-Output "CO-AGENT 已卸载。运行数据保留：$dataDir（旧数据：$(Join-Path $env:LOCALAPPDATA 'Agent Hub')）"
}
if ($MyInvocation.InvocationName -ne '.') {
    try { Uninstall-CoAgent @PSBoundParameters } catch { Write-Error $_; exit 1 }
}
