function number(value: number) {
  if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(2);
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
/** Display conversion only. Admission calculations always use the server's raw units. */
export function formatUsage(
  value: number | null | undefined,
  unit = "",
  metric = "",
) {
  if (value == null || !Number.isFinite(value)) return "无法确认";
  if (unit === "bytes") {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const scale = Math.min(
      4,
      Math.max(
        0,
        Math.floor(Math.log(Math.max(1, Math.abs(value))) / Math.log(1024)),
      ),
    );
    return `${number(value / 1024 ** scale)} ${units[scale]}`;
  }
  if (unit === "byte-seconds") {
    const disk = /disk/i.test(metric);
    return `${number(value / (disk ? 1e9 : 1024 ** 3) / 3600)} ${disk ? "GB" : "GiB"}·小时`;
  }
  if (unit === "milliseconds")
    return Math.abs(value) >= 60000
      ? `${number(value / 60000)} 分钟`
      : `${number(value / 1000)} 秒`;
  if (unit === "vCPU-seconds")
    return Math.abs(value) >= 3600
      ? `${number(value / 3600)} vCPU·小时`
      : Math.abs(value) >= 60
        ? `${number(value / 60)} vCPU·分钟`
        : `${number(value)} vCPU·秒`;
  if (unit === "GiB-seconds" || unit === "gib-seconds")
    return Math.abs(value) >= 3600
      ? `${number(value / 3600)} GiB·小时`
      : `${number(value)} GiB·秒`;
  if (unit === "GB-seconds" || unit === "gb-seconds")
    return Math.abs(value) >= 3600
      ? `${number(value / 3600)} GB·小时`
      : `${number(value)} GB·秒`;
  const units: Record<string, string> = {
    requests: "次",
    rows: "行",
    events: "条",
    minutes: "分钟",
    "GB-months": "GB·月",
  };
  return `${number(value)}${unit ? ` ${units[unit] || unit}` : ""}`;
}
export function usageUnitNote(unit: string) {
  return [
    "byte-seconds",
    "GB-seconds",
    "gb-seconds",
    "GiB-seconds",
    "gib-seconds",
    "GB-months",
  ].includes(unit)
    ? "容量与时间的乘积，不是实际运行时长或当前存储大小。"
    : "";
}
