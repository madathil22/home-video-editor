import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import { importPaths, pickVideoFiles, pickVideoFolder } from "@/lib/import";

const DRAG_THRESHOLD_PX = 6;

export default function MediaBin() {
  const media = useEditor((s) => s.project.media);
  const proxyStatus = useEditor((s) => s.proxyStatus);
  const addToTimeline = useEditor((s) => s.addToTimeline);
  const removeMedia = useEditor((s) => s.removeMedia);
  const timeline = useEditor((s) => s.project.timeline);
  const selectedMediaIds = useEditor((s) => s.selectedMediaIds);
  const selectMedia = useEditor((s) => s.selectMedia);
  const clearMediaSelection = useEditor((s) => s.clearMediaSelection);
  const mediaDrag = useEditor((s) => s.mediaDrag);

  const usedCount = (mediaId: string) => timeline.filter((c) => c.mediaId === mediaId).length;

  // A press only becomes a drag after the pointer travels a few pixels, so
  // clicks and double-clicks keep working.
  const pressRef = useRef<{ x: number; y: number; ids: string[] } | null>(null);

  const onCardMouseDown = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const state = useEditor.getState();
    const selected = state.selectedMediaIds.includes(id);
    const wanted = new Set(selected ? state.selectedMediaIds : [id]);
    const ids = state.project.media
      .filter((m) => wanted.has(m.id) && state.proxyStatus[m.id] !== "error")
      .map((m) => m.id);
    pressRef.current = ids.length > 0 ? { x: e.clientX, y: e.clientY, ids } : null;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const state = useEditor.getState();
      if (state.mediaDrag) {
        state.updateMediaDrag(e.clientX, e.clientY);
        return;
      }
      const press = pressRef.current;
      if (
        press &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD_PX
      ) {
        pressRef.current = null;
        state.beginMediaDrag(press.ids, e.clientX, e.clientY);
      }
    };
    const onUp = () => {
      pressRef.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pressRef.current = null;
        useEditor.getState().endMediaDrag();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const dragThumb = mediaDrag
    ? media.find((m) => m.id === mediaDrag.mediaIds[0])?.thumbnailPath
    : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-edge flex items-center justify-between shrink-0">
        <span className="text-[11px] uppercase tracking-wide text-neutral-400">
          Clips {media.length > 0 && <span className="text-neutral-600">({media.length})</span>}
        </span>
      </div>

      <div className="p-2 flex gap-1.5 shrink-0">
        <button className="btn flex-1 text-xs" onClick={() => void pickVideoFiles().then(importPaths)}>
          Add files
        </button>
        <button className="btn flex-1 text-xs" onClick={() => void pickVideoFolder().then(importPaths)}>
          Add folder
        </button>
      </div>

      {media.length > 0 && (
        <div className="px-2 pb-2 shrink-0">
          <button
            className="btn-primary w-full text-xs"
            onClick={() => addToTimeline(media.map((m) => m.id))}
          >
            Add all {media.length} to timeline
          </button>
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto min-h-0 px-2 pb-2 space-y-1 select-none"
        onClick={(e) => {
          if (e.target === e.currentTarget) clearMediaSelection();
        }}
      >
        {media.length === 0 && (
          <div className="text-neutral-500 text-xs text-center px-3 py-10 leading-relaxed">
            Drop your clips here,
            <br />
            or use the buttons above.
          </div>
        )}

        {media.map((m) => {
          const status = proxyStatus[m.id] ?? "pending";
          const used = usedCount(m.id);
          const isSelected = selectedMediaIds.includes(m.id);
          return (
            <div
              key={m.id}
              className={`group flex gap-2 p-1.5 rounded bg-panelAlt border
                         cursor-pointer transition-colors ${
                           isSelected
                             ? "border-accent"
                             : "border-edge hover:border-neutral-600"
                         }`}
              onMouseDown={(e) => onCardMouseDown(e, m.id)}
              onClick={(e) =>
                selectMedia(m.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single")
              }
              onDoubleClick={() => addToTimeline([m.id])}
              title={`${m.path}\n\nDrag to the timeline, or double-click to add`}
            >
              <div className="w-20 h-12 shrink-0 rounded overflow-hidden bg-black relative">
                {m.thumbnailPath ? (
                  <img
                    src={convertFileSrc(m.thumbnailPath)}
                    className="w-full h-full object-cover"
                    alt=""
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-[10px] text-neutral-600">
                    {status === "working" ? "…" : "—"}
                  </div>
                )}
                {used > 0 && (
                  <div className="absolute top-0.5 left-0.5 bg-accent text-white text-[9px]
                                  px-1 rounded leading-4">
                    {used}×
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="truncate text-xs text-neutral-200">{m.fileName}</div>
                <div className="text-[11px] text-neutral-500">
                  {formatTime(m.duration)} · {m.height}p
                  {m.fps >= 1 && ` · ${Math.round(m.fps)}fps`}
                </div>
                <div className="text-[10px] mt-0.5">
                  {status === "done" && <span className="text-emerald-500">ready</span>}
                  {status === "working" && <span className="text-amber-500">preparing…</span>}
                  {status === "pending" && <span className="text-neutral-600">queued</span>}
                  {status === "error" && <span className="text-red-500">preview failed</span>}
                  {!m.hasAudio && <span className="text-neutral-600 ml-1.5">no audio</span>}
                </div>
              </div>

              <button
                className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400
                           px-1 transition-opacity self-start"
                title="Remove from project"
                onClick={(e) => {
                  e.stopPropagation();
                  removeMedia(m.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {mediaDrag && (
        <div
          className="fixed z-[100] pointer-events-none w-20 h-12 rounded overflow-hidden bg-black
                     border border-accent opacity-80"
          style={{ left: mediaDrag.x + 8, top: mediaDrag.y + 8 }}
        >
          {dragThumb && (
            <img src={convertFileSrc(dragThumb)} className="w-full h-full object-cover" alt="" />
          )}
          {mediaDrag.mediaIds.length > 1 && (
            <div className="absolute bottom-0.5 right-0.5 bg-accent text-white text-[10px] px-1 rounded">
              {mediaDrag.mediaIds.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
