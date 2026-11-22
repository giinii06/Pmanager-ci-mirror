# MediaVault workspace visual refresh

## Purpose

Give the poda web UI a unified, legible, slightly softer visual hierarchy without changing media rendering, server data, actions or the established four appearance presets.

## Design decisions

- **Product identity:** media-first private library. Photos and videos are the primary content, not decorative backgrounds. No blur, crop, filters or new compression are applied to thumbnails, images or video.
- **Existing color palettes:** `light`, `ash`, `dark`, `onyx` retain exactly the same canvas/panel/text/accent values and selector names. The appearance picker still edits the same `themeMode` persisted state.
- **Typography:** Pretendard Variable, minimum 14–15px for key content, 28–40px page headings, 13–14px buttons and inputs. Dates and supporting meta may be smaller.
- **Spacing:** a common `workspace-page` layout has responsive horizontal padding of 20–48px. Navigation and top search are larger and share the same geometry.
- **Surfaces:** panel radius 22px, gallery tile radius 14px, controls roughly 12–16px. Restrained shadows on panels only, not the media itself.
- **Media display:** keep `Thumb fit="contain"`, native `object-contain` and original viewer/player logic. Gallery gap increases from 3px to 8px. The video detail viewer stays dark to preserve viewing contrast.
- **Accessibility:** keyboard focus remains visible; row links and button actions remain native; small-screen menu still opens; reduced-motion preference disables decorative transitions.

## Reusable primitives

`Button`, `Input`, `Dialog`, `Section`, `MetricPill`, `PageHeading`, `EmptyState`, `Sidebar`, `Topbar` and feedback toasts establish the new system. `workspace-page` provides a shared page width gutter; `workspace-tab` is available for filter selectors.

## Impacted screens

- Photo folders and image gallery: larger heading and sorting, roomier cards/gutters, preserved original image fitting.
- Videos and tags: same controls and filter geometry, preserved thumbnails, playback and sharing behavior.
- Journal: existing Notion-style table, larger rows, actions and editing typography. Server timestamps and autosave are unchanged.
- Search, duplicates and notifications: larger result rows and previews, surfaces, readable labels and actions.
- Settings, diagnostics and processing: typography, card shape, spacing and theme selector previews.
- Login and setup: more comfortable card width and form controls.
- Fullscreen photo/video viewer: only the surrounding control surfaces; media rendering is unchanged.

## Verification checklist

1. `bun run typecheck`, `bun test`, `bun run --cwd apps/web build` on the exact commit.
2. Verify all four themes in Settings, including selected theme cards.
3. Inspect at ~375px mobile, tablet and 1280px desktop; open/close sidebar and navigate collapsed.
4. Photo: verify contain fitting (portrait/landscape), fullscreen controls, album card and image zoom.
5. Video: open MP4, subtitles, transcript and media navigation; check that no controls obscure playback.
6. Journal: create, edit, autosave, revisit, hover/open, keyboard focus and paging.
7. Search, duplicates, notifications and settings: inspect loading/error/empty/data views.

The CI validates code and selected DOM contracts; it does not substitute for manual screenshot review of an authenticated deployed instance.
