import * as ipc from "@/lib/ipc";
import { pickAudioFile } from "@/lib/import";
import { useEditor } from "@/state/projectStore";

/** Quiet enough to sit under clip audio without fighting it. */
export const DEFAULT_MUSIC_VOLUME = 0.18;

export async function chooseMusic(): Promise<void> {
  const path = await pickAudioFile();
  if (!path) return;

  const store = useEditor.getState();
  store.setBusy("Reading music track…");
  try {
    const info = await ipc.probeMusic(path);
    useEditor.getState().setMusic({
      path: info.path,
      fileName: info.fileName,
      duration: info.duration,
      volume: DEFAULT_MUSIC_VOLUME,
      fadeIn: 2.0,
      fadeOut: 3.0,
      startOffset: 0,
      loopToFit: false,
    });
  } catch (e) {
    useEditor.getState().showToast("error", `Could not read that audio file: ${e}`);
  } finally {
    useEditor.getState().setBusy(null);
  }
}
