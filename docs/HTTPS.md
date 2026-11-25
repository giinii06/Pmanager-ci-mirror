# HTTPS-only setup for poda

Production Compose publishes only Caddy TCP 443. Port 80 is not published and there is no plaintext redirect; nginx 8080 is not published even on loopback. Caddy uses an explicit HTTPS site. Production API cookies are always Secure. Docker-internal HTTP and optional Mac native-worker loopback API are not internet ingress.

## Publicly trusted domain
1. Point DNS A/AAAA to the host and allow inbound TCP 443. ACME TLS-ALPN validation needs reachable TCP 443; a deployment requiring HTTP-01 must instead use a suitable certificate setup without exposing application HTTP. Do not forward port 80 or 8080.
2. Set MEDIAVAULT_TLS_HOST to the actual DNS hostname (no scheme or port), MEDIAVAULT_HTTPS_PORT=443, and update PUBLIC_ORIGINS to the exact HTTPS origin if configured.
3. Run docker compose config, then docker compose up -d --build. Inspect Caddy logs and verify https://your-domain.example/health/ready using a trusted certificate.
4. Test login, Secure cookie, image/thumbnail, video range playback, and confirm HTTP ports 80 and 8080 are unreachable from another device.

## LAN-only / localhost
Set MEDIAVAULT_TLS_HOST to the actual LAN IP or internal hostname. Caddy's local CA must be trusted on each browser device. Retrieve the public root certificate using an authorized admin shell:

    docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt

Never distribute the private CA key or skip certificate validation. For multiple access names, configure certificates for those names before switching clients.

## Existing Windows/WSL installs
The supervisor and firewall installer now use TCP 443; the old MediaVault 8080 firewall rule and old 8080-to-loopback forwarding are removed by the updated scripts. Set the TLS host and keep the Windows supervisor on the default HTTPS port 443. Re-run install-service.ps1 as administrator after updating the repository, because the supervisor runs a staged copy. Verify netsh interface portproxy show all and the firewall; remove any separately configured router forwarding for 80/8080. If access uses a Tailscale address, ensure the certificate matches that address or DNS name and verify connectivity separately.

Internal health checks run inside Docker; check-health.ps1 also accepts an explicit trusted HTTPS BaseUrl. Never publish the optional native Mac worker API loopback port 8788 or the local Bun dev server.

Rollback: preserve all named volumes, revert code only on a controlled host, and do not re-enable public plaintext HTTP. Live DNS, certificate trust, firewall and browser playback require verification on the actual host.
