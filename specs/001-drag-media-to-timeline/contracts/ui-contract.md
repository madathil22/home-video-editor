# UI & Store Contract: Drag Media to Timeline

The app has no external API. The contract covers the user-facing interaction and the internal store interface.

## Interaction contract

| Step | Behavior |
|------|----------|
| Press on a media card and move more than 6 px | A drag ghost (thumbnail, plus a count badge if more than 1) follows the pointer. |
| Pointer over the timeline track | A vertical insertion marker is shown at the target slot. |
| Release over the timeline track | Dragged media is inserted at that slot as one undoable action. |
| Release elsewhere, or Esc | No change. |
| Click / double-click on a card | Unchanged (double-click appends). |
| Ctrl/Cmd-click, Shift-click on cards | Toggles / range-selects media. |
| "Add all N to timeline" | Unchanged. |
| OS file drop | Unchanged (handled by the webview drag-drop listener). |

## Store interface (`src/state/projectStore.ts`)

```ts
addToTimeline(mediaIds: string[], atIndex?: number): void; // atIndex omitted => append
selectedMediaIds: string[];
selectMedia(id: string, mode: "single" | "toggle" | "range"): void;
clearMediaSelection(): void;
mediaDrag: { mediaIds: string[]; x: number; y: number } | null;
beginMediaDrag(mediaIds: string[], x: number, y: number): void;
updateMediaDrag(x: number, y: number): void;
endMediaDrag(): void;
```

## Pure helper (`src/lib/timelineSlots.ts`)

```ts
slotIndexAtTime(clips: { start: number; end: number }[], time: number): number; // 0..clips.length
```

## Invariants

- `atIndex` is clamped to `0..timeline.length`.
- Unknown media ids are skipped, as today.
- Exactly one `commit` per drop (one undo step).
