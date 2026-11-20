import {
  deleteSearchIndexBuilds,
  disarmSearchFts,
  getActiveSearchIndexBuild,
  lastSearchFtsQueryFailure,
  listSearchIndexBuilds,
  listSearchIndexGcCandidates,
  rebuildSearchIndex,
  SEARCH_BUILD_RETENTION_MS,
  searchFtsArmed,
  searchFtsIntact,
  searchFtsMode,
  searchFtsReady,
  searchIndexCounts,
  type SearchFtsMode,
  type SearchIndexBuildRecord,
  type SearchIndexCounts,
} from '@mediavault/database'
import type {
  SearchIndexBuildDTO,
  SearchIndexGcPreviewDTO,
  SearchIndexStatusDTO,
} from '@mediavault/shared'
import type { AppContext } from './context'

/** How many builds the panel and the diagnostics report show. */
const RECENT_BUILDS = 20

export interface SearchIndexStatus {
  kind: 'fts'
  active: SearchIndexBuildRecord | null
  mode: SearchFtsMode | null
  processReady: boolean
  triggersArmed: boolean
  intact: boolean
  fallback: 'fts' | 'like-fallback' | 'unavailable'
  live: SearchIndexCounts | null
  rowsSinceBuild: { assets: number; segments: number } | null
  lastQueryFailure: { at: number; message: string } | null
  recent: SearchIndexBuildRecord[]
}

/**
 * One deferred read over the pointer, the live trigger probe and the document
 * counts, so the three cannot disagree. It never runs `integrity-check`: that
 * is an INSERT which takes a write lock, and the page polls this every 30 s.
 * `verifiedAt` on the active row is the verify evidence.
 */
export function readSearchIndexStatus(ctx: AppContext): SearchIndexStatus {
  const snapshot = ctx.db.transaction(() => {
    const active = getActiveSearchIndexBuild(ctx.db, 'fts')
    const triggersArmed = searchFtsArmed(ctx.db)
    const intact = searchFtsIntact(ctx.db)
    const live = intact ? searchIndexCounts(ctx.db) : null
    const recent = listSearchIndexBuilds(ctx.db, 'fts', RECENT_BUILDS)
    return { active, triggersArmed, intact, live, recent }
  })()

  const processReady = searchFtsReady(ctx.db)
  const fallback = !snapshot.intact
    ? 'unavailable'
    : processReady && snapshot.triggersArmed && snapshot.active !== null
      ? 'fts'
      : 'like-fallback'

  return {
    kind: 'fts',
    active: snapshot.active,
    mode: searchFtsMode(ctx.db),
    processReady,
    triggersArmed: snapshot.triggersArmed,
    intact: snapshot.intact,
    fallback,
    live: snapshot.live,
    rowsSinceBuild:
      snapshot.active !== null && snapshot.live !== null
        ? {
            assets: Math.max(0, snapshot.live.assetWatermark - snapshot.active.counts.assetWatermark),
            segments: Math.max(
              0,
              snapshot.live.segmentWatermark - snapshot.active.counts.segmentWatermark,
            ),
          }
        : null,
    lastQueryFailure: lastSearchFtsQueryFailure(),
    recent: snapshot.recent,
  }
}

export class RebuildInFlightError extends Error {
  constructor() {
    super('a search index rebuild is already running')
    this.name = 'RebuildInFlightError'
  }
}

/**
 * Module-level because the work runs on the API process's own handle: a second
 * rebuild would block the same event loop the first one is blocking.
 */
let rebuildInFlight = false

/**
 * Rebuild in the API process on purpose. Readiness is a per-process proof, and
 * a rebuild anywhere else would produce a correct index this process still
 * refuses to use until it restarts.
 */
export function rebuildSearchIndexNow(ctx: AppContext): SearchIndexBuildRecord {
  if (rebuildInFlight) throw new RebuildInFlightError()
  rebuildInFlight = true
  try {
    return rebuildSearchIndex(ctx.db)
  } catch (error) {
    // A transient failure leaves a usable index behind; only a structural break
    // costs the fast path until the next boot repairs it.
    if (!searchFtsIntact(ctx.db)) disarmSearchFts(ctx.db)
    throw error
  } finally {
    rebuildInFlight = false
  }
}

export function gcPreview(ctx: AppContext, now: number): SearchIndexGcPreviewDTO {
  const builds = listSearchIndexGcCandidates(ctx.db, now, SEARCH_BUILD_RETENTION_MS)
  return { builds: builds.map(toSearchIndexBuildDTO), total: builds.length }
}

export function gcSearchIndexBuilds(ctx: AppContext, now: number): number {
  return deleteSearchIndexBuilds(ctx.db, now, SEARCH_BUILD_RETENTION_MS)
}

export function toSearchIndexBuildDTO(build: SearchIndexBuildRecord): SearchIndexBuildDTO {
  return {
    id: build.id,
    kind: build.kind,
    state: build.state,
    source: build.source,
    assets: build.counts.assets,
    segments: build.counts.segments,
    assetWatermark: build.counts.assetWatermark,
    segmentWatermark: build.counts.segmentWatermark,
    modelSha256: build.identity.modelSha256,
    pipelineVersion: build.identity.pipelineVersion,
    dimensions: build.identity.dimensions,
    startedAt: new Date(build.startedAt).toISOString(),
    finishedAt: build.finishedAt === null ? null : new Date(build.finishedAt).toISOString(),
    verifiedAt: build.verifiedAt === null ? null : new Date(build.verifiedAt).toISOString(),
    supersededAt: build.supersededAt === null ? null : new Date(build.supersededAt).toISOString(),
    lastError: build.lastError,
  }
}

export function toSearchIndexStatusDTO(status: SearchIndexStatus): SearchIndexStatusDTO {
  return {
    kind: status.kind,
    active: status.active === null ? null : toSearchIndexBuildDTO(status.active),
    mode: status.mode,
    processReady: status.processReady,
    triggersArmed: status.triggersArmed,
    intact: status.intact,
    fallback: status.fallback,
    live: status.live,
    rowsSinceBuild: status.rowsSinceBuild,
    lastQueryFailure:
      status.lastQueryFailure === null
        ? null
        : {
            at: new Date(status.lastQueryFailure.at).toISOString(),
            message: status.lastQueryFailure.message,
          },
    recent: status.recent.map(toSearchIndexBuildDTO),
  }
}
