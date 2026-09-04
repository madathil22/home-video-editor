import { useEditor } from "@/state/projectStore";
import { formatTimePrecise } from "@/lib/format";

function Btn({
  onClick,
  title,
  children,
  disabled,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="px-2 py-1 rounded text-neutral-300 hover:bg-white/10 disabled:opacity-30
                 disabled:hover:bg-transparent text-sm leading-none"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function TransportControls() {
  const resolved = useEditor((s) => s.resolved);
  const playhead = useEditor((s) => s.playhead);
  const isPlaying = useEditor((s) => s.isPlaying);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const fps = useEditor((s) => s.project.settings.fps);

  const total = resolved.totalDuration;
  const empty = resolved.clips.length === 0;
  const frame = 1 / Math.max(1, fps);

  const seek = (t: number) => setPlayhead(Math.max(0, Math.min(total, t)));

  const prevBoundary = () => {
    const stops = [0, ...resolved.clips.map((c) => c.start)].filter((s) => s < playhead - 0.05);
    seek(stops.length ? Math.max(...stops) : 0);
  };

  const nextBoundary = () => {
    const stops = [...resolved.clips.map((c) => c.start), total].filter((s) => s > playhead + 0.05);
    seek(stops.length ? Math.min(...stops) : total);
  };

  return (
    <div className="shrink-0 border-t border-edge px-3 py-1.5 flex items-center gap-1">
      <Btn onClick={() => seek(0)} title="Go to start (Home)" disabled={empty}>
        ⏮
      </Btn>
      <Btn onClick={prevBoundary} title="Previous clip" disabled={empty}>
        ◀◀
      </Btn>
      <Btn onClick={() => seek(playhead - frame)} title="Back one frame (←)" disabled={empty}>
        ◀
      </Btn>
      <button
        className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-neutral-100
                   disabled:opacity-30 text-sm leading-none"
        onClick={() => setPlaying(!isPlaying)}
        title="Play / pause (Space)"
        disabled={empty}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>
      <Btn onClick={() => seek(playhead + frame)} title="Forward one frame (→)" disabled={empty}>
        ▶
      </Btn>
      <Btn onClick={nextBoundary} title="Next clip" disabled={empty}>
        ▶▶
      </Btn>
      <Btn onClick={() => seek(total)} title="Go to end (End)" disabled={empty}>
        ⏭
      </Btn>

      <div className="flex-1" />

      <span className="text-xs tabular-nums text-neutral-400">
        {formatTimePrecise(playhead)}
        <span className="text-neutral-600"> / {formatTimePrecise(total)}</span>
      </span>
    </div>
  );
}
