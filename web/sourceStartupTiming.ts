export type SourceStartupTiming = {
  initializedMs: 0;
  loadedMetadataMs: number | null;
  loadedDataMs: number | null;
  canPlayMs: number | null;
  firstPlayingMs: number | null;
  playRequestedMs: number | null;
  firstFrameMs: number | null;
};
type StartupEvent =
  "loadedmetadata" | "loadeddata" | "canplay" | "playing" | "play" | "frame";
const fields = {
  loadedmetadata: "loadedMetadataMs",
  loadeddata: "loadedDataMs",
  canplay: "canPlayMs",
  playing: "firstPlayingMs",
  play: "playRequestedMs",
  frame: "firstFrameMs",
} as const;

/** Measures first observations within one player lifetime, without polling. */
export function createSourceStartupTiming(
  onUpdate: (timing: SourceStartupTiming) => void,
  clock: () => number = () => performance.now(),
) {
  const started = clock();
  let closed = false,
    last = 0;
  const timing: SourceStartupTiming = {
    initializedMs: 0,
    loadedMetadataMs: null,
    loadedDataMs: null,
    canPlayMs: null,
    firstPlayingMs: null,
    playRequestedMs: null,
    firstFrameMs: null,
  };
  onUpdate({ ...timing });
  return {
    mark(event: StartupEvent) {
      const field = fields[event];
      if (closed || timing[field] !== null) return;
      const elapsed = clock() - started;
      if (!Number.isFinite(elapsed)) return;
      last = Math.max(last, 0, Math.round(elapsed));
      timing[field] = last;
      onUpdate({ ...timing });
    },
    close() {
      closed = true;
    },
  };
}
