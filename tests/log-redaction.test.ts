import { afterEach, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { log, redact } from "../src/logs";
import type { Env } from "../src/types";
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): unknown;
  };
  close(): void;
}
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => Database;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function setup(errorMessage?: string) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const env = {
    DB: {
      prepare(sql: string) {
        const prepared = native.prepare(sql);
        let values: unknown[] = [];
        const statement = {
          bind(...input: unknown[]) {
            values = input;
            return statement;
          },
          async first() {
            if (errorMessage && sql.includes("progress_interval_seconds"))
              throw new Error(errorMessage);
            return prepared.get(...values) ?? null;
          },
          async run() {
            return prepared.run(...values);
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, native };
}
it("redacts a real Worker unexpected-error message before D1 persistence while preserving the generic public response", async () => {
  const fake = "fictional-json-credential";
  const { env, native } = setup(
    JSON.stringify({
      token: fake,
      password: fake,
      apiKey: fake,
      context: "database unavailable",
    }),
  );
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request("https://redaction.example/api/config"),
    env,
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as ExecutionContext,
  );
  await Promise.all(pending);
  expect(response.status).toBe(500);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error).toEqual({
    code: "internal_error",
    message: "暂时无法完成请求，请稍后重试",
  });
  const row = native.prepare("SELECT stage,message FROM logs").get()!;
  expect(row.stage).toBe("request_error");
  expect(row.message).not.toContain(fake);
  expect(row.message).toContain("database unavailable");
  expect(row.message).toContain("[redacted]");
  const parsed = JSON.parse(String(row.message));
  expect(parsed.token).toBe("[redacted]");
  expect(parsed.password).toBe("[redacted]");
  expect(parsed.apiKey).toBe("[redacted]");
});
it("redacts API-key aliases, nested sensitive fields and embedded JSON in actual details_json writes", async () => {
  const { env, native } = setup();
  const fake = "fictional-detail-credential";
  await log(env, {
    stage: "offline-diagnostic",
    message: "safe diagnostic",
    details: {
      apiKey: fake,
      api_key: fake,
      "X-Api-Key": fake,
      nested: { SESSION_SECRET: fake, access_token: fake },
      note: JSON.stringify({ password: fake, operation: "probe" }),
      exitCode: 1,
    },
  });
  const row = native.prepare("SELECT details_json FROM logs").get()!;
  expect(row.details_json).not.toContain(fake);
  const details = JSON.parse(String(row.details_json));
  expect(details.apiKey).toBe("[redacted]");
  expect(details.api_key).toBe("[redacted]");
  expect(details["X-Api-Key"]).toBe("[redacted]");
  expect(details.note).toContain("probe");
  expect(details.exitCode).toBe(1);
});
it("redacts full Basic authorization and multi-cookie header values without removing the next diagnostic line", () => {
  const result = redact(
    "request failed\nAuthorization: Basic fictional-base64-credential\nCookie: visitor=fictional-first; session=fictional-second\nexit code: 1",
  );
  for (const value of [
    "fictional-base64-credential",
    "fictional-first",
    "fictional-second",
  ])
    expect(result).not.toContain(value);
  expect(result).toContain("Authorization: [redacted]");
  expect(result).toContain("Cookie: [redacted]");
  expect(result).toContain("exit code: 1");
});
it("handles quoted JSON and single-quoted diagnostic values, including spaces and escaped quotes", () => {
  const fake = "fictional quoted value";
  const result = redact(
    `${JSON.stringify({ password: `${fake} \"suffix`, refresh_token: fake })} secret='${fake}' api_key=${fake.split(" ")[0]}`,
  );
  expect(result).not.toContain("fictional");
  expect(result).not.toContain("suffix");
  expect(result).toContain("[redacted]");
});
it("preserves bounded useful diagnostics and URL paths while stripping credentials and query values", () => {
  const result = redact(
    "download https://fictional-user:fictional-password@example.invalid/media/file.mp4?token=fictional-query#fragment failed; exit=2",
  );
  expect(result).toContain("https://example.invalid/media/file.mp4");
  for (const value of [
    "fictional-user",
    "fictional-password",
    "fictional-query",
    "fragment",
  ])
    expect(result).not.toContain(value);
  expect(result).toContain("exit=2");
  expect(redact("diagnostic " + "x".repeat(2000))).toHaveLength(1500);
});
it("removes credentials from truncated quoted errors before actual D1 persistence", async () => {
  const { env, native } = setup();
  const fake = "fictional-truncated-credential";
  const truncated = JSON.stringify({ password: fake.repeat(20) }).slice(0, 256);
  await log(env, { stage: "truncated", message: truncated });
  expect(
    native.prepare("SELECT message FROM logs").get()!.message,
  ).not.toContain("fictional");
  for (const message of [
    `token='${fake}`,
    `password="${fake}\nexit code: 2`,
    `secret="${fake.repeat(1000)}`,
  ]) {
    expect(redact(message)).not.toContain("fictional");
    expect(redact(message)).toContain("[redacted]");
  }
  expect(redact(`password="${fake}\nexit code: 2`)).toContain("exit code: 2");
});
it("filters decoded JSON keys and entire sensitive objects while retaining ordinary diagnostics", async () => {
  const { env, native } = setup();
  const fake = "fictional-escaped-credential";
  const message = `{"\\u0074oken":"${fake}","password\\\"note":{"value":"${fake}"},"context":"retryable"}`;
  await log(env, { stage: "escaped", message });
  const saved = String(
    native.prepare("SELECT message FROM logs").get()!.message,
  );
  expect(saved).not.toContain(fake);
  expect(JSON.parse(saved)).toEqual({
    token: "[redacted]",
    'password"note': "[redacted]",
    context: "retryable",
  });
  expect(redact(`upstream {"\\u0074oken":"${fake}","code":7}`)).not.toContain(
    fake,
  );
});
it("bounds repeated key-shaped input and strips uppercase URL schemes", () => {
  expect(redact("token".repeat(10000) + "?")).toHaveLength(1500);
  const result = redact(
    "failed HTTPS://fictional-user:fictional-password@example.invalid/media/file.mp4?auth=fictional-query#fragment",
  );
  expect(result).toContain("https://example.invalid/media/file.mp4");
  expect(result).not.toContain("fictional");
});
it("removes quoted credentials when a truncated escape ends at the line or scan boundary", async () => {
  const { env, native } = setup();
  const fake = "fictional-dangling-escape";
  const slash = String.fromCharCode(92);
  const prefix = 'password="';
  for (const message of [
    `${prefix}${fake}${slash}`,
    `token='${fake}${slash}`,
    `upstream {"\\u0074oken":"${fake}${slash}`,
    `${prefix}${fake}${slash}\nexit code: 3`,
    prefix +
      fake +
      "x".repeat(16384 - prefix.length - fake.length - 1) +
      slash +
      '"',
  ]) {
    expect(redact(message)).not.toContain("fictional");
    expect(redact(message)).toContain("[redacted]");
    await log(env, { stage: "truncated-escape", message });
  }
  expect(redact(`${prefix}${fake}${slash}\nexit code: 3`)).toContain(
    "exit code: 3",
  );
  expect(
    native
      .prepare(
        "SELECT COUNT(*) AS n FROM logs WHERE message LIKE '%fictional%'",
      )
      .get()!.n,
  ).toBe(0);
});
