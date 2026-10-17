import type { SourceCheck } from "./client";
import {
  FragmentedPlaybackError,
  normalizeFragmentedMedia,
  parseFragmentedPlaybackPlan,
  readFragmentedFooter,
} from "./source-fragmented-mp4";

// These are browser memory/network bounds, independent of paid processing.
const MAX_FRAGMENT_BYTES = 16 * 1024 ** 2;
const MAX_RESIDENT_BYTES = 32 * 1024 ** 2;
const REQUEST_MS = 30000;
const BUFFER_OPERATION_MS = 15000;
class PlaybackFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class UnsupportedPlayback extends Error {}
const abortError = () => new DOMException("Aborted", "AbortError");

async function cancellable<T>(promise: Promise<T>, signal: AbortSignal) {
  void promise.catch(() => {});
  if (signal.aborted) throw abortError();
  let cancel!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        cancel = () => reject(abortError());
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function readSourcePlaybackRange(
  input: { url: string; sourceEtag: string; sourceBytes: number },
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !/^\/(?:api\/admin\/source\/[A-Za-z0-9_-]+|media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)\/source\.mp4$/.test(
      input.url,
    ) ||
    !input.sourceEtag ||
    /[\s"\r\n]/.test(input.sourceEtag) ||
    !Number.isSafeInteger(input.sourceBytes) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    length > MAX_FRAGMENT_BYTES ||
    offset + length > input.sourceBytes
  )
    throw new PlaybackFailure("source_mse_range");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, REQUEST_MS);
  let response: Response | undefined;
  let reader: ReadableStreamBYOBReader | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      if (reader) void reader.cancel().catch(() => {});
      else void response?.body?.cancel().catch(() => {});
    } catch {}
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const received = await cancellable<Response>(
      fetch(input.url, {
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      }).then((value) => {
        if (controller.signal.aborted)
          void value.body?.cancel().catch(() => {});
        return value;
      }),
      controller.signal,
    );
    response = received;
    if (controller.signal.aborted) throw abortError();
    if (
      received.redirected ||
      received.status !== 206 ||
      received.headers.get("ETag") !== `"${input.sourceEtag}"` ||
      received.headers.get("Content-Length") !== String(length) ||
      received.headers.get("Content-Range") !==
        `bytes ${offset}-${offset + length - 1}/${input.sourceBytes}` ||
      received.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "video/mp4" ||
      !received.body
    )
      throw new PlaybackFailure("source_mse_identity");
    try {
      reader = received.body.getReader({ mode: "byob" });
    } catch {
      throw new UnsupportedPlayback();
    }
    const bytes = new Uint8Array(length);
    let receivedBytes = 0;
    while (receivedBytes < length) {
      const next = await cancellable(
        reader.read(new Uint8Array(length - receivedBytes)),
        controller.signal,
      );
      if (controller.signal.aborted) throw abortError();
      if (next.value?.byteLength) {
        if (receivedBytes + next.value.byteLength > length)
          throw new PlaybackFailure("source_mse_range");
        bytes.set(next.value, receivedBytes);
        receivedBytes += next.value.byteLength;
      }
      if (next.done && receivedBytes < length)
        throw new PlaybackFailure("source_mse_body");
    }
    return bytes;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (
      error instanceof UnsupportedPlayback ||
      error instanceof PlaybackFailure
    )
      throw error;
    throw new PlaybackFailure(
      controller.signal.aborted ? "source_mse_timeout" : "source_mse_transport",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cancel);
    cancel();
  }
}

function eventOperation(
  target: EventTarget,
  event: string,
  signal: AbortSignal,
  action?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (failure?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(event, ready);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      failure ? reject(failure) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new PlaybackFailure("source_mse_buffer"));
    const aborted = () => finish(abortError());
    const timer = setTimeout(
      () => finish(new PlaybackFailure("source_mse_buffer_timeout")),
      BUFFER_OPERATION_MS,
    );
    target.addEventListener(event, ready, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      action?.();
    } catch {
      failed();
    }
  });
}

