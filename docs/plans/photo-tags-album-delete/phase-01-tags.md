# Phase 01 — Independent photo tag namespace

**State:** implementation_committed; verification_blocked (tests authored but not executed). **Mode:** application foundation consumed by Phase 02.
- Add schema V28 photo tag tables with per-image attachment relationships and appropriate foreign keys/indexes; maintain existing video tables.
- Extend DB/API tag functions with explicit kind separation and default video compatibility. Distinct photo and video tags with the same human-readable name must coexist.
- Image `AssetDTO.tags` hydration and image `tagId` filtering reference photo tags only; video behavior stays unchanged.
- Test: same-name photo/video tags, create/rename/delete, attach/detach and wrong-kind ID rejection, list/filter isolation, migration from V27.
- Failure: kind mismatch must reject without applying another media type's tag. No deployed original bytes are modified.
- Verify: configured `bun test`, `tsc`/build commands from root package manifest; GitHub Actions jobs confirmed at matching SHA.
