import { formatTime } from "@/lib/format";
import { chooseMusic } from "@/lib/music";
import type { MusicTrack } from "@/types/project";

export default function MusicStrip({
  music,
  totalDuration,
  zoom,
}: {
  music: MusicTrack | null;
  totalDuration: number;
  zoom: number;
}) {
  if (!music) {
    return (
      <div className="mt-1.5 h-9">
        <button
          className="h-full w-72 rounded border border-dashed border-edge text-[11px]
                     text-neutral-500 hover:text-neutral-300 hover:border-neutral-600"
          onClick={() => void chooseMusic()}
        >
          + Add background music
        </button>
      </div>
    );
  }

  const available = Math.max(0, music.duration - music.startOffset);
  const covered = music.loopToFit ? totalDuration : Math.min(available, totalDuration);
  const short = !music.loopToFit && available < totalDuration - 0.05;

  return (
    <div className="mt-1.5 h-9 relative">
      <div
        className="absolute top-0 h-full rounded bg-emerald-900/50 border border-emerald-700/60
                   overflow-hidden"
        style={{ width: Math.max(2, covered * zoom) }}
        title={`${music.fileName} · ${formatTime(music.duration)}`}
      >
        {/* Volume is drawn as the filled portion of the lane. */}
        <div
          className="absolute bottom-0 inset-x-0 bg-emerald-500/35"
          style={{ height: `${Math.min(1, music.volume * 2) * 100}%` }}
        />
        {music.fadeIn > 0 && (
          <div
            className="absolute top-0 left-0 h-full bg-gradient-to-r from-[#101216] to-transparent"
            style={{ width: music.fadeIn * zoom }}
          />
        )}
        {music.fadeOut > 0 && (
          <div
            className="absolute top-0 right-0 h-full bg-gradient-to-l from-[#101216] to-transparent"
            style={{ width: music.fadeOut * zoom }}
          />
        )}
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-emerald-100
                         drop-shadow truncate pr-2">
          ♪ {music.fileName}
        </span>
      </div>

      {short && (
        <div
          className="absolute top-0 h-full flex items-center px-2 text-[10px] text-amber-400/90"
          style={{ left: covered * zoom + 8 }}
        >
          music ends here — enable loop to fill
        </div>
      )}
    </div>
  );
}
