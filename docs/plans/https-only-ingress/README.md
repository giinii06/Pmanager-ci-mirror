# HTTPS-only production ingress

Gate version: 2.2. Base: `55ae609e871c006165f7ebe2f201c2c0607c10af`.

User outcome: no browser-facing plaintext HTTP, including Windows legacy port forwarding. HTTPS on 443 only; keep private Docker HTTP for upstream/health. Development-only Bun HTTP is out of scope. Do not merge or deploy automatically.

Phase 1: [Enforce HTTPS](01-ingress.md). Acceptance: no host publication of nginx or HTTP; Windows no longer forwards 8080 and removes its old firewall rule; TLS port forwarded; health probes stay in Docker; secure production cookies; config/docs agree. Validate browser login, image, video range, HTTP connection failures and certificate trust on real Windows/WSL host before marking complete.
