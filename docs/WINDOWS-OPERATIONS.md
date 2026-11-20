# Windows 11 무인 자동 부팅 및 상시 운영 매뉴얼

이 문서는 Windows 11 호스트(`192.168.0.27`)에서 로그인 없이 MediaVault 전체 스택을 자동 시작·감시·복구하는 구성을 안내합니다.

## 1. 호스트 인프라 구조

- WSL `Ubuntu-24.04` 내부에 `systemd=true` 및 **네이티브 Linux `docker.service`**가 활성화되어 있습니다 (Docker Desktop 미사용).
- 단일 소유 감독 스크립트 `scripts/windows/service-runner.ps1`가 다음 순서로 부팅 및 상시 감시를 수행합니다.
  1. 전역 뮤텍스(`Global\MediaVaultSupervisor`)로 중복 실행 방지.
  2. `wsl.exe`로 `docker` 및 `ssh` systemd 서비스 기동과 Docker 데몬 응답(`docker info`)을 확인.
  3. Windows에서 실제 존재하는 `C`/`D`/`E` 드라이브만 선별해 WSL `/mnt/{c,d,e}` DrvFS 마운트를 최대 90초 대기합니다. 준비되지 않으면 오류를 기록하고 그대로 진행하며, 기동 여부는 이후 단계의 preflight 검사가 결정합니다.
  4. `LAN IPv4` 검증 후 `netsh interface portproxy` (`8080 -> 127.0.0.1:8080`, `22 -> 127.0.0.1:2222`) 등록 및 주기적 갱신.
  5. 전체 `.env*` 및 `compose*.yaml` 플래그로 `docker compose up -d --remove-orphans` 실행 (`Invoke-WslBash`는 PowerShell 5.1 `NativeCommandError` 억제를 위해 호출 범위 내 `$ErrorActionPreference = "Continue"` 적용).
  6. 15초마다 `http://127.0.0.1:8080/health/ready`를 검사하며 연속 3회 실패 시 `api`와 `nginx`를 재시작합니다. 이후 대기 시간은 실패 횟수에 15초를 곱해 최대 120초까지 늘어납니다.
  7. 로그는 `C:\ProgramData\MediaVault\logs\supervisor.log`에 10 MB 단위로 순환 저장하며, 현재 파일과 `.1`~`.5` 백업까지 최대 6개를 유지합니다.

## 2. 최초 설치 (관리자 PowerShell 필요 · UAC)

보안 정책상 Windows 작업 스케줄러 등록 및 전원 설정 변경은 호스트에서 관리자 권한 PowerShell을 한 번 직접 실행해야 합니다.

```powershell
cd \\wsl.localhost\Ubuntu-24.04\home\giini\Pmanager
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 -OwnerUser giini
```

- 기본값은 비밀번호 저장 없는 `S4U` 로그온입니다.
- 만약 특정 Windows 11 빌드에서 DrvFS(`D:\`, `E:\`) 접근에 전체 사용자 토큰이 필요한 경우 `-UsePasswordLogon` 옵션을 사용하면 Windows 자격 증명 대화상자를 통해 비밀번호를 안전하게 등록합니다 (스크립트나 저장소에는 비밀번호가 저장되지 않습니다).
- Windows 자체 OpenSSH Server도 함께 활성화하려면 `-EnableWindowsOpenSSH`를 추가합니다.
- 이 스크립트는 실행 파일들을 로컬 NTFS 경로(`C:\ProgramData\MediaVault\bin\`)로 스테이징해 `S4U` 컨텍스트의 `\\wsl.localhost` UNC 제한을 피하고, 네이티브 Win32 바이너리(`C:\Program Files\WSL\wsl.exe`) 호출, `.wslconfig` `vmIdleTimeout=-1` 설정, `/bin/sleep infinity` 유휴 방지, 설치 직후 `State = Running` 자가 검증, AC 전원 절전/최대절전 비활성화, 기존 중복 부팅 작업 비활성화를 함께 수행합니다.

## 3. ASRock B650M PG Lightning UEFI 정전 자동 복구 설정

정전 후 전원이 다시 들어왔을 때 컴퓨터가 자동으로 부팅되도록 UEFI에서 설정해야 합니다.

1. 재부팅 시 `Del` 또는 `F2` 키로 BIOS 진입.
2. `Advanced` -> `ACPI Configuration` 메뉴 이동.
3. **`Restore on AC/Power Loss`** 항목을 **`Power On`**으로 변경 (`Power Off` 또는 `Last State` 대신 `Power On` 권장).
4. `F10`으로 저장 후 재부팅.

## 4. 운영 스크립트 목록 (`scripts/windows/`)

| 스크립트 | 용도 |
| --- | --- |
| `install-service.ps1` | 부팅 시 무인 실행 예약 작업 등록 및 AC 전원 설정 (관리자 필요) |
| `uninstall-service.ps1` | 예약 작업 제거 및 중지 (관리자 필요) |
| `service-runner.ps1` | WSL·드라이브·Compose 기동 및 15초 헬스 감시 데몬 |
| `start-server.ps1` | `stop.flag` 제거 후 서버 및 감독 태스크 시작 |
| `stop-server.ps1` | 감독 중지 플래그 생성, 감독 태스크가 `Ready`가 될 때까지 최대 30초 대기(실패 시 중단), Compose 컨테이너 정지 |
| `restart-server.ps1` | 서버 정상 재시작 |
| `status-server.ps1` | 예약 작업, `docker compose ps`, `/health/ready` 상태 일괄 확인 |
| `view-logs.ps1` | 감독 로그 (`-Source supervisor`) 또는 컨테이너 로그 (`-Source docker -Follow`) 조회 |
| `check-health.ps1` | `/health/live`와 `/health/ready`만 호출해 `dbIntegrity`, `synchronousMode`, `sqliteVersion`, `uptimeSeconds` 출력 (`dbIntegrity`는 기본 `"skipped"`이고, `/api/system/status` 같은 다른 경로가 60초 TTL 캐시를 채운 뒤에는 그 값이 반영됨) |
| `backup-db.ps1` | 컨테이너 내 `VACUUM INTO` + `PRAGMA integrity_check = ok` 검증 + 실패 시 임시 파일 정리 트랩 후 호스트로 백업 복사 |

`scripts/windows/*.ps1`를 수정한 뒤에는 관리자 PowerShell에서 `install-service.ps1`을 다시 실행해야 합니다. 예약 작업은 저장소의 파일이 아니라 스테이징된 복사본(`C:\ProgramData\MediaVault\bin\`)을 실행하므로, 재설치하지 않으면 변경 사항이 반영되지 않습니다.
