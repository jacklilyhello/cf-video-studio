import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Leave time for the bounded Python runner to exit and report its assertions
// under shared CI load; Vitest's default 5 seconds is shorter than that runner.
it(
  "checks Builds pagination and trigger behavior using isolated Python state and fake HTTP",
  { timeout: 20000 },
  () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-B",
        fileURLToPath(new URL("./builds-pagination.test.py", import.meta.url)),
      ],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          // Build-image runtime launchers may need their installation home.
          // Keep credentials out of the child and isolate Python user settings.
          HOME: process.env.HOME,
        },
      },
    );
    expect(
      result.error,
      `Python regression runner failed or timed out:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    ).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("OK");
  },
);
