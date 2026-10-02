# Implementation Plan: Drag Media to Timeline

**Branch**: `001-drag-media-to-timeline` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-drag-media-to-timeline/spec.md`

## Summary

Let users drag one or more media items from the media bin onto the timeline and insert them at the drop position, instead of only using "Add all". The approach is a pointer-based drag (HTML5 DnD is unreliable here because Tauri's `dragDropEnabled` is on), a transient drag slice in the zustand store, an insertion marker on the timeline, and an optional `atIndex` on `addToTimeline`. "Add all" and double-click are unchanged.

## Technical Context

**Language/Version**: TypeScript 5.7 (React 18.3) frontend; Rust backend (Tauri 2), which is not touched by this feature

**Primary Dependencies**: React, zustand 5, Tailwind 3, `@tauri-apps/api` 2. New devDependency: Vitest.

**Storage**: Project file (`.hveproj`). No schema change.

**Testing**: Vitest (new) for pure logic, plus the manual quickstart for the gesture

**Target Platform**: Windows desktop (Tauri WebView2); also builds on macOS and Linux

**Project Type**: desktop-app

**Performance Goals**: Insertion marker updates within 100 ms of pointer movement (SC-003). Drag stays smooth at 60 fps.

**Constraints**: Must coexist with `dragDropEnabled: true` OS file import and with the existing mouse-based trim and reorder.

**Scale/Scope**: Timelines of tens to low hundreds of clips; 3 files changed plus 1 new helper

## Constitution Check

`.specify/memory/constitution.md` is still the unfilled template, so it defines no ratified principles and there are no gates. Result: **PASS (no constraints)**. Re-check after Phase 1: PASS. Consider running `/speckit-constitution` later.

## Project Structure

### Documentation (this feature)

```text
specs/001-drag-media-to-timeline/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ui-contract.md
└── tasks.md             # Created by /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── components/
│   ├── MediaBin.tsx              # drag start, multi-select, drag ghost
│   └── Timeline/
│       └── Timeline.tsx          # insertion marker, drop handling, shared slot helper
├── lib/
│   └── timelineSlots.ts          # NEW: slotIndexAtTime (pure, unit tested)
└── state/
    └── projectStore.ts           # addToTimeline(atIndex?), selectedMediaIds, mediaDrag slice
src-tauri/                        # unchanged
```

**Structure Decision**: Single Tauri app. All changes are in the existing React frontend. They live beside the code they extend, with one new pure helper so the index math can be tested.

## Complexity Tracking

No constitution violations. The one addition, Vitest, is justified by the lack of any test runner for the index math.
