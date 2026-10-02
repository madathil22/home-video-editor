# Research: Drag Media to Timeline

## 1. Drag mechanism

- **Decision**: Pointer-based drag (mousedown / mousemove / mouseup) with a floating drag ghost, not HTML5 drag-and-drop.
- **Rationale**: `src-tauri/tauri.conf.json` sets `dragDropEnabled: true`. On Windows (WebView2), the native OS drop handler then swallows HTML5 `dragstart`/`drop` events inside the page. `App.tsx` already relies on `onDragDropEvent` for importing files from the OS. The existing clip reorder in `Timeline.tsx` already uses window-level mouse listeners, so this is the established pattern.
- **Alternatives considered**:
  - HTML5 DnD: unreliable with `dragDropEnabled`.
  - Setting `dragDropEnabled: false`: breaks OS file import.
  - A DnD library (dnd-kit and similar): a new dependency for a single gesture.

## 2. Passing drag state between MediaBin and Timeline

- **Decision**: Add a transient `mediaDrag` slice to the zustand store (`{ mediaIds, x, y } | null`) with `beginMediaDrag`, `updateMediaDrag` and `endMediaDrag`. The Timeline reads it to render the insertion indicator.
- **Rationale**: The two components are siblings and the store is already the shared channel. The slice is not part of `Project`, so it is never saved and never creates undo steps.
- **Alternatives considered**: React context (a new provider for little gain); DOM custom events (untyped).

## 3. Drop position

- **Decision**: Extract the slot calculation already in `Timeline.tsx`'s `onUp` (the first clip whose midpoint is after the cursor) into a pure helper `slotIndexAtTime(clips, time)`. It returns an insertion index in `0..N`, where N means append. Reorder keeps its current "target slot" semantics.
- **Rationale**: Insertion needs the index `0..N`, while reorder needs `0..N-1`. A shared helper avoids duplicated math.
- **Alternatives considered**: Hit-testing DOM clip elements (slower and layout-coupled).

## 4. Store action

- **Decision**: Extend `addToTimeline(mediaIds, atIndex?)`. When `atIndex` is omitted it appends, so "Add all" and double-click are unchanged. One `commit` gives one undo step.
- **Rationale**: Reuses the clip-building logic and satisfies FR-007 and FR-008.
- **Note**: Transition overrides are keyed by the clip before a boundary (`afterClipId`). Inserting a clip between A and B leaves A's override attached to the new A→inserted boundary. This is acceptable: the override is tied to the clip it follows. Document it in tests.

## 5. Multi-select in the media bin

- **Decision**: Local `selectedMediaIds` state in the store (ctrl/shift-click). Dragging a selected item drags the whole selection in bin order. Dragging an unselected item drags only that item.
- **Rationale**: Nothing exists today. Keeping it in the store lets removal and the drag logic share it.
- **Alternatives considered**: Component-local state (lost on re-render of siblings); single-item drag only (drops P2).

## 6. Drag vs click and double-click

- **Decision**: Start the drag only after the pointer moves more than 6 px, which matches the existing reorder threshold. Below the threshold, the click and the double-click "add to timeline" shortcut behave as before.

## 7. Cancel

- **Decision**: Escape, or a release outside the timeline track area, calls `endMediaDrag` without committing.

## 8. Testing

- **Decision**: There is no test runner in `package.json`. Add pure-function unit tests for the slot helper and insertion action with Vitest as a dev dependency, plus a manual quickstart for the gesture itself. Note that Vitest is a new devDependency.
- **Alternatives considered**: Manual-only (the index math is regression-prone); Playwright (Tauri webview setup is heavy).
