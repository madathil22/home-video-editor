import { useCallback, useEffect, useMemo, useRef } from "react";
import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import ClipItem from "./ClipItem";
import Ruler from "./Ruler";
import TransitionMarker from "./TransitionMarker";
import MusicStrip from "./MusicStrip";

const TRACK_HEIGHT = 84;

export default function Timeline() {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const selectedClipIds = useEditor((s) => s.selectedClipIds);
  const selectedBoundary = useEditor((s) => s.selectedBoundary);
  const selectClip = useEditor((s) => s.selectClip);
  const selectBoundary = useEditor((s) => s.selectBoundary);
  const clearSelection = useEditor((s) => s.clearSelection);
  const trimClip = useEditor((s) => s.trimClip);
  const moveClip = useEditor((s) => s.moveClip);
  const toggleClipMute = useEditor((s) => s.toggleClipMute);
  const pushHistory = useEditor((s) => s.pushHistory);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentWidth = Math.max(600, (resolved.totalDuration + 4) * zoom);

  const mediaById = useMemo(
    () => Object.fromEntries(project.media.map((m) => [m.id, m])),
    [project.media]
  );

  // --- trim dragging -------------------------------------------------------
  const trimRef = useRef<{
    clipId: string;
    edge: "in" | "out";
    startX: number;
    startIn: number;
    startOut: number;
  } | null>(null);

  const startTrim = useCallback(
    (clipId: string, edge: "in" | "out", e: React.MouseEvent) => {
      const clip = project.timeline.find((c) => c.id === clipId);
      if (!clip) return;
      // One history entry for the whole gesture, not one per mouse move.
      pushHistory();
      trimRef.current = {
        clipId,
        edge,
        startX: e.clientX,
        startIn: clip.inPoint,
        startOut: clip.outPoint,
      };
    },
    [project.timeline, pushHistory]
  );

  // --- reorder dragging ----------------------------------------------------
  const moveRef = useRef<{ clipId: string; startX: number; moved: boolean } | null>(null);

  const startMove = useCallback((clipId: string, e: React.MouseEvent) => {
    moveRef.current = { clipId, startX: e.clientX, moved: false };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const trim = trimRef.current;
      if (trim) {
        const delta = (e.clientX - trim.startX) / zoom;
        if (trim.edge === "in") {
          trimClip(trim.clipId, trim.startIn + delta, trim.startOut, true);
        } else {
          trimClip(trim.clipId, trim.startIn, trim.startOut + delta, true);
        }
        return;
      }

      const move = moveRef.current;
      if (move && Math.abs(e.clientX - move.startX) > 6) {
        move.moved = true;
      }
    };

    const onUp = (e: MouseEvent) => {
      const move = moveRef.current;
      if (move?.moved) {
        const rect = scrollRef.current?.getBoundingClientRect();
        const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
        if (rect) {
          const x = e.clientX - rect.left + scrollLeft;
          const time = x / zoom;
          // Drop into whichever slot the cursor is nearest.
          let target = resolved.clips.findIndex((c) => time < (c.start + c.end) / 2);
          if (target < 0) target = project.timeline.length - 1;
          moveClip(move.clipId, target);
        }
      }
      trimRef.current = null;
      moveRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [zoom, trimClip, moveClip, resolved.clips, project.timeline.length]);

  const seekFromEvent = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setPlayhead(Math.min(resolved.totalDuration, Math.max(0, x / zoom)));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#101216]">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-edge shrink-0">
        <span className="text-[11px] uppercase tracking-wide text-neutral-400">Timeline</span>
        <span className="text-xs text-neutral-500 tabular-nums">
          {project.timeline.length} clip{project.timeline.length === 1 ? "" : "s"} ·{" "}
          {formatTime(resolved.totalDuration)}
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-neutral-600">ctrl+scroll to zoom</span>
        <input
          type="range"
          min={4}
          max={200}
          step={1}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-28"
        />
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden min-h-0"
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        <div style={{ width: contentWidth }} className="relative pb-2">
          <div onMouseDown={seekFromEvent} className="cursor-pointer">
            <Ruler duration={resolved.totalDuration} zoom={zoom} width={contentWidth} />
          </div>

          <div
            className="relative mt-2 mx-0"
            style={{ height: TRACK_HEIGHT }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                clearSelection();
                seekFromEvent(e);
              }
            }}
          >
            {project.timeline.length === 0 && (
              <div className="absolute inset-0 grid place-items-center text-neutral-600 text-xs">
                Add clips from the panel on the left to start building your video.
              </div>
            )}

            {resolved.clips.map((layout, i) => {
              const clip = project.timeline[i];
              if (!clip) return null;
              return (
                <ClipItem
                  key={clip.id}
                  clip={clip}
                  media={mediaById[clip.mediaId]}
                  layout={layout}
                  zoom={zoom}
                  selected={selectedClipIds.includes(clip.id)}
                  onSelect={(additive) => selectClip(clip.id, additive)}
                  onStartTrim={(edge, e) => startTrim(clip.id, edge, e)}
                  onStartMove={(e) => startMove(clip.id, e)}
                  onToggleMute={() => toggleClipMute(clip.id)}
                />
              );
            })}

            {resolved.boundaries.map((b) => {
              const next = resolved.clips[b.index + 1];
              if (!next) return null;
              return (
                <TransitionMarker
                  key={b.afterClipId}
                  boundary={b}
                  next={next}
                  zoom={zoom}
                  selected={selectedBoundary === b.index}
                  onSelect={() => selectBoundary(b.index)}
                />
              );
            })}
          </div>

          <MusicStrip
            music={project.music}
            totalDuration={resolved.totalDuration}
            zoom={zoom}
          />

          {/* Playhead spans the ruler and both tracks. */}
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-40"
            style={{ left: playhead * zoom }}
          >
            <div className="w-2.5 h-2.5 -ml-[5px] bg-red-500 rotate-45" />
          </div>
        </div>
      </div>
    </div>
  );
}
