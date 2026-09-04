import { formatTime } from "@/lib/format";

/** Choose a tick spacing that keeps labels readable at any zoom. */
function tickStep(zoom: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const minPx = 70;
  return candidates.find((c) => c * zoom >= minPx) ?? 900;
}

export default function Ruler({
  duration,
  zoom,
  width,
}: {
  duration: number;
  zoom: number;
  width: number;
}) {
  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + step; t += step) ticks.push(t);

  return (
    <div className="relative h-6 border-b border-edge bg-[#15171c]" style={{ width }}>
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 h-full" style={{ left: t * zoom }}>
          <div className="w-px h-2 bg-neutral-700" />
          <span className="absolute left-1 top-1.5 text-[10px] text-neutral-500 tabular-nums whitespace-nowrap">
            {formatTime(t)}
          </span>
        </div>
      ))}
    </div>
  );
}
