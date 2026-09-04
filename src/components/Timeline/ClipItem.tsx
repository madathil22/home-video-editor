import { convertFileSrc } from "@tauri-apps/api/core";
import { formatTime } from "@/lib/format";
import type { Clip, MediaItem, ResolvedClip } from "@/types/project";

export default function ClipItem({
  clip,
  media,
  layout,
  zoom,
  selected,
  onSelect,
  onStartTrim,
  onStartMove,
  onToggleMute,
}: {
  clip: Clip;
  media: MediaItem | undefined;
  layout: ResolvedClip;
  zoom: number;
  selected: boolean;
  onSelect: (additive: boolean) => void;
  onStartTrim: (edge: "in" | "out", e: React.MouseEvent) => void;
  onStartMove: (e: React.MouseEvent) => void;
  onToggleMute: () => void;
}) {
  const width = Math.max(2, layout.duration * zoom);
  const narrow = width < 90;

  return (
    <div
      className={`absolute top-0 h-full rounded overflow-hidden border-2 transition-colors ${
        selected ? "border-accent z-20" : "border-transparent hover:border-neutral-600 z-10"
      }`}
      style={{ left: layout.start * zoom, width }}
      onMouseDown={(e) => {
        // Trim handles manage their own drag; the body starts a reorder.
        if ((e.target as HTMLElement).dataset.handle) return;
        onSelect(e.ctrlKey || e.metaKey || e.shiftKey);
        onStartMove(e);
      }}
      title={media ? `${media.fileName}\n${formatTime(layout.duration)}` : "Missing media"}
    >
      <div className="absolute inset-0 bg-panelAlt">
        {media?.thumbnailPath && (
          <img
            src={convertFileSrc(media.thumbnailPath)}
            className="w-full h-full object-cover opacity-45"
            alt=""
            draggable={false}
          />
        )}
      </div>

      <div className="absolute inset-0 bg-gradient-to-b from-black/10 to-black/50" />

      {!narrow && (
        <div className="absolute inset-x-0 top-0 px-1.5 py-0.5 flex items-center gap-1">
          <span className="truncate text-[11px] text-neutral-100 drop-shadow">
            {media?.fileName ?? "missing"}
          </span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 flex items-center justify-between">
        <span className="text-[10px] text-neutral-300 tabular-nums drop-shadow">
          {formatTime(layout.duration)}
        </span>
        {!narrow && (
          <button
            data-handle="mute"
            className={`text-[10px] px-1 rounded ${
              clip.muted ? "text-red-400" : "text-neutral-400 hover:text-neutral-200"
            }`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMute();
            }}
            title={clip.muted ? "Clip audio is muted" : "Mute this clip's audio"}
          >
            {clip.muted ? "muted" : media?.hasAudio ? "audio" : "silent"}
          </button>
        )}
      </div>

      {/* Trim handles */}
      <div
        data-handle="in"
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-white/0
                   hover:bg-accent/60 active:bg-accent"
        onMouseDown={(e) => {
          e.stopPropagation();
          onStartTrim("in", e);
        }}
        title="Drag to trim the start"
      />
      <div
        data-handle="out"
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-white/0
                   hover:bg-accent/60 active:bg-accent"
        onMouseDown={(e) => {
          e.stopPropagation();
          onStartTrim("out", e);
        }}
        title="Drag to trim the end"
      />
    </div>
  );
}
