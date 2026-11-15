param([Parameter(Mandatory = $true)][string]$SpecFile)
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
$ErrorActionPreference = 'Stop'
try {
    $spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding utf8 | ConvertFrom-Json
    $pidTemp = $spec.pidFile + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($pidTemp, [string]$PID, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($pidTemp, $spec.pidFile, $true)
    }
    finally {
        if (Test-Path -LiteralPath $pidTemp) { Remove-Item -LiteralPath $pidTemp -Force }
    }
    Set-Location -LiteralPath $spec.cwd
    $Host.UI.RawUI.WindowTitle = $spec.title
    # v0.53: an npm-installed CLI runs as node.exe with its .js entry first (exeArgs); older specs have none.
    $exeArgs = @($spec.exeArgs | Where-Object { $null -ne $_ })
    & $spec.exe @exeArgs @($spec.args)
    Write-Host "CLI 已退出，退出码：$LASTEXITCODE"
}
catch {
    Write-Error $_ -ErrorAction Continue
    Write-Host 'CLI 启动失败；窗口保留供检查。'
}
