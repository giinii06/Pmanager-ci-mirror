# PR 13 Observability — synthesized design (v25)

Goal: an operator can diagnose a failure from the API/UI, and one incident produces one notification rather than one every 15 seconds. The design reuses the existing health, queue, backup and recovery data instead of adding a second monitoring stack.

## Data shapes

Five additive tables and one column. No existing column changes meaning.

```sql
notifications (
  id TEXT PK, kind TEXT, severity TEXT, state TEXT, dedupe_key TEXT,
  title TEXT, body TEXT, metadata_json TEXT, occurrences INTEGER,
  read_at INTEGER, first_seen_at INTEGER, last_seen_at INTEGER,
  last_notified_at INTEGER, resolved_at INTEGER, created_at INTEGER, updated_at INTEGER
)
-- unique open/dismissed dedupe key; resolved rows allow a new incident later
CREATE UNIQUE INDEX ux_notifications_active_dedupe
  ON notifications(dedupe_key) WHERE state IN ('open','dismissed');

notification_delivery_attempts (
  id TEXT PK, notification_id TEXT FK, channel TEXT ('discord'),
  message_kind TEXT ('alert','recovery'), status TEXT ('pending','sent','failed'),
  attempts INTEGER, next_attempt_at INTEGER, last_error TEXT,
  created_at INTEGER, updated_at INTEGER
)

diagnostics_runs (id TEXT PK, user_id TEXT FK, format TEXT ('json','md'),
  size_bytes INTEGER, created_at INTEGER)

worker_heartbeats (instance_id TEXT PK, worker_id TEXT, component TEXT,
  pid INTEGER, state TEXT ('idle','running','stopping'), current_job_id INTEGER,
  started_at INTEGER, last_seen_at INTEGER)

cache_cleanup_runs (id TEXT PK, user_id TEXT FK, types_json TEXT,
  candidate_bytes INTEGER, deleted_bytes INTEGER, deleted_files INTEGER,
  created_at INTEGER)

ALTER TABLE jobs ADD COLUMN request_id TEXT;
```

Why system-wide notifications (no `user_id`): the server has one operator. A shared inbox avoids duplicating rows and delivery attempts. `read_at` is still per row.

Why `diagnostics_runs` stores no report: the report is generated on demand and downloaded. The row is an audit trail (who, when, format, size), not a snapshot store.

Why `worker_heartbeats.instance_id`: in Docker the worker id is `worker-1` on every restart, so `worker_id` cannot distinguish runs. `instance_id` is a per-boot random id; restart-loop detection counts distinct ids in the last hour.

## Notification semantics

- `upsertNotification(finding, now, cooldownMs)` finds the row with the same `dedupe_key` in `open`/`dismissed`.
  - none: insert `open`, `last_notified_at = now`, deliver.
  - open: `occurrences + 1`, `last_seen_at = now`; deliver only when `now - last_notified_at >= cooldownMs`, then bump `last_notified_at`.
  - dismissed: update `last_seen_at`/`occurrences`, never deliver until the condition resolves.
- `resolveMissingNotifications(activeKeys, now)` resolves every open/dismissed row whose key is gone, and returns whether it had been delivered. A resolved row frees the unique index for a future incident.
- `read_at` drives the unread badge. `dismiss` sets `state='dismissed'`; a persisting condition does not create a new row.
- Discord delivery is a row in `notification_delivery_attempts` created only when `DISCORD_WEBHOOK_URL` is set. The worker retries at 1m, 5m, 15m, then `failed`. Recovery sends one `recovery` message if the alert had been delivered. The URL is never logged or returned.

## Alert checks (worker, every 30 s)

A registry of checks, each returning `AlertFinding[]` with `{kind, severity, dedupeKey, title, body, metadata, cooldownMs}`:

| kind | source | dedupe key | cooldown |
|---|---|---|---|
| drive_offline | `library_health` OFFLINE or missing root | `library:<id>:offline` | 15m |
| mass_missing | `library_health` UNVERIFIED / scan guard refusal | `library:<id>:mass_missing` | 6h |
| disk_low | `statfs` media/cache/data below 10% or 2 GiB | `disk:<volume>` | 1h |
| gpu_oom | 3+ GPU_OOM failures in 30m | `gpu:oom` | 1h |
| job_stalled | `workQueue().stalled` or lease expired 5m+ | `job:<kind>:stalled` | 15m |
| backup_missing | last successful backup > 48h or none | `backup:missing` | 6h |
| backup_failed | latest backup row has `error` | `backup:failed` | 1h |
| db_integrity | `quick_check(1) != ok` | `db:integrity` | 15m |
| restart_loop | 5+ worker instance ids in 1h | `worker:restart_loop` | 1h |
| mutation_failed | blocked mutation or retry budget exhausted | `mutation:<id>:failed` | 1h |

The evaluator is a separate loop beside the job loop, with its own abort signal. It writes only notifications; it never deletes files.

## Diagnostics

`GET /api/system/diagnostics?format=json|md&download=1`, authenticated, redacted. Sections:

