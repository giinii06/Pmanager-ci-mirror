param(
    [int]$Tail = 60,
    [switch]$Follow,
    [ValidateSet("supervisor", "docker")][string]$Source = "supervisor"
)

. (Join-Path $PSScriptRoot "_common.ps1")

if ($Source -eq "docker") {
    $followFlag = if ($Follow) { "-f" } else { "" }
    $cmd = "cd $($script:RepoDir) && docker compose $($script:ComposeArgs) logs --tail=$Tail $followFlag api worker nginx"
    & wsl.exe -d $script:WslDistro -u $script:WslUser -- bash -lc $cmd
    exit $LASTEXITCODE
}

if (-not (Test-Path $script:LogFile)) {
    Write-Host "No supervisor log at $($script:LogFile)" -ForegroundColor Yellow
    exit 0
}
Get-Content -Path $script:LogFile -Tail $Tail -Wait:$Follow
