# 06-https

## Outcome
TLS termination with persistent certificate state, reverse proxy, secure cookies, origin/proxy correctness, HTTPS redirect and deployment instructions.

## Observable acceptance
공인 도메인 및 LAN-only 인증서 수명주기 구분. 실제 서버 DNS/방화벽/인증서 trust 검증 없이는 배포 완료 표시 금지.

## Verification
- RED behavior test where executable, implementation, typecheck/build/unit tests, provider-matched SHA, requirements and security review.
- No missing evidence can count as a passed gate.

## Status
Not started. No implementation or passing tests claimed.
