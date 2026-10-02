# Feature Specification: Drag Media to Timeline

**Feature Branch**: `001-drag-media-to-timeline`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "should have the ability to drag and drop added files to the timeline, rather than Add all only"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Drag a single media item onto the timeline (Priority: P1)

After importing files into the media bin, the user picks one item and drags it onto the timeline, dropping it where they want it to appear, instead of being forced to add every imported file at once.

**Why this priority**: This is the core request. Today the only way to place media is "Add all", which gives no control over which files are used or in what order.

**Independent Test**: Import several files, drag one item from the media bin to the timeline, and confirm only that item appears at the drop position.

**Acceptance Scenarios**:

1. **Given** the media bin holds several files and the timeline is empty, **When** the user drags one file onto the timeline and releases it, **Then** a clip for only that file appears on the timeline.
2. **Given** the timeline already has clips, **When** the user drops a media item between two existing clips, **Then** the new clip is inserted at that position and later clips shift along.
3. **Given** the user is dragging a media item, **When** the pointer moves over the timeline, **Then** a visible indicator shows where the clip will be inserted.
4. **Given** the user is dragging a media item, **When** they release it outside the timeline or press Escape, **Then** nothing is added.

---

### User Story 2 - Drag multiple media items at once (Priority: P2)

The user selects several items in the media bin and drags them together to the timeline, keeping their bin order.

**Why this priority**: It speeds up building a sequence, but single-item drag already delivers the main value.

**Independent Test**: Select three items, drag them as a group onto the timeline, and confirm three clips are added in order at the drop position.

**Acceptance Scenarios**:

1. **Given** several media items are selected, **When** the user drags one of them to the timeline, **Then** all selected items are added together in bin order at the drop position.

---

### User Story 3 - Keep "Add all" as a shortcut (Priority: P3)

The existing "Add all" button continues to work for users who want everything placed quickly.

**Why this priority**: It preserves current behavior and avoids regressions.

**Independent Test**: Click "Add all" and confirm every media item is appended to the timeline as before.

**Acceptance Scenarios**:

1. **Given** the media bin has files, **When** the user clicks "Add all", **Then** all items are appended to the timeline in order.

---

### Edge Cases

- Dropping onto an empty timeline places the clip at the start.
- Dropping past the last clip appends it to the end.
- The same media item can be dragged onto the timeline multiple times, producing separate clips.
- A media item that is unavailable or failed to load cannot be dragged, or the drop is rejected with a clear message.
- Dragging external files from the operating system directly onto the timeline keeps working as it does today.
- Placing clips by drag is a single undoable action.
- Reordering existing clips on the timeline continues to work and is not confused with dragging from the bin.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to drag an individual media item from the media bin and drop it onto the timeline.
- **FR-002**: The system MUST add only the dragged item(s) to the timeline, not the whole bin.
- **FR-003**: The system MUST insert the dropped clip at the position under the pointer at release, shifting later clips accordingly.
- **FR-004**: The system MUST show a visual cue during drag indicating the drop position and whether the drop is valid.
- **FR-005**: Cancelling a drag, or dropping outside the timeline, MUST leave the timeline unchanged.
- **FR-006**: Users MUST be able to drag multiple selected media items together and have them inserted in bin order.
- **FR-007**: The "Add all" action MUST remain available and behave as before.
- **FR-008**: A drag-and-drop placement MUST be undoable as a single step.
- **FR-009**: Media items MUST remain in the bin after being placed, so they can be reused.
- **FR-010**: Existing timeline interactions (trimming, reordering clips, dropping files from the operating system) MUST be unaffected.

### Key Entities

- **Media item**: An imported file in the bin, with its name, type, and duration. It can be placed on the timeline any number of times.
- **Timeline clip**: A placed instance of a media item at a position in the sequence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can place a chosen media item at a chosen position in a single drag gesture, with no extra clicks.
- **SC-002**: In testing, 95% of users place a clip at their intended position on the first attempt.
- **SC-003**: The drop-position indicator appears within 100 ms of the pointer entering the timeline.
- **SC-004**: Building a 10-clip sequence in a chosen order requires no removal or rearranging of unwanted clips.
- **SC-005**: All pre-existing workflows, including "Add all", still work with no regressions.

## Assumptions

- Users operate with a mouse or trackpad; touch and keyboard-only alternatives are out of scope for this version.
- Media items are already imported into the media bin before dragging.
- There is a single main video track, so the drop position is a point in the clip sequence rather than a choice of track.
- Multi-select in the media bin is added as part of this feature if it does not already exist.
- Dragging media from the bin does not remove it from the bin.
