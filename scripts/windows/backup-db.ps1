[CmdletBinding()]
param(
    [string]$HostBackupDir = "/home/giini/Pmanager-backups/manual"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_common.ps1")

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$cmd = @"
set -euo pipefail
cleanup() { docker exec mediavault-api-1 rm -f /tmp/mv-manual.db >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir -p "$HostBackupDir"
docker exec mediavault-api-1 rm -f /tmp/mv-manual.db
docker exec mediavault-api-1 bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/data/mediavault.db", { readonly: true });
db.exec("VACUUM INTO \x27/tmp/mv-manual.db\x27");
const chk = new Database("/tmp/mv-manual.db", { readonly: true }).query("PRAGMA integrity_check").get();
console.log(JSON.stringify(chk));
if (chk?.integrity_check !== "ok") process.exit(2);
'
docker cp mediavault-api-1:/tmp/mv-manual.db "$HostBackupDir/mediavault-$stamp.db"
ls -lh "$HostBackupDir/mediavault-$stamp.db"
"@

$res = Invoke-WslBash -Command $cmd
Write-Host $res.Output
if ($res.ExitCode -ne 0) {
    throw "Database backup failed."
}
