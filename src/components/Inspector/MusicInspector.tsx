import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import { chooseMusic } from "@/lib/music";
import { NumberField, Row, Section, Slider, Toggle } from "./fields";

export default function MusicInspector() {
  const music = useEditor((s) => s.project.music);
  const total = useEditor((s) => s.resolved.totalDuration);
  const updateMusic = useEditor((s) => s.updateMusic);
  const setMusic = useEditor((s) => s.setMusic);

  if (!music) {
    return (
      <Section title="Background music">
        <button
          className="w-full text-xs px-2 py-1.5 rounded bg-white/5 hover:bg-white/10
                     text-neutral-300"
          onClick={() => void chooseMusic()}
        >
          Choose a track…
        </button>
      </Section>
    );
  }

  const available = Math.max(0, music.duration - music.startOffset);
  const short = !music.loopToFit && available < total - 0.05;

  return (
    <Section
      title="Background music"
      action={
        <button className="text-[11px] text-red-400 hover:text-red-300" onClick={() => setMusic(null)}>
          Remove
        </button>
      }
    >
      <div className="text-xs text-neutral-300 truncate" title={music.path}>
        ♪ {music.fileName}
      </div>
      <div className="text-[11px] text-neutral-600">
        {formatTime(music.duration)} · timeline is {formatTime(total)}
      </div>

      <Row label="Volume">
        <Slider
          value={music.volume}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => updateMusic({ volume: v })}
        />
        <span className="w-10 text-right text-xs text-neutral-400 tabular-nums">
          {Math.round(music.volume * 100)}%
        </span>
      </Row>

      <Row label="Fade in">
        <NumberField
          value={music.fadeIn}
          min={0}
          max={30}
          step={0.5}
          suffix="s"
          onChange={(v) => updateMusic({ fadeIn: Math.max(0, v) })}
        />
      </Row>
      <Row label="Fade out">
        <NumberField
          value={music.fadeOut}
          min={0}
          max={30}
          step={0.5}
          suffix="s"
          onChange={(v) => updateMusic({ fadeOut: Math.max(0, v) })}
        />
      </Row>
      <Row label="Start at">
        <NumberField
          value={music.startOffset}
          min={0}
          max={Math.max(0, music.duration - 1)}
          step={0.5}
          suffix="s"
          onChange={(v) => updateMusic({ startOffset: Math.max(0, v) })}
        />
      </Row>

      <Toggle
        checked={music.loopToFit}
        onChange={(v) => updateMusic({ loopToFit: v })}
        label="Loop to fill the timeline"
      />

      {short && (
        <p className="text-[11px] text-amber-400/90 leading-snug">
          The track runs out {formatTime(total - available)} before the video ends. Turn on looping
          or pick a longer track.
        </p>
      )}
    </Section>
  );
}