- app: version, startedAt, uptime, pid, Bun version.
- database: schema version, integrity (60s cache), sqlite version, synchronous mode, journal mode, DB/WAL bytes, page/freelist counts, busy timeout.
- libraries: the existing `LibraryHealthDTO`.
- workers: heartbeats, active job leases, GPU lease holder/expiry, recent failures.
- queues: job counts, per-pipeline counts, stalled, remaining.
- backups: latest, last success age, count, total bytes, external copy `unknown`.
- storage: per-volume total/free/ratio with `stale=true` on failure; categories for library, thumbs, previews, hls, scenes, scene checkpoints, backups, exports, logs, quarantine, models.
- caches: per-type bytes/files/oldest/newest/regenerable/protected.
- notifications: open, unread, last 24h.
- flags: file mutation, HLS generations, bulk, notifications, search FTS.

Absolute roots are replaced with `<media>`, `<cache>`, `<data>`, `<ai>`. The Markdown renderer is deterministic and uses tables.

`GET /api/system/capabilities` returns the flags the web needs to hide disabled surfaces.

## Request IDs and metrics

- Fastify `genReqId: () => newId(16)`, no inbound header trust. `X-Request-Id` on every response.
- An `onSend` hook injects `requestId` into every JSON error body and `diagnosticId` (8 chars) into 5xx bodies. The 5xx log line carries both. `ApiError` parses both; the client appends the diagnostic id to the toast message.
- API pino gets redaction paths for cookie, authorization and set-cookie. The archive warning that prints a full source path is reduced to a relative path.
- In-memory `RequestMetrics` records `method + route pattern`, status class and duration per request, capped at 512 samples per route. `GET /api/system/metrics` returns p50/p95/max, 4xx/5xx counts, DB WAL/page stats and queue counts. No Prometheus service.
- `jobs.request_id` is set by API enqueue sites; the worker logs it on failure and diagnostics shows it for recent failures.

## Cache policy

Inventory types: thumbs, previews, hls, scenes, scene checkpoints, temp, exports. Protected and never deleted: originals, DB, quarantine, models, current-version thumbs/previews, active HLS generation, backups.

- Cleanup candidates: stale temp, orphaned thumbs/previews version directories (asset missing/deleted or `file_version` mismatch), scene thumbnails for missing assets, export CSVs older than the cutoff.
- HLS old generations are handled by the existing worker GC. The GC candidate query is fixed to treat a `ready` generation with no `hls_active` row and 1h idle as eligible even when `eligible_for_gc_at` is null.
- Preview returns `{generation, cutoff, types, files, bytes, protectedBytes, restoreCost}`; clean takes the generation and refuses `409 cache_preview_changed` when the candidate set moved.
- `cache_cleanup_runs` records every execution.
- Disk guard: worker reads `statfs` every 30s; below policy it excludes `thumbnail`/`preview`/`hls` (cache volume) or `process_archive` (media volume) from `claimNextJob`, so the jobs stay queued instead of failing.
- Backup failures back off 15 minutes instead of retrying every 60 seconds.

## Web

- Extract `Section`/`MetricPill` from `SettingsPage` into `components/ui/Section.tsx`; use them in the new pages.
- `/diagnostics` page: 30s poll, sections above, JSON/MD download anchors, explicit error state.
- `/notifications` page: filter open/resolved/dismissed, mark read, dismiss, 30s poll. `Topbar` bell with unread badge links to it; hidden when the capabilities flag is off.
- Settings storage section gains a per-type cache table and a `정리 미리보기` dialog modeled on `BulkActionDialog` (generation, blocking codes, refetch on `cache_preview_changed`).

## Flags and config

- `NOTIFICATIONS_ENABLED` default `0` in api and worker (spec I-05). The inbox, bell and evaluator are dark until enabled; diagnostics and cache cleanup are always on.
- `DISCORD_WEBHOOK_URL` worker-only secret.
- `MIN_FREE_BYTES` default 2 GiB, `MIN_FREE_RATIO` default 0.1, `ALERT_INTERVAL_MS` default 30000.
- Compose and `.env.example` updated; no new service.

## Tests

- DB: notifications (dedupe, cooldown, dismiss, resolve, reopen, unread, delivery retry), worker heartbeats (upsert, list, prune, restart count), v25 migration, cache cleanup runs.
- API: request id header, error body injection, diagnostics JSON/MD and redaction, diagnostics_runs, capabilities, notifications routes with the flag on/off, cache inventory/preview/clean safety and generation mismatch, metrics snapshot.
- Worker: each alert check, dedupe/cooldown/recovery, delivery retry with a fake fetch, disk policy and claim exclusion, HLS old-generation GC.
- Web: typecheck and build; browser check on the host later.

## Rejected alternatives

- **Sample-centric time series.** A periodic `ops_samples` table gives trends, but adds write volume, retention and a second aggregation model for a single-PC server whose existing tables already hold the history. Rejected in favor of incident rows plus live queries.
- **API-only evaluation on status polls.** Simpler, but alerts would only fire while a browser polls, and Discord delivery would depend on a request. Rejected because H-03 requires alerts without a viewer.
- **Prometheus/OTel + Grafana.** A new service and cardinality policy for a single host. The JSON metrics endpoint and diagnostics report cover the stated need; an exporter can be added later without changing the data model.
