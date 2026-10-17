import { useEffect, useRef, useState } from "react";
import type {
  ResourceCard,
  ResourceDiagnostic,
  ResourceMetric,
  ResourceUsageSnapshot,
  ResourceRange,
} from "../src/resource-usage";
import { api, bytes, date, useLoad } from "./client";
import { ErrorBox, Icon, Loading } from "./ui";

const sourceLabels = {
  official: "官方 API",
  project: "项目记录",
  estimate: "项目估算",
};
const stateLabels: Record<ResourceDiagnostic["state"], string> = {
  ok: "读取正常",
  empty: "未返回记录",
  restricted: "权限不足",
  unavailable: "查询异常",
  unconfigured: "未配置统计范围",
  stale: "最后成功数据",
  partial: "部分数据",
};
export function resourceValue(metric: ResourceMetric): string {
  if (typeof metric.value === "string") return metric.value;
  if (metric.unit === "bytes") return bytes(metric.value);
  const format = (value: number) =>
    value !== 0 && Math.abs(value) < 0.001
      ? value.toExponential(2)
      : value.toLocaleString("zh-CN", {
          maximumFractionDigits: value < 10 ? 3 : 2,
        });
  if (metric.unit === "milliseconds")
    return metric.value >= 60_000
      ? `${format(metric.value / 60_000)} 分钟`
      : `${format(metric.value / 1000)} 秒`;
  if (metric.unit === "seconds")
    return metric.value >= 3600
      ? `${format(metric.value / 3600)} 小时`
      : metric.value >= 60
        ? `${format(metric.value / 60)} 分钟`
        : `${format(metric.value)} 秒`;
  if (metric.unit === "gb-seconds") return `${format(metric.value)} GB·秒`;
  if (metric.unit === "gib-seconds") return `${format(metric.value)} GiB·秒`;
  if (metric.unit === "vcpu-seconds") return `${format(metric.value)} vCPU·秒`;
  return format(metric.value);
}
function SourceState({ card }: { card: ResourceCard }) {
  const errors = card.diagnostics.filter((item) =>
    ["restricted", "unavailable", "stale"].includes(item.state),
  );
  const partial = card.diagnostics.some((item) => item.state === "partial");
  const hasOfficial = card.metrics.some((item) => item.source === "official");
  return (
    <span
      className={`badge badge-${errors.length || partial ? "warning" : "ready"}`}
    >
      {errors.length
        ? "部分自动查询异常"
        : partial
          ? "数据覆盖不完整"
          : hasOfficial
            ? "自动数据已获取"
            : "项目记录"}
    </span>
  );
}
function UsageCard({ card }: { card: ResourceCard }) {
  const limit = card.limit;
  const limited = limit && limit.limitBytes > 0;
  const percent = limited
    ? Math.min(
        100,
        ((limit.usedBytes + limit.reservedBytes) / limit.limitBytes) * 100,
      )
    : 0;
  return (
    <section
      className="panel resource-card"
      aria-labelledby={`resource-${card.key}`}
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">{card.scope}</p>
          <h2 id={`resource-${card.key}`}>{card.title}</h2>
        </div>
        <SourceState card={card} />
      </div>
      <dl className="resource-metrics">
        {card.metrics.map((item, index) => (
          <div className="resource-metric" key={`${item.key}-${index}`}>
            <dt>{item.label}</dt>
            <dd
              className={
                item.unit === "text" ? "resource-text-value" : undefined
              }
            >
              {resourceValue(item)}
            </dd>
            <small>
              {sourceLabels[item.source]} · {date(item.observedAt)}
            </small>
            {item.note && <p className="muted">{item.note}</p>}
          </div>
        ))}
      </dl>
      {limit && (
        <div className="resource-storage-limit">
          <div className="section-heading">
            <strong>本项目空间上限（已登记占用＋预留）</strong>
            <span>
              {bytes(limit.usedBytes)} 已登记 + {bytes(limit.reservedBytes)}{" "}
              预留 / {bytes(limit.limitBytes)}
            </span>
          </div>
          {limited && (
            <progress
              aria-label="本项目空间使用率（含预留）"
              value={percent}
              max={100}
            />
          )}
          <p className="muted">
            可用{" "}
            {bytes(
              Math.max(
                0,
                limit.limitBytes - limit.usedBytes - limit.reservedBytes,
              ),
            )}
            ；这是项目硬上限，不是账户免费余额。
          </p>
        </div>
      )}
      {card.notes.map((note, index) => (
        <p className="muted resource-note" key={index}>
          {note}
        </p>
      ))}
      <div className="resource-links">
        {card.links.map((link) => (
          <div key={link.url + link.label}>
            <a
              className="button"
              href={link.url}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="arrow" size={16} />
              {link.label}
            </a>
            {link.note && <p className="muted">{link.note}</p>}
          </div>
        ))}
      </div>
      {card.diagnostics.length > 0 && (
        <details className="resource-diagnostics">
          <summary>数据来源与查询诊断</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>状态</th>
                  <th>读取时间</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {card.diagnostics.map((item, index) => (
                  <tr key={`${item.source}-${index}`}>
                    <td>{item.source}</td>
                    <td>
                      {stateLabels[item.state]}
                      {item.httpStatus !== undefined && (
                        <small> HTTP {item.httpStatus}</small>
                      )}
                    </td>
                    <td>
                      {date(item.checkedAt)}
                      {item.dataAt !== undefined && (
                        <small>数据时间 {date(item.dataAt)}</small>
                      )}
                    </td>
                    <td>
                      {item.note}
                      {!!item.codes?.length && (
                        <small>错误码：{item.codes.join("、")}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
export function ResourceUsage() {
  const [range, setRange] = useState<ResourceRange>("24h");
  const usage = useLoad<ResourceUsageSnapshot>(
    `/api/admin/resource-usage?range=${range}`,
    15_000,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const flight = useRef(false);
  const reads = useRef(0);
  useEffect(() => {
    reads.current = 0;
  }, [range]);
  const data = usage.data;
  const collecting =
    data?.collection?.status === "pending" ||
    data?.collection?.status === "collecting";
  useEffect(() => {
    if (!collecting || usage.loading || usage.error || reads.current >= 6)
      return;
    const timer = setTimeout(() => {
      reads.current += 1;
      usage.reload();
    }, 5_000);
    return () => clearTimeout(timer);
  }, [collecting, data?.fetchedAt, usage.loading, usage.error, usage.reload]);
  async function refresh() {
    if (flight.current) return;
    flight.current = true;
    setRefreshing(true);
    setRefreshError(null);
    reads.current = 0;
    try {
      usage.setData(
        await api<ResourceUsageSnapshot>(
          `/api/admin/resource-usage?range=${range}&refresh=1`,
          {},
          15_000,
        ),
      );
    } catch (error) {
      setRefreshError(error as Error);
    } finally {
      flight.current = false;
      setRefreshing(false);
    }
  }
  return (
    <div className="stack admin-resource-page">
      <div className="section-heading">
        <div>
          <p className="muted">自动记录本项目使用情况，无需人工抄表。</p>
          <label>
            统计范围{" "}
            <select
              aria-label="资源统计范围"
              value={range}
              disabled={refreshing}
              onChange={(event) =>
                setRange(event.target.value as ResourceRange)
              }
            >
              <option value="24h">近24小时</option>
              <option value="billing">本账期</option>
              <option value="all">累计</option>
            </select>
          </label>
        </div>
        <button
          className="button"
          disabled={refreshing || usage.loading}
          onClick={() => void refresh()}
        >
          <Icon name="refresh" size={16} />
          {refreshing ? "正在更新…" : "更新用量"}
        </button>
      </div>

      {usage.loading && !data ? (
        <Loading text="正在读取本项目资源用量…" />
      ) : usage.error && !data ? (
        <ErrorBox error={usage.error} retry={usage.reload} />
      ) : null}
      {refreshError && (
        <ErrorBox error={refreshError} retry={() => void refresh()} />
      )}
      {usage.error && data && (
        <ErrorBox error={usage.error} retry={usage.reload} />
      )}
      {usage.loading && data && (
        <p className="muted" role="status">
          正在读取所选范围，暂时保留上次结果…
        </p>
      )}
      {data && (
        <>
          <div className="panel resource-summary">
            <div>
              <strong>
                {data.environment === "test"
                  ? "独立测试环境"
                  : data.environment === "production"
                    ? "生产环境"
                    : "环境未配置"}
              </strong>
              <span>{data.worker || "Worker 统计名称未配置"}</span>
            </div>
            <p>{data.period.label}</p>
            {data.collection?.scope && (
              <p className="muted">
                采集范围：{data.collection.scope}（仅此项目资源）
              </p>
            )}
            <p className="muted">
              读取于 {date(data.fetchedAt)}
              。最近采集检查：{" "}
              {data.collection?.checkedAt
                ? date(data.collection.checkedAt)
                : "尚未完成首次检查"}
              ；每小时持续保存，手动更新至少间隔30秒。
            </p>
            {collecting && (
              <p role="status">
                正在后台采集，已保存结果与项目记录可先查看。本页将短时自动读取结果，也可稍后更新。
              </p>
            )}
            {data.collection && <p className="muted">{data.collection.note}</p>}
            <p className="muted">
              存储大小、对象数量和现存记录显示当前状态；请求、读写与容量时间按所选范围统计。
            </p>
            <p className="muted">
              项目新增月预算：
              {data.policy.monthlyIncrementalBudgetUsd === null
                ? "未配置"
                : `USD ${data.policy.monthlyIncrementalBudgetUsd}`}{" "}
              · 处理开关：
              {data.policy.processingEnabled
                ? "已启用，仍需逐任务确认"
                : "关闭"}
              。项目预算不是账户总账单承诺。
            </p>
          </div>
          <div className="resource-card-grid">
            {data.cards.map((card) => (
              <UsageCard key={card.key} card={card} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
