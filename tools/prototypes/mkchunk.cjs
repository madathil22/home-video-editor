// Prototype 3: render a contiguous run of clips as ONE graph (bodies + xfades
// joined by the concat filter, single encoder), so a whole export is a handful
// of processes instead of one per segment.
//
// A chunk covers clips [from..to] and the transitions after each of them. The
// transition after clip `to` needs the head of clip `to+1`, so that clip is
// opened as an extra input but only its first D seconds are used.
const fs = require("fs");

const [, , projPath, from_, to_, out, scriptPath] = process.argv;
const proj = JSON.parse(fs.readFileSync(projPath, "utf8"));
const from = Number(from_);
const to = Number(to_);
const { width: W, height: H, fps: FPS } = proj.settings;
const D = proj.defaultTransition.duration;

const media = Object.fromEntries(proj.media.map((m) => [m.id, m]));
const clips = proj.timeline;
const n = clips.length;
const f = (x) => x.toFixed(6);

const args = ["-hide_banner", "-y"];
const graph = [];
const pieces = [];
let idx = 0;

// The extra head clip is opened last so body/transition indices stay simple.
const needsNextHead = to < n - 1;

for (let c = from; c <= to + (needsNextHead ? 1 : 0); c++) {
  const clip = clips[c];
  const m = media[clip.mediaId];
  const L = clip.outPoint - clip.inPoint;
  const isExtra = c > to;

  args.push("-ss", f(clip.inPoint), "-t", isExtra ? f(D) : f(L), "-i", m.path);
  const i = idx++;

  const head = c > 0 ? D : 0;
  const tail = c < n - 1 ? D : 0;
  // The head of a chunk's first clip is consumed by the previous chunk's last
  // transition, so it is offset out of the body but never rendered here.
  const emitHead = head > 0 && c > from;
  const parts = [];
  if (emitHead) parts.push(`h${c}`);
  if (!isExtra) {
    parts.push(`b${c}`);
    if (tail > 0) parts.push(`t${c}`);
  }

  const fan = parts.length > 1 ? `,split=${parts.length}` : "";
  const afan = parts.length > 1 ? `,asplit=${parts.length}` : "";
  graph.push(
    `[${i}:v:0]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,settb=AVTB${fan}` +
      parts.map((p) => `[s${p}]`).join("")
  );
  graph.push(
    `[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `asetpts=PTS-STARTPTS${afan}` +
      parts.map((p) => `[sa${p}]`).join("")
  );

  if (emitHead) {
    graph.push(`[sh${c}]trim=start=0:end=${f(head)},setpts=PTS-STARTPTS,format=yuv444p[vh${c}]`);
    graph.push(`[sah${c}]atrim=start=0:end=${f(head)},asetpts=PTS-STARTPTS[ah${c}]`);
  }
  if (isExtra) continue;

  graph.push(
    `[sb${c}]trim=start=${f(head)}:end=${f(L - tail)},setpts=PTS-STARTPTS,format=yuv420p[vb${c}]`
  );
  graph.push(`[sab${c}]atrim=start=${f(head)}:end=${f(L - tail)},asetpts=PTS-STARTPTS[ab${c}]`);
  if (tail > 0) {
    graph.push(
      `[st${c}]trim=start=${f(L - tail)}:end=${f(L)},setpts=PTS-STARTPTS,format=yuv444p[vt${c}]`
    );
    graph.push(`[sat${c}]atrim=start=${f(L - tail)}:end=${f(L)},asetpts=PTS-STARTPTS[at${c}]`);
  }

  pieces.push([`vb${c}`, `ab${c}`]);
  if (c < n - 1) {
    graph.push(
      `[vt${c}][vh${c + 1}]xfade=transition=fade:duration=${f(D)}:offset=0,format=yuv420p[vx${c}]`
    );
    graph.push(`[at${c}][ah${c + 1}]acrossfade=d=${f(D)}:c1=tri:c2=tri[ax${c}]`);
    pieces.push([`vx${c}`, `ax${c}`]);
  }
}

graph.push(
  pieces.map(([v, a]) => `[${v}][${a}]`).join("") +
    `concat=n=${pieces.length}:v=1:a=1[vout][aout]`
);

fs.writeFileSync(scriptPath, graph.join(";\n"));
args.push("-/filter_complex", scriptPath);
args.push("-map", "[vout]", "-map", "[aout]");
args.push(
  "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19",
  "-b:v", "45M", "-maxrate", "68M", "-bufsize", "136M", "-profile:v", "high",
  "-pix_fmt", "yuv420p", "-bf", "3", "-b_ref_mode", "middle", "-rc-lookahead", "20",
  "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "1", "-g", "120",
  "-c:a", "pcm_s16le", "-ar", "48000"
);
args.push(out);

process.stderr.write(`chunk ${from}..${to}: ${pieces.length} pieces, ${idx} inputs\n`);
process.stdout.write(args.join("\n"));
