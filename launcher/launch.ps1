param([Parameter(Mandatory = $true)][string]$SpecFile)
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
    & $spec.exe @($spec.args)
    Write-Host "CLI 已退出，退出码：$LASTEXITCODE"
}
catch {
    Write-Error $_ -ErrorAction Continue
    Write-Host 'CLI 启动失败；窗口保留供检查。'
}
