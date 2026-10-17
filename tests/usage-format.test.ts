import { expect, it } from "vitest";
import { formatUsage, usageUnitNote } from "../web/usage-format";
it("converts byte observations and all allowance/ledger values without changing raw calculations", () => {
  expect(formatUsage(1083907052, "bytes")).toBe("1.0095 GiB");
  expect(formatUsage(1024 ** 2, "bytes")).toBe("1 MiB");
  expect(formatUsage(0, "bytes")).toBe("0 B");
  expect(formatUsage(null, "bytes")).toBe("无法确认");
  expect(formatUsage(Number.NaN, "rows")).toBe("无法确认");
});
it("distinguishes binary memory and decimal disk time products from elapsed runtime", () => {
  expect(
    formatUsage(1024 ** 3 * 3600, "byte-seconds", "containerMemoryByteSeconds"),
  ).toBe("1 GiB·小时");
  expect(
    formatUsage(1e9 * 3600, "byte-seconds", "containerDiskByteSeconds"),
  ).toBe("1 GB·小时");
  expect(formatUsage(3600, "gib-seconds")).toBe("1 GiB·小时");
  expect(formatUsage(3600, "gb-seconds")).toBe("1 GB·小时");
  expect(usageUnitNote("byte-seconds")).toContain("不是实际运行时长");
  expect(formatUsage(1, "byte-seconds", "containerMemoryByteSeconds")).not.toBe(
    "0 GiB·小时",
  );
});
it("renders CPU/time and count metrics in readable units while preserving a known zero", () => {
  expect(formatUsage(60000, "milliseconds")).toBe("1 分钟");
  expect(formatUsage(500, "milliseconds")).toBe("0.5 秒");
  expect(formatUsage(3600, "vCPU-seconds")).toBe("1 vCPU·小时");
  expect(formatUsage(120, "vCPU-seconds")).toBe("2 vCPU·分钟");
  expect(formatUsage(0, "requests")).toBe("0 次");
  expect(formatUsage(5, "rows")).toBe("5 行");
  expect(formatUsage(12, "events")).toBe("12 条");
});
