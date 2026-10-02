# Data Model: Drag Media to Timeline

No change to the persisted `Project`, `MediaItem` or `Clip` types (`src/types/project.ts`). This feature adds transient UI state only.

## Existing entities (unchanged)

- **MediaItem**: id, path, fileName, duration, and so on. It stays in the bin after placement (FR-009).
- **Clip**: id, mediaId, inPoint, outPoint, muted. Each drop creates a new clip with a fresh UUID, `inPoint = 0` and `outPoint = media.duration`.

## New transient state (zustand `useEditor`, not saved, not in undo history)

| Field | Type | Description |
|-------|------|-------------|
| `selectedMediaIds` | `string[]` | Media bin selection, kept in bin order at drag time. |
| `mediaDrag` | `{ mediaIds: string[]; x: number; y: number } \| null` | Active drag from the bin. `null` when idle. |

## Transient state rules

- `beginMediaDrag(ids)` only starts after the 6 px movement threshold.
- Media with a failed proxy (`proxyStatus === "error"`) is excluded from `mediaIds`. If none remain, the drag does not start (edge case).
- `removeMedia(id)` also removes `id` from `selectedMediaIds`.
- `loadProject` clears `selectedMediaIds` and `mediaDrag`.

## State transitions

```text
idle --(mousedown + move > 6px)--> dragging --(mouseup over track)--> commit insert --> idle
                                        |--(mouseup elsewhere / Esc)--> idle (no change)
```

## Derived values

- **Insertion index** `0..N`, from the pointer's x position on the timeline and the resolved clip layout.
