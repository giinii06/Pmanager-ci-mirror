# Design: one job for global search

## Before

Topbar `/search?q` -> SearchPage -> `/api/search/semantic` -> scene vector encoder + transcript search + filename search -> RRF ranking -> scene/dialogue/asset cards. The search page owns a distinct result format and fetches an asset for each click.

## After

Topbar `/search?q` -> SearchPage -> existing AssetGallery `filters={{ q, sort: 'latest' }}` -> `GET /api/assets?q=...` -> existing SQL `a.filename LIKE ? ESCAPE '\\'` -> pageable photo/video thumbnails -> existing viewer.

We explicitly prefer **reuse of the existing paginated asset listing** over a new search endpoint or client-side filtering. Search is an ordinary filename substring match, case-insensitive for ASCII under SQLite's standard LIKE behavior. Existing LIKE escaping treats `%`, `_`, and backslash literally. Korean and one-character searches are supported.

## UI/UX

- Search remains in Topbar, with filename-only placeholder and accessible label.
- Debounced search accepts one-character input (the pre-existing two-character minimum disappears). Enter submits immediately, Escape clears, Cmd/Ctrl+K focuses.
- Empty query: instructional placeholder (not an unfiltered full library). Nonempty query: virtualized responsive image/video grid with count and filename metadata inherited from AssetGallery/AssetTile.
- Empty results, network failure, loading, infinite scrolling and viewer are inherited from the shared gallery.
- URL `/search?q=...` remains shareable.

## API and data

Global `/api/search/semantic` is retired with its client contract, RRF score and mixed-source DTO. `GET /api/assets?q` and shared `AssetQuery` remain unchanged. Media processing and scene/transcript data remain available in their dedicated features; the database schema is not destroyed or migrated. Existing FTS maintenance is deliberately untouched to avoid destructive changes in an unrelated storage/diagnostics subsystem.

## Acceptance and negatives

1. Searching a filename fragment (including one Korean character) returns the corresponding photo/video thumbnails and correct total count, not transcript/scene content.
2. `%`, `_`, and `\\` are literal filename characters; query is safely parameterized.
3. Deleted assets do not surface. Empty and no-match searches are handled without leaking all files.
4. Results paginate, preserve query during viewer neighbor navigation, and support browser URL.
5. Old global semantic endpoint is not available; per-video transcripts/scenes still work.
6. No changes to index-data retention, AI workers, CI provider, protected main branch or deployment.

## Alternatives considered

- Keep semantic endpoint but hide it: least code churn, but retains unnecessary global search surface and risk of accidental coupling.
- New filename-search API: adds redundant pagination/query logic.
- **Selected:** reuse `/api/assets`, delete only obsolete global search composition, retain independent media features.
