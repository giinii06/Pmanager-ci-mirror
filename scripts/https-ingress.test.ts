import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "..", path), "utf8");

test("production publishes only HTTPS and forces Secure cookies", () => {
  const compose = read("compose.yaml");
  const published = [...compose.matchAll(/^    ports:\s*\n((?:      - .+\n)+)/gm)].map((match) => match[1]);
  expect(published).toEqual(['      - "${MEDIAVAULT_HTTPS_BIND:-0.0.0.0}:${MEDIAVAULT_HTTPS_PORT:-443}:443"\n']);
  expect(compose).toContain('COOKIE_SECURE: "1"');
  expect(read("deploy/caddy/Caddyfile")).toContain("https://{$MEDIAVAULT_TLS_HOST:localhost}");
  expect(read("deploy/caddy/Caddyfile")).toContain("auto_https disable_redirects");
});

test("Windows removes old HTTP forwarding and never recreates it", () => {
  const runner = read("scripts/windows/service-runner.ps1");
  expect(runner).toContain("portproxy delete v4tov4 listenport=8080");
  expect(runner).not.toContain("portproxy add v4tov4 listenport=8080");
  expect(runner).toContain("portproxy add v4tov4 listenport=443");
  expect(runner).toContain("Get-MvInternalHealth -Endpoint ready");
  const installer = read("scripts/windows/install-service.ps1");
  expect(installer).toContain('Get-NetFirewallRule -DisplayName "MediaVault Web 8080"');
  expect(installer).not.toContain('New-NetFirewallRule -DisplayName "MediaVault Web 8080"');
  expect(installer).toContain('New-NetFirewallRule -DisplayName "MediaVault HTTPS 443"');
  expect(read("scripts/windows/check-health.ps1")).toContain("BaseUrl must be an absolute HTTPS URL");
});
