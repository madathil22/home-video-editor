import { describe, expect, it } from "vitest";
import { slotIndexAtTime } from "./timelineSlots";

const clips = [
  { start: 0, end: 4 },
  { start: 4, end: 10 },
];

describe("slotIndexAtTime", () => {
  it("returns 0 for an empty timeline", () => {
    expect(slotIndexAtTime([], 5)).toBe(0);
  });
  it("returns 0 before the first midpoint", () => {
    expect(slotIndexAtTime(clips, 1)).toBe(0);
  });
  it("returns the slot between clips", () => {
    expect(slotIndexAtTime(clips, 3)).toBe(1);
  });
  it("returns clips.length past the last midpoint", () => {
    expect(slotIndexAtTime(clips, 9)).toBe(2);
  });
});
