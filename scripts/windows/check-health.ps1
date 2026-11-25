param(
    [string]$BaseUrl = ""
)

$ErrorActionPreference = "Stop"
if ($BaseUrl) {
    if (-not [uri]::IsWellFormedUriString($BaseUrl, [UriKind]::Absolute) -or ([uri]$BaseUrl).Scheme -ne "https") {
        throw "BaseUrl must be an absolute HTTPS URL."
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')
    $live = Invoke-RestMethod -Uri "$BaseUrl/health/live" -TimeoutSec 5 -MaximumRedirection 0
    $ready = Invoke-RestMethod -Uri "$BaseUrl/health/ready" -TimeoutSec 5 -MaximumRedirection 0
} else {
    . (Join-Path $PSScriptRoot "_common.ps1")
    $live = Get-MvInternalHealth -Endpoint live
    $ready = Get-MvInternalHealth -Endpoint ready
}

[pscustomobject]@{
    LiveOk          = $live.ok
    ReadyOk         = $ready.ok
    DbIntegrity     = $ready.dbIntegrity
    SynchronousMode = $ready.synchronousMode
    SqliteVersion   = $ready.sqliteVersion
    UptimeSeconds   = $ready.uptimeSeconds
} | Format-List
