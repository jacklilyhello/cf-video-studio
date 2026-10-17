import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upload } from "../container/processor.mjs";

const originalFetch = globalThis.fetch;
const fixtures = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function setup(mode, mutateReceipt = (receipt) => receipt) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cf-video-upload-test-"),
  );
  // Synthetic bytes exercise only upload transport; no media tools are invoked.
  const segment = Buffer.alloc(8 * 1024 * 1024, 0x47);
  const manifest = Buffer.from(
    "#EXTM3U\n#EXTINF:6,\nsegment-000000.ts\n#EXT-X-ENDLIST\n",
  );
  const expected = new Map([
    ["segment-000000.ts", { bytes: segment.length, sha256: digest(segment) }],
    ["index.m3u8", { bytes: manifest.length, sha256: digest(manifest) }],
  ]);
  await writeFile(path.join(directory, "segment-000000.ts"), segment);
  await writeFile(path.join(directory, "index.m3u8"), manifest);
  const stored = new Map(mode === "duplicate" ? expected : []);
  const attempts = [];
  const events = [];
  let completions = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.url.startsWith("/output/")) {
        const name = request.url.slice("/output/".length);
        const object = expected.get(name);
        const attempt = { name, received: 0, closed: false };
        attempts.push(attempt);
        request.on("close", () => {
          attempt.closed = true;
        });
        const duplicate = stored.has(name);
        const receipt = mutateReceipt({
          stored: true,
          duplicate,
          name,
          ...object,
        });
        if (mode === "conflict") {
          request.resume();
          response.writeHead(409).end('{"error":"output_conflict"}');
          return;
        }
        if (duplicate || mode === "premature-new") {
          request.on("data", (chunk) => {
            attempt.received += chunk.length;
          });
          response
            .writeHead(200, {
              "Content-Type": "application/json",
            })
            .end(JSON.stringify(receipt));
          return;
        }
        const hash = createHash("sha256");
        for await (const chunk of request) {
          attempt.received += chunk.length;
          hash.update(chunk);
        }
        if (
          attempt.received !== object.bytes ||
          hash.digest("hex") !== object.sha256 ||
          request.headers["x-content-sha256"] !== object.sha256
        ) {
          response.writeHead(409).end('{"error":"object_mismatch"}');
          return;
        }
        stored.set(name, object);
        if (mode === "lost-ack" && attempts.length === 1) {
          // Storage committed, but the caller never receives its first receipt.
          response.destroy();
          return;
        }
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(receipt));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/event") events.push(value);
      else if (request.url === "/complete") completions++;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"recorded":true}');
    })().catch(() => response.destroy());
  });
  const fixture = {
    directory,
    server,
    expected,
    stored,
    attempts,
    events,
    get completions() {
      return completions;
    },
  };
  fixtures.push(fixture);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  vi.stubGlobal("fetch", (url, options) =>
    originalFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options),
  );
  const controller = new AbortController();
  fixture.run = () =>
    upload(
      {
        task: { maxOutputBytes: segment.length + manifest.length },
        controller,
        signal: controller.signal,
        lastEvent: 0,
      },
      directory,
      {
        segments: [{ name: "segment-000000.ts" }],
        durationSeconds: 6,
        validation: {},
      },
    );
  return fixture;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) {
    fixture.server.closeAllConnections();
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("Container upload receipts over local HTTP", () => {
  it("requires full transfer and matching storage receipts for new objects", async () => {
    const fixture = await setup("new");
    await fixture.run();
    expect(fixture.completions).toBe(1);
    expect(fixture.attempts).toHaveLength(2);
    for (const attempt of fixture.attempts)
      expect(attempt.received).toBe(fixture.expected.get(attempt.name).bytes);
    expect(fixture.stored).toEqual(fixture.expected);
  });

  it("accepts a verified duplicate early and stops sending its redundant body", async () => {
    const fixture = await setup("duplicate");
    await fixture.run();
    expect(fixture.completions).toBe(1);
    expect(fixture.attempts).toHaveLength(2);
    const segmentAttempt = fixture.attempts[0];
    expect(segmentAttempt.received).toBeLessThan(
      fixture.expected.get(segmentAttempt.name).bytes,
    );
    const progress = fixture.events.filter(
      (event) => event.stage === "uploading",
    );
    expect(progress[0].bytes).toBe(0);
    expect(progress.at(-1)).toMatchObject({
      bytes: [...fixture.expected.values()].reduce(
        (sum, object) => sum + object.bytes,
        0,
      ),
      progressBasis: "persisted-bytes",
    });
    expect(
      progress.every((event) => event.progressBasis === "persisted-bytes"),
    ).toBe(true);
    expect(
      progress.every(
        (event) => !("sentBytes" in event) && !("networkBytes" in event),
      ),
    ).toBe(true);
  });

  it("recovers a lost first receipt through an early verified duplicate receipt", async () => {
    const fixture = await setup("lost-ack");
    await fixture.run();
    expect(fixture.completions).toBe(1);
    const segmentAttempts = fixture.attempts.filter(
      (attempt) => attempt.name === "segment-000000.ts",
    );
    expect(segmentAttempts).toHaveLength(2);
    expect(segmentAttempts[0].received).toBe(
      fixture.expected.get("segment-000000.ts").bytes,
    );
    expect(segmentAttempts[1].received).toBeLessThan(
      segmentAttempts[0].received,
    );
    expect(fixture.stored).toEqual(fixture.expected);
  });

  it("does not accept a premature new-object receipt without a complete body", async () => {
    const fixture = await setup("premature-new");
    await expect(fixture.run()).rejects.toThrow("Output upload was incomplete");
    expect(fixture.attempts).toHaveLength(3);
    expect(fixture.completions).toBe(0);
    expect(fixture.events.every((event) => event.bytes === 0)).toBe(true);
  });

  it("never treats a changed-content failure response as a duplicate success", async () => {
    const fixture = await setup("conflict");
    await expect(fixture.run()).rejects.toThrow(
      "Task bridge rejected output (409)",
    );
    expect(fixture.attempts).toHaveLength(3);
    expect(fixture.completions).toBe(0);
    expect(fixture.events.every((event) => event.bytes === 0)).toBe(true);
  });

  it.each(["name", "bytes", "sha256", "stored", "duplicate"])(
    "rejects a duplicate receipt with a mismatching or invalid %s",
    async (field) => {
      const fixture = await setup("duplicate", (receipt) => ({
        ...receipt,
        [field]:
          field === "bytes"
            ? receipt.bytes + 1
            : field === "stored"
              ? false
              : "wrong",
      }));
      await expect(fixture.run()).rejects.toThrow(
        "Output storage acknowledgment differs",
      );
      expect(fixture.attempts).toHaveLength(3);
      expect(fixture.completions).toBe(0);
      expect(fixture.events.every((event) => event.bytes === 0)).toBe(true);
    },
  );
});