export async function attachFragmentedSourcePlayer(
  element: HTMLVideoElement,
  input: {
    url: string;
    probe: SourceCheck["probe"];
    sourceEtag: string;
    sourceBytes: number;
    durationSeconds: number;
    signal: AbortSignal;
    onFatal: (code: string) => void;
  },
): Promise<{ kind: "mse"; dispose: () => void } | { kind: "unsupported" }> {
  const probe = input.probe;
  if (
    typeof MediaSource === "undefined" ||
    !probe?.fragmented ||
    !probe.fragmented.randomAccessIndex?.entries ||
    probe.index?.placement !== "before-media" ||
    !Number.isSafeInteger(probe.index.moovOffset) ||
    !Number.isSafeInteger(probe.index.moovBytes) ||
    probe.index.moovOffset! + probe.index.moovBytes! > 256 * 1024
  )
    return { kind: "unsupported" };
  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  input.signal.addEventListener("abort", parentAbort, { once: true });
  if (input.signal.aborted) controller.abort();
  let media: MediaSource | undefined;
  let buffer: SourceBuffer | undefined;
  let objectUrl: string | undefined;
  let request: AbortController | undefined;
  let closed = false;
  let epoch = 0;
  let requested = false;
  let pumping = false;
  const loaded = new Set<number>();
  const dispose = () => {
    if (closed) return;
    closed = true;
    epoch++;
    controller.abort();
    request?.abort();
    input.signal.removeEventListener("abort", parentAbort);
    element.removeEventListener("seeking", seek);
    element.removeEventListener("timeupdate", schedule);
    element.removeEventListener("waiting", schedule);
    element.removeEventListener("play", schedule);
    try {
      if (buffer?.updating && media?.readyState === "open") buffer.abort();
    } catch {}
    if (objectUrl) {
      if (element.getAttribute("src") === objectUrl) {
        element.removeAttribute("src");
        element.load();
      }
      URL.revokeObjectURL(objectUrl);
    }
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  const fatal = (code: string) => {
    if (closed || input.signal.aborted) return;
    dispose();
    input.onFatal(code);
  };
  let plan: ReturnType<typeof parseFragmentedPlaybackPlan>;
  function schedule() {
    if (closed) return;
    requested = true;
    if (!pumping) void pump();
  }
  function seek() {
    epoch++;
    request?.abort();
    schedule();
  }
  async function mutate(action: () => void) {
    if (closed || !buffer || !media || media.readyState === "closed")
      throw abortError();
    await eventOperation(buffer, "updateend", controller.signal, action);
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (requested && !closed) {
        requested = false;
        const generation = epoch;
        const position = Number.isFinite(element.currentTime)
          ? element.currentTime
          : 0;
        if (element.ended) continue;
        const found = plan.fragments.findIndex((f) => position < f.endSeconds);
        const target = found < 0 ? plan.fragments.length - 1 : found;
        const first = plan.fragments[target];
        // Trim both sides on seeks. Never retain the entire encoded original.
        const keepStart =
          plan.fragments.find((f) => f.endSeconds > Math.max(0, position - 10))
            ?.startSeconds ?? 0;
        const keepEnd =
          plan.fragments.find((f) => f.endSeconds >= position + 30)
            ?.endSeconds ?? plan.durationSeconds;
        if (buffer!.buffered.length && buffer!.buffered.start(0) < keepStart)
          await mutate(() => buffer!.remove(0, keepStart));
        if (
          buffer!.buffered.length &&
          buffer!.buffered.end(buffer!.buffered.length - 1) > keepEnd
        )
          await mutate(() => buffer!.remove(keepEnd, plan.durationSeconds + 1));
        for (const index of loaded) {
          const f = plan.fragments[index];
          if (f.startSeconds < keepStart || f.endSeconds > keepEnd)
            loaded.delete(index);
        }
        let resident = [...loaded].reduce(
          (total, index) => total + plan.fragments[index].length,
          0,
        );
        let reachedTail = false;
        for (
          let index = target;
          index < plan.fragments.length && !closed;
          index++
        ) {
          const fragment = plan.fragments[index];
          if (generation !== epoch) {
            requested = true;
            break;
          }
          if (
            index > target &&
            fragment.startSeconds > position + (element.paused ? 8 : 20)
          )
            break;
          if (loaded.has(index)) {
            // The UA may evict coded frames under memory pressure. Our ledger
            // is not evidence that the corresponding buffer still exists.
            const tolerance = Math.min(
              0.25,
              (fragment.endSeconds - fragment.startSeconds) / 4,
            );
            const isTail = index === plan.fragments.length - 1;
            // An open MSE buffer exposes the intersection of its tracks. The
            // shorter verified track may end before the complete audio tail.
            // At EOF allow only timestamp rounding, not a missing coded tail.
            const requiredEnd = isTail
              ? Math.min(
                  ...probe!.fragmented!.tracks.map(
                    (track) => track.presentationEndSeconds,
                  ),
                )
              : fragment.endSeconds;
            const endTolerance = isTail ? 0.00001 : tolerance;
            let present = false;
            for (let n = 0; n < buffer!.buffered.length; n++) {
              if (
                buffer!.buffered.start(n) <=
                  fragment.startSeconds + tolerance &&
                buffer!.buffered.end(n) >= requiredEnd - endTolerance
              )
                present = true;
            }
            if (present && index === target) {
              // Permit only the proof's genuine initial A/V start offset, not
              // a later UA-evicted prefix that happens to be within tolerance.
              const streamStart = Math.max(
                0,
                ...probe!.fragmented!.tracks.map(
                  (t) => t.presentationStartSeconds,
                ),
              );
              const point = isTail
                ? Math.min(
                    Math.max(position, streamStart),
                    requiredEnd - endTolerance,
                  )
                : Math.max(position, streamStart);
              let positionPresent = false;
              for (let n = 0; n < buffer!.buffered.length; n++) {
                if (
                  buffer!.buffered.start(n) <= point &&
                  buffer!.buffered.end(n) > point
                )
                  positionPresent = true;
              }
              present = positionPresent;
            }
            if (present) {
              reachedTail = index === plan.fragments.length - 1;
              continue;
            }
            await mutate(() =>
              buffer!.remove(fragment.startSeconds, fragment.endSeconds),
            );
            loaded.delete(index);
            resident -= fragment.length;
          }
          if (resident + fragment.length > MAX_RESIDENT_BYTES) {
            // A byte cap must not deadlock playback by retaining ten seconds
            // of large, already-played fragments while the next one is needed.
            const expired = [...loaded].filter(
              (n) => plan.fragments[n].endSeconds <= first.startSeconds,
            );
            if (expired.length && first.startSeconds > 0) {
              await mutate(() => buffer!.remove(0, first.startSeconds));
              for (const n of expired) {
                resident -= plan.fragments[n].length;
                loaded.delete(n);
              }
            }
            if (resident + fragment.length > MAX_RESIDENT_BYTES) {
              if (index > target) break;
              await mutate(() => buffer!.remove(0, plan.durationSeconds + 1));
              loaded.clear();
              resident = 0;
            }
          }
          if (generation !== epoch) {
            requested = true;
            break;
          }
          request = new AbortController();
          const abortRequest = () => request?.abort();
          controller.signal.addEventListener("abort", abortRequest, {
            once: true,
          });
          let bytes: Uint8Array;
          try {
            bytes = await readSourcePlaybackRange(
              input,
              fragment.offset,
              fragment.length,
              request.signal,
            );
          } catch (error) {
            if (generation !== epoch && !closed) {
              requested = true;
              break;
            }
            throw error;
          } finally {
            controller.signal.removeEventListener("abort", abortRequest);
          }
          if (closed) return;
          if (generation !== epoch) {
            requested = true;
            break;
          }
          const normalized = normalizeFragmentedMedia(bytes, fragment, plan);
          await mutate(() => buffer!.appendBuffer(normalized as BufferSource));
          loaded.add(index);
          resident += fragment.length;
          reachedTail = index === plan.fragments.length - 1;
        }
        // Removing old frames reopens an ended MediaSource. Reassert EOS only
        // after this generation has checked/appended every needed tail fragment
        // and all mutations have finished, including the already-buffered path.
        if (
          reachedTail &&
          generation === epoch &&
          !closed &&
          !buffer!.updating &&
          media!.readyState === "open"
        )
          media!.endOfStream();
        if (!first) throw new PlaybackFailure("source_mse_index");
      }
    } catch (error) {
      if (!closed && !input.signal.aborted)
        fatal(
          error instanceof PlaybackFailure ? error.code : "source_mse_media",
        );
    } finally {
      pumping = false;
      if (requested && !closed) schedule();
    }
  }
  try {
    const [prefix, footer] = await Promise.all([
      readSourcePlaybackRange(
        input,
        0,
        probe.index.moovOffset! + probe.index.moovBytes!,
        controller.signal,
      ),
      readSourcePlaybackRange(
        input,
        input.sourceBytes - 16,
        16,
        controller.signal,
      ),
    ]);
    let index: ReturnType<typeof readFragmentedFooter>;
    try {
      index = readFragmentedFooter(footer, input.sourceBytes);
    } catch (error) {
      if (error instanceof FragmentedPlaybackError)
        throw new UnsupportedPlayback();
      throw error;
    }
    const mfra = await readSourcePlaybackRange(
      input,
      index.offset,
      index.length,
      controller.signal,
    );
    try {
      plan = parseFragmentedPlaybackPlan({
        prefix,
        mfra,
        totalBytes: input.sourceBytes,
        proof: { ...probe, compatible: true },
      });
    } catch {
      throw new UnsupportedPlayback();
    }
    if (!MediaSource.isTypeSupported(plan.mimeType))
      throw new UnsupportedPlayback();
    if (controller.signal.aborted) throw abortError();
    media = new MediaSource();
    objectUrl = URL.createObjectURL(media);
    await eventOperation(media, "sourceopen", controller.signal, () => {
      element.src = objectUrl!;
    });
    if (closed) throw abortError();
    media.duration = plan.durationSeconds;
    buffer = media.addSourceBuffer(plan.mimeType);
    await mutate(() => buffer!.appendBuffer(plan.init as BufferSource));
    if (closed) throw abortError();
    element.addEventListener("seeking", seek);
    element.addEventListener("timeupdate", schedule);
    element.addEventListener("waiting", schedule);
    element.addEventListener("play", schedule);
    schedule();
    return { kind: "mse", dispose };
  } catch (error) {
    dispose();
    if (input.signal.aborted) throw abortError();
    if (error instanceof UnsupportedPlayback && !objectUrl)
      return { kind: "unsupported" };
    throw new PlaybackFailure(
      error instanceof PlaybackFailure
        ? error.code
        : "source_mse_initialization",
    );
  }
}
