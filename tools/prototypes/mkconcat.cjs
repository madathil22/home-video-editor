// Prototype: the whole timeline as one filtergraph joined with the concat
// filter, feeding a single NVENC encoder. Emits an ffmpeg argument list (one
// argument per line) so it can be timed against the segmented exporter.
const fs = require("fs");

const proj = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];
const { width: W, height: H, fps: FPS } = proj.settings;
const D = proj.defaultTransition.duration;

const media = Object.fromEntries(proj.media.map((m) => [m.id, m]));
const clips = proj.timeline;
const n = clips.length;

const args = ["-hide_banner", "-y"];
const graph = [];
const pieces = [];
let idx = 0;

const addInput = (path, start, dur) => {
  args.push("-ss", start.toFixed(6), "-t", dur.toFixed(6), "-i", path);
  return idx++;
};

const vnorm = (i, label, dur, pix) =>
  graph.push(
    `[${i}:v:0]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,` +
      `trim=start=0:end=${dur.toFixed(6)},setpts=PTS-STARTPTS,format=${pix},settb=AVTB[${label}]`
  );

const anorm = (i, label, dur) =>
  graph.push(
    `[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `asetpts=PTS-STARTPTS,apad,atrim=start=0:end=${dur.toFixed(6)},asetpts=PTS-STARTPTS[${label}]`
  );

for (let c = 0; c < n; c++) {
  const clip = clips[c];
  const m = media[clip.mediaId];
  const head = c > 0 ? D : 0; // eaten by the previous transition
  const tail = c < n - 1 ? D : 0; // eaten by the next transition
  const bodyStart = clip.inPoint + head;
  const bodyLen = clip.outPoint - clip.inPoint - head - tail;

  const i = addInput(m.path, bodyStart, bodyLen);
  vnorm(i, `vb${c}`, bodyLen, "yuv420p");
  anorm(i, `ab${c}`, bodyLen);
  pieces.push([`vb${c}`, `ab${c}`]);

  if (c < n - 1) {
    const nx = clips[c + 1];
    const nm = media[nx.mediaId];
    const ia = addInput(m.path, clip.outPoint - D, D);
    const ib = addInput(nm.path, nx.inPoint, D);
    vnorm(ia, `xa${c}`, D, "yuv444p");
    vnorm(ib, `xb${c}`, D, "yuv444p");
    graph.push(
      `[xa${c}][xb${c}]xfade=transition=fade:duration=${D.toFixed(6)}:offset=0,format=yuv420p[vt${c}]`
    );
    anorm(ia, `aa${c}`, D);
    anorm(ib, `az${c}`, D);
    graph.push(`[aa${c}][az${c}]acrossfade=d=${D.toFixed(6)}:c1=tri:c2=tri[at${c}]`);
    pieces.push([`vt${c}`, `at${c}`]);
  }
}

graph.push(
  pieces.map(([v, a]) => `[${v}][${a}]`).join("") +
    `concat=n=${pieces.length}:v=1:a=1[vout][aout]`
);

args.push("-filter_complex", graph.join(";"));
args.push("-map", "[vout]", "-map", "[aout]");
args.push(
  "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19",
  "-b:v", "45M", "-maxrate", "68M", "-bufsize", "136M", "-profile:v", "high",
  "-pix_fmt", "yuv420p", "-bf", "3", "-b_ref_mode", "middle", "-rc-lookahead", "20",
  "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "1", "-g", "120",
  "-c:a", "aac", "-b:a", "384k", "-movflags", "+faststart"
);
args.push(out);

process.stderr.write(`${pieces.length} pieces, ${idx} inputs\n`);
process.stdout.write(args.join("\n"));
