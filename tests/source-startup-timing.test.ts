import { expect, it } from "vitest";
import {
  createSourceStartupTiming,
  type SourceStartupTiming,
} from "../web/sourceStartupTiming";

it("records only actual first stage observations from a monotonic player baseline", () => {
  let now = 100;
  const updates: SourceStartupTiming[] = [];
  const timing = createSourceStartupTiming(
    (value) => updates.push(value),
    () => now,
  );
  expect(updates[0]).toEqual({
    initializedMs: 0,
    loadedMetadataMs: null,
    loadedDataMs: null,
    canPlayMs: null,
    firstPlayingMs: null,
    playRequestedMs: null,
    firstFrameMs: null,
  });
  for (const [event, at] of [
    ["loadedmetadata", 250],
    ["loadeddata", 270],
    ["canplay", 300],
    ["play", 1000],
    ["playing", 1100],
    ["frame", 1110],
  ] as const) {
    now = at;
    timing.mark(event);
  }
  expect(updates.at(-1)).toEqual({
    initializedMs: 0,
    loadedMetadataMs: 150,
    loadedDataMs: 170,
    canPlayMs: 200,
    playRequestedMs: 900,
    firstPlayingMs: 1000,
    firstFrameMs: 1010,
  });
  expect(updates[0].firstPlayingMs).toBeNull();
  now = 2000;
  timing.mark("playing");
  expect(updates).toHaveLength(7);
  timing.close();
  now = 3000;
  timing.mark("canplay");
  expect(updates).toHaveLength(7);
});

it("does not invent a stage for an invalid clock and retires callbacks on close", () => {
  let now = 100;
  const updates: SourceStartupTiming[] = [];
  const timing = createSourceStartupTiming(
    (value) => updates.push(value),
    () => now,
  );
  now = 200;
  timing.mark("loadedmetadata");
  now = 150;
  timing.mark("loadeddata");
  expect(updates.at(-1)).toMatchObject({
    loadedMetadataMs: 100,
    loadedDataMs: 100,
    canPlayMs: null,
  });
  now = NaN;
  timing.mark("canplay");
  expect(updates).toHaveLength(3);
  timing.close();
  now = 400;
  timing.mark("playing");
  expect(updates).toHaveLength(3);
  const fresh: SourceStartupTiming[] = [];
  createSourceStartupTiming(
    (value) => fresh.push(value),
    () => now,
  );
  expect(fresh[0].firstPlayingMs).toBeNull();
});
