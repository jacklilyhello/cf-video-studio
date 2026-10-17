import { expect, it, vi } from "vitest";
import { fingerprintFile } from "../web/Uploads";

it("changes identity for changed middle bytes with identical filename, length, mtime and edge chunks", async () => {
  const chunk = 8 * 1024 * 1024;
  const first = new Uint8Array(chunk);
  const middle = new Uint8Array(chunk);
  const last = new Uint8Array(chunk);
  const original = new File([first, middle, last], "same.mp4", {
    lastModified: 1,
  });
  middle[chunk / 2] = 1;
  const changed = new File([first, middle, last], "same.mp4", {
    lastModified: 1,
  });
  const originalWholeRead = vi.spyOn(original, "arrayBuffer");
  const sizes: number[] = [];
  const slice = original.slice.bind(original);
  vi.spyOn(original, "slice").mockImplementation((...args) => {
    const part = slice(...args);
    sizes.push(part.size);
    return part;
  });
  const progress: number[] = [];
  const before = await fingerprintFile(original, (bytes) =>
    progress.push(bytes),
  );
  expect(await fingerprintFile(changed)).not.toBe(before);
  expect(originalWholeRead).not.toHaveBeenCalled();
  expect(sizes).toEqual([chunk, chunk, chunk]);
  expect(progress).toEqual([chunk, chunk * 2, chunk * 3]);
});

it("retains identical full-file identity on reselection and stops hashing promptly when paused", async () => {
  const first = new File(["same bytes"], "same.mp4", { lastModified: 1 });
  const second = new File(["same bytes"], "same.mp4", { lastModified: 1 });
  expect(await fingerprintFile(second)).toBe(await fingerprintFile(first));
  const controller = new AbortController();
  controller.abort();
  const read = vi.spyOn(first, "slice");
  await expect(
    fingerprintFile(first, undefined, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(read).not.toHaveBeenCalled();
});
