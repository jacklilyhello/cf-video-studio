import { bytes } from "./client";

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function ProcessingQuoteValues({
  data,
}: {
  data: Record<string, unknown>;
}) {
  const instance = record(data.instance);
  const timeout = finite(data.totalTimeoutSeconds);
  const cost = finite(data.costUpperUsd);
  const breakdown = Array.isArray(data.costBreakdown)
    ? data.costBreakdown
        .map(record)
        .filter(
          (line) =>
            typeof line.label === "string" && finite(line.upperUsd) !== null,
        )
    : [];
  const specifications = [
    finite(instance.vcpu) !== null ? `${instance.vcpu} vCPU` : null,
    finite(instance.memoryBytes) !== null
      ? `${(Number(instance.memoryBytes) / 1024 ** 3).toLocaleString()} GiB 内存`
      : null,
    finite(instance.diskBytes) !== null
      ? `${(Number(instance.diskBytes) / 1e9).toLocaleString()} GB 磁盘`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="stack">
      <dl className="info-list quote-values">
        <div>
          <dt>实例规格</dt>
          <dd>
            {specifications || "规格未提供，请重新报价"}
            {typeof instance.name === "string" && (
              <small className="muted">（{instance.name}）</small>
            )}
          </dd>
        </div>
        <div>
          <dt>原片大小</dt>
          <dd>{bytes(finite(data.sourceBytes))}</dd>
        </div>
        <div>
          <dt>新增文件空间上限</dt>
          <dd>{bytes(finite(data.maxOutputBytes))}；原片与已有成功版本保留</dd>
        </div>
        <div>
          <dt>最长运行时间</dt>
          <dd>
            {timeout === null
              ? "无法确认，请重新报价"
              : `${Math.floor(timeout / 60)} 分钟${timeout % 60 ? ` ${timeout % 60} 秒` : ""}`}
            （包括启动、下载、处理、上传和停止核验）
          </dd>
        </div>
        <div>
          <dt>预计耗时</dt>
          <dd>尚不能可靠预测；超过最长运行时间会要求停止，不会自动延长</dd>
        </div>
        <div>
          <dt>可能新增费用</dt>
          <dd>
            {cost === null
              ? "无法确认，请重新报价"
              : `0 至 US$${cost.toFixed(4)}（保守估算）`}
          </dd>
        </div>
        <div>
          <dt>费用允许范围</dt>
          <dd>当前只允许已核实的套餐包含额度内任务；费用开关不批准额外支出</dd>
        </div>
        <div>
          <dt>输出方案</dt>
          <dd>
            {data.outputKind === "mp4" ? "独立 MP4 文件" : "HLS 播放版本"} ·{" "}
            {data.encoding === "h264-aac"
              ? "H.264 视频与 AAC 音频转码"
              : "保留视频与音频编码，不兼容就停止"}
          </dd>
        </div>
        {typeof data.audio === "string" && (
          <div>
            <dt>音轨处理</dt>
            <dd>{data.audio}</dd>
          </div>
        )}
      </dl>
      <p className="muted small-text">
        这是包含额度全部耗尽、且本任务触发下一个计费单位时的保守新增费用风险，不是通常处理价。实际费用可能由剩余包含额度覆盖；既有套餐固定费用另计。平台停止延迟或停止未核实可能超出估算，这不是支付封顶承诺。
      </p>
      {!!breakdown.length && (
        <details className="details">
          <summary>费用构成与计费单位</summary>
          <p className="muted small-text">
            下列金额均是本任务在最坏情况下可能新增的费用；不同任务的金额不能简单相加成实际账单，包含额度和整单位费用在账户账期内结算。
          </p>
          <dl className="info-list">
            {breakdown.map((line, index) => (
              <div key={String(line.key ?? index)}>
                <dt>{String(line.label)}</dt>
                <dd>
                  最多 US${Number(line.upperUsd).toFixed(4)}
                  {typeof line.billingRule === "string" && (
                    <small className="muted"> · {line.billingRule}</small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {data.executionAllowed !== false &&
        typeof data.executionNextStep === "string" && (
          <p role={data.executionAllowed === false ? "status" : undefined}>
            {data.executionNextStep}
          </p>
        )}
    </div>
  );
}
