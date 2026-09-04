import { useEditor } from "@/state/projectStore";
import { formatTime } from "@/lib/format";
import { NumberField, Row, Section, Toggle } from "./fields";

export default function ClipInspector() {
  const project = useEditor((s) => s.project);
  const resolved = useEditor((s) => s.resolved);
  const selectedClipIds = useEditor((s) => s.selectedClipIds);
  const trimClip = useEditor((s) => s.trimClip);
  const toggleClipMute = useEditor((s) => s.toggleClipMute);
  const deleteSelectedClips = useEditor((s) => s.deleteSelectedClips);

  if (selectedClipIds.length === 0) return null;

  if (selectedClipIds.length > 1) {
    return (
      <Section title={`${selectedClipIds.length} clips selected`}>
        <button
          className="w-full text-xs px-2 py-1 rounded bg-red-900/40 text-red-300
                     hover:bg-red-900/70"
          onClick={deleteSelectedClips}
        >
          Delete {selectedClipIds.length} clips
        </button>
      </Section>
    );
  }

  const clip = project.timeline.find((c) => c.id === selectedClipIds[0]);
  if (!clip) return null;
  const media = project.media.find((m) => m.id === clip.mediaId);
  const index = project.timeline.indexOf(clip);
  const layout = resolved.clips[index];
  const length = clip.outPoint - clip.inPoint;

  return (
    <Section
      title="Clip"
      action={
        <button
          className="text-[11px] text-red-400 hover:text-red-300"
          onClick={deleteSelectedClips}
        >
          Delete
        </button>
      }
    >
      <div className="text-xs text-neutral-300 truncate" title={media?.path}>
        {media?.fileName ?? "Missing file"}
      </div>
      <div className="text-[11px] text-neutral-600">
        {media ? `${media.width}×${media.height} · ${media.fps.toFixed(2)} fps · ` : ""}
        source {formatTime(media?.duration ?? 0)}
      </div>

      <Row label="In">
        <NumberField
          value={clip.inPoint}
          min={0}
          max={media?.duration}
          onChange={(v) => trimClip(clip.id, v, clip.outPoint)}
          suffix="s"
        />
      </Row>
      <Row label="Out">
        <NumberField
          value={clip.outPoint}
          min={0}
          max={media?.duration}
          onChange={(v) => trimClip(clip.id, clip.inPoint, v)}
          suffix="s"
        />
      </Row>
      <Row label="Length">
        <span className="text-xs text-neutral-300 tabular-nums">{formatTime(length)}</span>
      </Row>
      {layout && (
        <Row label="Starts at">
          <span className="text-xs text-neutral-500 tabular-nums">{formatTime(layout.start)}</span>
        </Row>
      )}

      <Toggle
        checked={clip.muted}
        onChange={() => toggleClipMute(clip.id)}
        label={media?.hasAudio ? "Mute this clip's audio" : "No audio track in this clip"}
      />
    </Section>
  );
}
