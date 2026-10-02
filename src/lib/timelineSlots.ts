/**
 * Index (0..clips.length) at which something dropped at `time` should be
 * inserted: before the first clip whose midpoint is still ahead of the cursor.
 */
export function slotIndexAtTime(clips: { start: number; end: number }[], time: number): number {
  const i = clips.findIndex((c) => time < (c.start + c.end) / 2);
  return i < 0 ? clips.length : i;
}
