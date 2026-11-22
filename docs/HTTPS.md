# HTTPS setup for Pmanager

Pmanager's public entrypoint is Caddy on TCP 443 (HTTP 80 redirects to HTTPS) in `compose.yaml`. nginx continues to serve authenticated X-Accel media internally, and remains host-loopback-only on 8080 for troubleshooting. The Fastify session cookie is `Secure` by default; access the site over HTTPS rather than the old HTTP port.

## Publicly trusted domain
1. Point a DNS A/AAAA record to the host and allow inbound TCP 80 and 443 to Caddy. Configure router/NAT/firewall rules yourself.
2. Set `MEDIAVAULT_TLS_HOST=your-domain.example` in `.env`; leave `MEDIAVAULT_HTTPS_PORT=443` and `MEDIAVAULT_HTTP_PORT=80`. Set `PUBLIC_ORIGINS=https://your-domain.example` if you use explicit allowed origins.
3. Run `docker compose config` to check interpolation, then `docker compose up -d --build`. Check `docker compose logs caddy` and verify `https://your-domain.example/api/health`.
4. Verify login, Secure session cookie, browser back/forward, a thumbnail, video range playback and HTTP-to-HTTPS redirect. Don't claim a valid certificate without browser verification.

## LAN-only / localhost
- Set `MEDIAVAULT_TLS_HOST` to the exact IP or internal hostname. Caddy serves internal CA certificates; devices must trust its CA root before a browser will consider the connection secure. Use `localhost` only for access on the same machine.
- Retrieve Caddy's local root certificate through an authorized admin shell (`docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`) and install it in the client device's trust store; **never** distribute the CA private key. On some devices local IP certificates may require additional trust configuration.
- For a trusted domain, use a real DNS name and ACME instead. Self-signed certificate issuance alone is not equivalent to browser-trusted HTTPS.

## Security and rollback
- Only Caddy ports 80/443 are meant for clients; do not expose API, worker, nginx 8080, or `/internal/` to the internet.
- Do not disable certificate validation or downgrade cookies to access the HTTP diagnostic port. To roll back, restore the previous Compose/config commit on a controlled host after reviewing login behavior and preserve all named data volumes.
- This commit adds configuration only. No live DNS/certificate/host deployment was performed.
