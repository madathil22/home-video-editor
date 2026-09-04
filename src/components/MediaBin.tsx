import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import { importPaths, pickVideoFiles, pickVideoFolder } from "@/lib/import";

export default function MediaBin() {
  const media = useEditor((s) => s.project.media);
  const proxyStatus = useEditor((s) => s.proxyStatus);
  const addToTimeline = useEditor((s) => s.addToTimeline);
  const removeMedia = useEditor((s) => s.removeMedia);
  const timeline = useEditor((s) => s.project.timeline);

  const usedCount = (mediaId: string) => timeline.filter((c) => c.mediaId === mediaId).length;

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

      <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2 space-y-1">
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
          return (
            <div
              key={m.id}
              className="group flex gap-2 p-1.5 rounded bg-panelAlt border border-edge
                         hover:border-neutral-600 cursor-pointer transition-colors"
              onDoubleClick={() => addToTimeline([m.id])}
              title={`${m.path}\n\nDouble-click to add to the timeline`}
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
    </div>
  );
}
