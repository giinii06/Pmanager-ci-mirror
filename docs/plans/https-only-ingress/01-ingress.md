# Phase 1 — HTTPS-only ingress

State history (gate_version=2.2): not_started → in_progress. No verified SHA yet.

RED source trace: compose publishes Caddy 80 and nginx loopback 8080; Windows supervisor forwards 8080 to LAN; installer permits 8080. Actual runtime reproduction not available. Add regression assertions for production Compose, TLS config, supervisor and firewall. Preserve SSH and data volumes. Use internal API health probe, not disabled certificate verification. ACME requires reachable 443 for TLS-ALPN challenge or appropriate certificate setup; LAN clients must trust local CA. Review and CI evidence pending.
