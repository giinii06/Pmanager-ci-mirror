# 06-https

## Outcome
TLS termination with persistent certificate state, reverse proxy, secure cookies, origin/proxy correctness, HTTPS redirect and deployment instructions.

## Observable acceptance
공인 도메인 및 LAN-only 인증서 수명주기 구분. 실제 서버 DNS/방화벽/인증서 trust 검증 없이는 배포 완료 표시 금지.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Code attempted and committed at `63780f3ea04b89f4d6552ec53d554efb1b7538c2`; **blocked/unverified**. Caddy TLS proxy, Docker Compose port bindings and secure-cookie default added; actual DNS, certificates, CA trust and on-host user flow NOT verified.

No local unit/typecheck/build/visual E2E runs; GitLab dispatch is not provider job success. See `review.md` for actual provider statuses and risks.
