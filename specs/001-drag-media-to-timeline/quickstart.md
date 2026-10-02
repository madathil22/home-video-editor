# Quickstart: Validate Drag Media to Timeline

## Prerequisites

- `npm install`
- A few short test videos (3 or more)

## Automated checks

```powershell
npm run typecheck
npm test        # Vitest; added by this feature (slot helper + addToTimeline insertion)
```

Expected: typecheck is clean and the unit tests pass.

## Manual validation (`npm run tauri dev`)

1. **Single drag (US1)**: Add 3 files. Drag the second one onto the empty timeline. Expect only that clip on the timeline, with the bin still holding all 3.
2. **Insert between**: With 2 clips on the timeline, drag a third between them. Expect an insertion marker during the drag and the clip inserted at that spot.
3. **Cancel**: Start a drag and release over the media bin, then try again and press Esc. Expect no change.
4. **Undo**: Press Ctrl+Z after a drop. Expect the single drop to be undone in one step.
5. **Multi-drag (US2)**: Ctrl-click 3 media cards, then drag one of them. Expect 3 clips inserted in bin order.
6. **Add all (US3)**: Click "Add all". Expect every item appended, as before.
7. **Regression**: Trim a clip, reorder clips on the timeline, double-click a card (appends), and drop an OS file onto the window (imports). Expect all of them to work as before.

Contract details: [contracts/ui-contract.md](contracts/ui-contract.md). State shapes: [data-model.md](data-model.md).
