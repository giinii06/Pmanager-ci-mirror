# macOS 원격 SSH 및 배포 운영 가이드

macOS에서 비밀번호 입력 없이 `ssh media-server` 명령으로 Windows 11 WSL2 서버를 관리할 수 있습니다.

## 1. SSH 구성 현황

- **macOS 공개키**: `~/.ssh/id_ed25519.pub` -> 서버 `giini@192.168.0.27:~/.ssh/authorized_keys` 등록 완료 (`0600`).
- **macOS SSH 별칭 (`~/.ssh/config`)**:

```sshconfig
Host media-server
    HostName 192.168.0.27
    User giini
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

- **WSL2 SSH 서비스**: `sudo systemctl enable --now ssh` 활성화 완료 (Win11 `portproxy` `192.168.0.27:22 -> 127.0.0.1:2222` 경유).

## 2. 자주 쓰는 원격 명령

```bash
# 서버 접속 및 상태 확인
ssh media-server 'cd ~/Pmanager && docker compose ps'

# 헬스 및 DB 무결성 확인
curl -fsS http://192.168.0.27:8080/health/ready

# 컨테이너 실시간 로그 확인
ssh media-server 'cd ~/Pmanager && docker logs -f --tail=100 mediavault-worker-1'

# Win11 PowerShell 헬스 스크립트 원격 실행
ssh media-server '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/Pmanager/scripts/windows/check-health.ps1)"'
```

## 3. 코드 업데이트 배포 (`git bundle` 워크플로우)

Win11 서버에는 GitHub 인증 정보가 없으므로 macOS에서 번들을 생성해 Fast-forward 병합 후 필요한 서비스만 재빌드합니다.

```bash
# 1. 서버 현재 HEAD 확인
OLD_SHA=$(ssh media-server 'cd ~/Pmanager && git rev-parse HEAD')

# 2. 번들 생성 및 전송
git bundle create /tmp/mv-update.bundle ${OLD_SHA}..main
scp /tmp/mv-update.bundle media-server:/tmp/mv-update.bundle
rm -f /tmp/mv-update.bundle

# 3. 서버 Fast-forward 적용 및 빌드 재기동
ssh media-server 'cd ~/Pmanager && git fetch /tmp/mv-update.bundle main && git merge --ff-only FETCH_HEAD && rm -f /tmp/mv-update.bundle'
```

`web` 컨테이너를 재생성한 뒤에는 반드시 `nginx`를 재시작해 새 컨테이너 IP를 반영해야 합니다.
