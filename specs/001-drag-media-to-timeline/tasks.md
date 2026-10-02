# Tasks: Drag Media to Timeline

**Input**: Design documents from `/specs/001-drag-media-to-timeline/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-contract.md

**Tests**: Unit tests (Vitest) cover the pure index logic and the store insertion, as called for in plan.md. The drag gesture is validated manually via quickstart.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story the task belongs to (US1, US2, US3)

## Phase 1: Setup

- [X] T001 Add Vitest as a devDependency and a `"test": "vitest run"` script in `package.json`; add a `test` block (`environment: "node"`, alias `@` to `src`) in `vite.config.ts`

## Phase 2: Foundational (blocks all user stories)

- [X] T002 [P] Create pure helper `slotIndexAtTime(clips: { start: number; end: number }[], time: number): number` in `src/lib/timelineSlots.ts`. It returns the index of the first clip whose midpoint `(start + end) / 2` is after `time`, or `clips.length` if none, so the result is in `0..clips.length`
- [X] T003 [P] Write unit tests for `slotIndexAtTime` in `src/lib/timelineSlots.test.ts` (empty list returns 0; before the first midpoint returns 0; between clips; past the last clip returns N)
- [X] T004 Extend `addToTimeline(mediaIds: string[], atIndex?: number)` in `src/state/projectStore.ts`. When `atIndex` is omitted it appends (unchanged). Otherwise it clamps `atIndex` to `0..timeline.length` and splices the new clips in. It makes exactly one `commit` call (one undo step) and skips unknown media ids
- [X] T005 Write unit tests for `addToTimeline` insertion in `src/state/projectStore.test.ts` (append default, insert at 0, insert in the middle, clamp above N and below 0, unknown ids skipped, one undo step restores the previous timeline). Mock `@/lib/ipc` so `refreshResolved` does not call Tauri
- [X] T006 Refactor the reorder branch of `onUp` in `src/components/Timeline/Timeline.tsx` to use `slotIndexAtTime`. Clamp the result to `timeline.length - 1` for `moveClip` so reorder behavior is unchanged

**Checkpoint**: `npm run test` and `npm run typecheck` pass; reorder still works.

## Phase 3: User Story 1 - Drag a single media item onto the timeline (Priority: P1) 🎯 MVP

**Goal**: Drag one media item from the bin and drop it at a chosen position on the timeline.

**Independent Test**: quickstart.md steps 1 to 4.

- [X] T007 [US1] Add the transient `mediaDrag: { mediaIds: string[]; x: number; y: number } | null` slice with `beginMediaDrag(mediaIds, x, y)`, `updateMediaDrag(x, y)` and `endMediaDrag()` to `src/state/projectStore.ts`. Do not include it in `Project` and do not push history. `loadProject` resets it to `null`
- [X] T008 [US1] In `src/components/MediaBin.tsx`, add mousedown handling on each media card. After the pointer moves more than 6 px, call `beginMediaDrag([m.id], x, y)`. Skip media whose `proxyStatus[m.id] === "error"`. Below the threshold, click and `onDoubleClick` behave as before
- [X] T009 [US1] In `src/components/MediaBin.tsx`, while a drag is active, add window `mousemove` (call `updateMediaDrag`), `mouseup` and `keydown` Escape (call `endMediaDrag`) listeners. Render a fixed-position, pointer-events-none drag ghost (thumbnail or file name) at `mediaDrag.x/y`, mounted only while dragging
- [X] T010 [US1] In `src/components/Timeline/Timeline.tsx`, compute the insertion index from `mediaDrag` using `slotIndexAtTime` and the track's bounding rect plus `scrollLeft`, only while the pointer is over the track area, and render a vertical insertion marker at that slot's x position (the left edge of the clip at the slot, or the end of the last clip when the index equals `clips.length`)
- [X] T011 [US1] In `src/components/Timeline/Timeline.tsx`, on window `mouseup` while `mediaDrag` is set and the pointer is over the track: call `addToTimeline(mediaDrag.mediaIds, index)`, then `endMediaDrag()`. If the pointer is outside the track, call `endMediaDrag()` only
- [X] T012 [US1] Update the empty-timeline hint in `src/components/Timeline/Timeline.tsx` and the card tooltip in `src/components/MediaBin.tsx` to mention dragging clips onto the timeline

**Checkpoint**: Single-item drag, insertion marker, cancel and one-step undo all work.

## Phase 4: User Story 2 - Drag multiple media items at once (Priority: P2)

**Goal**: Select several media cards and drag them together.

**Independent Test**: quickstart.md step 5.

- [X] T013 [US2] Add `selectedMediaIds: string[]`, `selectMedia(id, mode: "single" | "toggle" | "range")` and `clearMediaSelection()` to `src/state/projectStore.ts`. `range` selects from the last selected id to `id` in `project.media` order. `removeMedia` removes the id from the selection and `loadProject` clears it
- [X] T014 [US2] In `src/components/MediaBin.tsx`, wire click (single), Ctrl/Cmd-click (toggle) and Shift-click (range) on cards, show a selected-state style on selected cards, and clear the selection when the empty area of the bin is clicked
- [X] T015 [US2] In `src/components/MediaBin.tsx`, when a drag starts on a selected card, pass all selected ids (in `project.media` order, excluding proxy-error items) to `beginMediaDrag`. A drag started on an unselected card drags only that card. Show a count badge on the drag ghost when more than 1 item is dragged
- [X] T016 [P] [US2] Add unit tests for `selectMedia` modes and `removeMedia` selection cleanup in `src/state/projectStore.test.ts`

**Checkpoint**: Multi-select drag inserts all items in bin order at the drop position.

## Phase 5: User Story 3 - Keep "Add all" as a shortcut (Priority: P3)

**Goal**: Confirm that "Add all" and double-click are unchanged.

**Independent Test**: quickstart.md steps 6 and 7.

- [X] T017 [US3] Verify `src/components/MediaBin.tsx` still calls `addToTimeline(media.map((m) => m.id))` for "Add all" and `addToTimeline([m.id])` for double-click with no index. Confirm the `src/state/projectStore.test.ts` append-default test covers this, and fix any regression found

## Phase 6: Polish & Cross-Cutting

- [X] T018 Run `npm run typecheck` and `npm run test`; fix any failures
- [ ] T019 Run the manual validation in `specs/001-drag-media-to-timeline/quickstart.md` with `npm run tauri dev`, including the regression step (trim, reorder, OS file drop import)

## Dependencies & Execution Order

- Phase 1 (T001) before the test tasks T003, T005 and T016.
- Phase 2 blocks all stories. T002 and T003 can run in parallel with each other; T004 follows the same file as T007, so keep them sequential. T006 depends on T002.
- US1 (T007 to T012) depends on Phase 2. T007, then T008 to T009 (MediaBin) and T010 to T011 (Timeline). These two groups can proceed in parallel once T007 is done.
- US2 depends on US1 (it extends T008 and T009 in `MediaBin.tsx` and the store).
- US3 is verification only and can run any time after Phase 2, but is best done last.

## Parallel Example

```text
After T001:        T002 (timelineSlots.ts) and T003 (timelineSlots.test.ts)
After T007:        T008-T009 (MediaBin.tsx) alongside T010-T011 (Timeline.tsx)
```

## Implementation Strategy

- **MVP**: Phases 1 to 3 (US1) deliver the requested drag-and-drop on its own.
- **Increment 2**: Add US2 multi-select drag.
- **Increment 3**: US3 regression verification and polish.
