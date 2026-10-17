import { HttpError } from "./http";

/** Historical manual_usage_checks_json and upload evidence rows are audit-only.
 * No public route or processing/upload admission resolves or renews them.
 */
export function manualUsageRetired(): never {
  throw new HttpError(
    410,
    "manual_usage_retired",
    "人工填报流程已停用；请查看自动资源用量，无需录入 Cloudflare 数值",
  );
}
