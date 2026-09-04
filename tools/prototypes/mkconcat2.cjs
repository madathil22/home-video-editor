// Prototype 2: one input per clip, split into head/body/tail, joined with the
// concat filter into a single NVENC encode. Writes the filtergraph to a script
// file so the command line stays short.
const fs = require("fs");

const proj = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];
const scriptPath = process.argv[4];
const { width: W, height: H, fps: FPS } = proj.settings;
const D = proj.defaultTransition.duration;

const media = Object.fromEntries(proj.media.map((m) => [m.id, m]));
const clips = proj.timeline;
const n = clips.length;

const args = ["-hide_banner", "-y"];
const graph = [];
const pieces = [];
const f = (x) => x.toFixed(6);

for (let c = 0; c < n; c++) {
  const clip = clips[c];
  const m = media[clip.mediaId];
  const L = clip.outPoint - clip.inPoint;
  args.push("-ss", f(clip.inPoint), "-t", f(L), "-i", m.path);

  const head = c > 0 ? D : 0;
  const tail = c < n - 1 ? D : 0;

  // Shared work first: rate, size and timebase are normalised once per clip
  // instead of once per piece.
  const parts = [];
  if (head > 0) parts.push(`h${c}`);
  parts.push(`b${c}`);
  if (tail > 0) parts.push(`t${c}`);

  graph.push(
    `[${c}:v:0]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,settb=AVTB,` +
      `split=${parts.length}` +
      parts.map((p) => `[s${p}]`).join("")
  );
  graph.push(
    `[${c}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `asetpts=PTS-STARTPTS,asplit=${parts.length}` +
      parts.map((p) => `[sa${p}]`).join("")
  );

  // Pieces outside a branch's window are dropped by trim rather than buffered,
  // which is what keeps memory flat however long the timeline is.
  if (head > 0) {
    graph.push(`[sh${c}]trim=start=0:end=${f(head)},setpts=PTS-STARTPTS,format=yuv444p[vh${c}]`);
    graph.push(`[sah${c}]atrim=start=0:end=${f(head)},asetpts=PTS-STARTPTS[ah${c}]`);
  }
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
  "-c:a", "aac", "-b:a", "384k", "-movflags", "+faststart"
);
args.push(out);

const chars = args.reduce((s, a) => s + a.length + 3, 0);
process.stderr.write(`${pieces.length} pieces, ${n} inputs, command ${chars} chars\n`);
process.stdout.write(args.join("\n"));
