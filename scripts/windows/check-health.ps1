param(
    [string]$BaseUrl = "http://127.0.0.1:8080"
)

$ErrorActionPreference = "Stop"
$live = Invoke-RestMethod -Uri "$BaseUrl/health/live" -TimeoutSec 5
$ready = Invoke-RestMethod -Uri "$BaseUrl/health/ready" -TimeoutSec 5

[pscustomobject]@{
    LiveOk          = $live.ok
    ReadyOk         = $ready.ok
    DbIntegrity     = $ready.dbIntegrity
    SynchronousMode = $ready.synchronousMode
    SqliteVersion   = $ready.sqliteVersion
    UptimeSeconds   = $ready.uptimeSeconds
} | Format-List
