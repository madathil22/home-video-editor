# Third-party notices

## FFmpeg

The installer bundles `ffmpeg.exe` and `ffprobe.exe`. These are **not** built
from this repository. They are redistributed unmodified from the
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) project:

| | |
|---|---|
| Build | `ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1` |
| Release tag | [`autobuild-2026-09-03-13-17`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-03-13-17) |
| Configuration | `win64-gpl` |
| Licence | **GPL v3** |

This is a **GPL** build (it includes `libx264`, which the app uses as its CPU
fallback when no NVIDIA encoder is available). Redistributing it carries GPL
obligations: the corresponding source must be available to anyone who receives
the binary. That source is the upstream FFmpeg tree at commit `1a748fe2cd`,
together with the build scripts in the BtbN repository linked above, both of
which are public.

If you would rather not carry GPL obligations, the `win64-lgpl` build from the
same release is a drop-in replacement — NVENC is present in every FFmpeg build
variant and is not GPL-gated. The tradeoff is that the LGPL build has no
`libx264`, so machines without an NVIDIA GPU would lose the software-encoding
fallback. Change the `$Asset` name in `tools/fetch-ffmpeg.ps1` to switch.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Application code

Everything else in this repository is MIT licensed — see [LICENSE](LICENSE).
FFmpeg is invoked as a separate process over its command-line interface and is
not linked into the application, so the two licences do not mix.
