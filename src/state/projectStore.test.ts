import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  resolveProject: vi.fn(async () => ({
    clips: [],
    boundaries: [],
    totalDuration: 0,
    clampedCount: 0,
  })),
}));

import { useEditor } from "./projectStore";
import { emptyProject, type MediaItem } from "@/types/project";

const media = (id: string): MediaItem => ({
  id,
  path: `/${id}.mp4`,
  fileName: `${id}.mp4`,
  proxyPath: null,
  thumbnailPath: null,
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  rotation: 0,
  videoCodec: "h264",
  creationTime: null,
});

const timelineMedia = () => useEditor.getState().project.timeline.map((c) => c.mediaId);

beforeEach(() => {
  const project = { ...emptyProject(), media: ["a", "b", "c", "d"].map(media) };
  useEditor.setState({ project, past: [], future: [], selectedMediaIds: [], mediaDrag: null });
});

describe("addToTimeline", () => {
  it("appends when no index is given", () => {
    useEditor.getState().addToTimeline(["a", "b"]);
    useEditor.getState().addToTimeline(["c"]);
    expect(timelineMedia()).toEqual(["a", "b", "c"]);
  });

  it("inserts at the start and in the middle", () => {
    const s = useEditor.getState();
    s.addToTimeline(["a", "b"]);
    s.addToTimeline(["c"], 0);
    s.addToTimeline(["d"], 2);
    expect(timelineMedia()).toEqual(["c", "a", "d", "b"]);
  });

  it("clamps the index and skips unknown ids", () => {
    const s = useEditor.getState();
    s.addToTimeline(["a"]);
    s.addToTimeline(["b"], 99);
    s.addToTimeline(["c"], -5);
    s.addToTimeline(["nope"], 1);
    expect(timelineMedia()).toEqual(["c", "a", "b"]);
  });

  it("inserts several items in order as one undo step", () => {
    const s = useEditor.getState();
    s.addToTimeline(["a"]);
    s.addToTimeline(["b", "c"], 0);
    expect(timelineMedia()).toEqual(["b", "c", "a"]);
    useEditor.getState().undo();
    expect(timelineMedia()).toEqual(["a"]);
  });
});

describe("media selection", () => {
  it("supports single, toggle and range", () => {
    const s = () => useEditor.getState();
    s().selectMedia("b", "single");
    expect(s().selectedMediaIds).toEqual(["b"]);
    s().selectMedia("d", "toggle");
    expect(s().selectedMediaIds).toEqual(["b", "d"]);
    s().selectMedia("d", "toggle");
    expect(s().selectedMediaIds).toEqual(["b"]);
    s().selectMedia("d", "range");
    expect(s().selectedMediaIds).toEqual(["b", "c", "d"]);
  });

  it("drops a removed item from the selection", () => {
    const s = useEditor.getState();
    s.selectMedia("a", "single");
    s.selectMedia("b", "toggle");
    useEditor.getState().removeMedia("a");
    expect(useEditor.getState().selectedMediaIds).toEqual(["b"]);
  });
});
