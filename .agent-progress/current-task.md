# Current Task

- **Active Phase / Wave:** Wave 4 Complete -> Starting Wave 5 (Win11 Boot Supervision Scripts, macOS `ssh media-server`, Live Host Deploy & Verification)
- **Repository Root:** `/Users/xo/cod/Pmanager` (`branch: main`, Wave 3 at `7dbef44`, committing Wave 4 now)
- **Live Win11 Host:** `giini@192.168.0.27` (`~/Pmanager`, WSL `3.0.5.0` `Ubuntu-24.04`, native `docker.service`, ASRock `B650M PG Lightning`)
- **Active Migration:** Schema `v14`, Wave 3 backend, and Wave 4 frontend tested and built locally; ready for Wave 5 deployment to Win11 host (pre-v14 backup preserved in `~/Pmanager-backups/pre-v14-*`)
- **Next Action:** Author `scripts/windows/*.ps1`, set up passwordless SSH (`ssh media-server` + WSL2 `ssh.service`), ship commits to `192.168.0.27`, rebuild & restart containers (`api`, `worker`, `web`, `asr-worker`, `nginx`), verify live Schema v14, Host Drive Explorer, Vote Orange Weeds, DrvFS benchmark, and `docker kill mediavault-worker-1` crash recovery.
