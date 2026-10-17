import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ResourceUsageSnapshot,
  ResourceMetric,
} from "../src/resource-usage";
const fixture = vi.hoisted(() => ({
  data: null as ResourceUsageSnapshot | null,
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<typeof import("../web/client")>()),
  useLoad: () => ({
    data: fixture.data,
    loading: false,
    error: null,
    reload: vi.fn(),
    setData: vi.fn(),
  }),
}));
import { ResourceUsage, resourceValue } from "../web/ResourceUsage";
import { date } from "../web/client";
function sample(): ResourceUsageSnapshot {
  return {
    fetchedAt: 1,
    cached: false,
    nextRefreshAt: 30001,
    environment: "test",
    worker: "fixture-test",
    period: { start: "2026-10-14", end: "2026-10-15", label: "最近 24 小时" },
    policy: { processingEnabled: false, monthlyIncrementalBudgetUsd: 0 },
    cards: ["r2", "d1", "workers", "do", "containers", "builds", "logs"].map(
      (key) => ({
        key,
        title: `Resource ${key}`,
        scope: "本项目限定资源",
        metrics: [
          {
            key: "local",
            label: "已登记记录",
            value: 5,
            unit: "count",
            source: "project",
            observedAt: 1,
          },
          {
            key: "official",
            label: "官方自动统计",
            value: 10,
            unit: "count",
            source: "official",
            observedAt: 1,
          },
        ],
        notes: ["现有记录范围，不是账户余额。"],
        links: [
          {
            label: `在 Cloudflare 查看 ${key}`,
            url: `https://dash.cloudflare.com/${"a".repeat(32)}/${key}`,
            note: "选择本项目资源",
          },
        ],
        diagnostics: [
          {
            source: "指定项目统计",
            state: "ok",
            checkedAt: 1,
            note: "已取得数据",
          },
        ],
        ...(key === "r2"
          ? { limit: { usedBytes: 1024, reservedBytes: 512, limitBytes: 2048 } }
          : {}),
      }),
    ),
  };
}
function recordedBillingFailure(): ResourceUsageSnapshot {
  const data = sample();
  const start = Date.parse("2026-10-13T00:00:00Z");
  const observedAt = Date.parse("2026-10-15T10:00:00Z");
  const checkedAt = Date.parse("2026-10-15T12:00:00Z");
  const intervals = [
    { start, end: Date.parse("2026-10-14T00:00:00Z") },
    { start: Date.parse("2026-10-15T00:00:00Z"), end: observedAt },
  ];
  data.range = "billing";
  data.fetchedAt = checkedAt;
  data.nextRefreshAt = checkedAt + 3600_000;
  data.period = {
    start: new Date(start).toISOString(),
    end: new Date(checkedAt).toISOString(),
    label:
      "本账期（Cloudflare 实际周期） · 2026/10/13 08:00 至 2026/10/15 20:00（Asia/Singapore）",
  };
  data.collection = {
    checkedAt,
    status: "partial",
    intervalMinutes: 60,
    coverageStart: start,
    scope: "test / fixture-test",
    note: "本轮检查结束；整段账期查询失败，已保存每日用量继续显示，缺失未按零补齐。",
  };
  data.policy = {
    processingEnabled: false,
    monthlyIncrementalBudgetUsd: 7.5,
  };
  const workers = data.cards.find((item) => item.key === "workers")!;
  workers.metrics = [
    {
      key: "requests",
      label: "请求数 · 本账期已记录用量",
      value: 600,
      unit: "count",
      source: "official",
      observedAt,
      coverage: {
        kind: "daily-ledger",
        rangeStart: start,
        rangeEnd: checkedAt,
        intervals,
        gapMilliseconds: 26 * 3600_000,
      },
      note: "本账期已记录用量，来自本项目已保存的官方每日数据；实际覆盖 2026/10/13 08:00:00 至 2026/10/14 08:00:00；2026/10/15 08:00:00 至 2026/10/15 18:00:00（Asia/Singapore）；覆盖不完整，已知缺口 26.00 小时，未按零补齐。分析统计仍可能采样或迟到，不代表完整账单或账户剩余额度。",
    },
    {
      key: "errors",
      label: "运行错误 · 本账期（Cloudflare 实际周期）",
      value: 0,
      unit: "count",
      source: "official",
      observedAt: checkedAt,
      note: "此字段保留同账期官方成功查询的真实零值，不叠加每日来源。",
    },
  ];
  workers.diagnostics = [
    {
      source: "Workers · 指定 scriptName",
      state: "unavailable",
      checkedAt,
      httpStatus: 503,
      note: "官方整段账期查询失败；保留本项目已保存每日数据，没有填零。",
    },
    {
      source: "workers · 本账期每日记录回退",
      state: "partial",
      checkedAt,
      dataAt: observedAt,
      note: "仅缺少可用官方账期值的字段使用每日记录；来源不相加，缺失不补零。",
    },
  ];
  return data;
}
function renderedCard(html: string, key: string): string {
  const marker = `aria-labelledby="resource-${key}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}
describe("resource usage presentation", () => {
  it("binds the recorded billing value, coverage and original observation time to the same metric while retaining failure diagnostics and every resource link", () => {
    fixture.data = recordedBillingFailure();
    const requests = fixture.data.cards.find((item) => item.key === "workers")!
      .metrics[0];
    const html = renderToStaticMarkup(<ResourceUsage />);
    const workers = renderedCard(html, "workers");
    const metricBlocks = [
      ...workers.matchAll(/<div class="resource-metric">([\s\S]*?)<\/div>/g),
    ].map((match) => match[1]);
    const recorded = metricBlocks.find((markup) =>
      markup.includes(`<dt>${requests.label}</dt>`),
    )!;
    expect(recorded).toBeDefined();
    expect(recorded).toContain("<dd>600</dd>");
    expect(recorded).toContain(
      `<small>官方 API · ${date(requests.observedAt)}</small>`,
    );
    expect(recorded).not.toContain(
      `<small>官方 API · ${date(fixture.data.fetchedAt)}</small>`,
    );
    expect(recorded).toContain(`<p class="muted">${requests.note}</p>`);
    expect(requests.coverage!.gapMilliseconds).toBe(
      requests.coverage!.rangeEnd -
        requests.coverage!.rangeStart -
        requests.coverage!.intervals.reduce(
          (sum, interval) => sum + interval.end - interval.start,
          0,
        ),
    );
    expect(metricBlocks).toHaveLength(2);
    const errors = metricBlocks.find((markup) =>
      markup.includes("<dt>运行错误"),
    )!;
    expect(errors).toContain("<dd>0</dd>");
    expect(errors).not.toContain(requests.note);
    expect(workers).toContain("部分自动查询异常");
    expect(workers).not.toContain("自动数据已获取");
    const diagnostic = workers.slice(
      workers.indexOf('<details class="resource-diagnostics">'),
    );
    expect(diagnostic).toContain("查询异常");
    expect(diagnostic).toContain("HTTP 503");
    expect(diagnostic).toContain("官方整段账期查询失败");
    expect(diagnostic).toContain(`数据时间 ${date(requests.observedAt)}`);
    for (const card of fixture.data.cards) {
      const section = renderedCard(html, card.key);
      expect(section).toContain(`href="${card.links[0].url}"`);
      expect(section).toContain(card.links[0].label);
    }
    expect(renderToStaticMarkup(<ResourceUsage />)).toBe(html);
  });
  it.each([false, true])(
    "keeps billing fallback display independent of processing authorization (enabled=%s)",
    (processingEnabled) => {
      fixture.data = recordedBillingFailure();
      fixture.data.policy.processingEnabled = processingEnabled;
      const policy = { ...fixture.data.policy };
      const html = renderToStaticMarkup(<ResourceUsage />);
      expect(renderedCard(html, "workers")).toContain("<dd>600</dd>");
      const summary = html.slice(
        html.indexOf('class="panel resource-summary"'),
        html.indexOf('class="resource-card-grid"'),
      );
      expect(summary).toContain("项目新增月预算：USD 7.5");
      expect(summary).toContain(
        processingEnabled ? "已启用，仍需逐任务确认" : "处理开关：关闭",
      );
      expect(summary).toContain("项目预算不是账户总账单承诺");
      expect(html).not.toMatch(
        /<form|开始转码|启动 Container|自动批准|提高预算/,
      );
      expect(fixture.data.policy).toEqual(policy);
    },
  );
  it("renders seven cards with per-card links and source labels, without manual evidence forms or duplicate page title", () => {
    fixture.data = sample();
    const html = renderToStaticMarkup(<ResourceUsage />);
    expect(html.match(/class="panel resource-card"/g)?.length).toBe(7);
    for (const key of [
      "r2",
      "d1",
      "workers",
      "do",
      "containers",
      "builds",
      "logs",
    ]) {
      const marker = `id="resource-${key}"`,
        start = html.indexOf(marker),
        end = html.indexOf("</section>", start);
      expect(html.slice(start, end)).toContain(`在 Cloudflare 查看 ${key}`);
    }
    expect(html).toContain("官方 API");
    expect(html).toContain("项目记录");
    expect(html).toContain("独立测试环境");
    expect(html).toContain("近24小时");
    expect(html).toContain("本账期");
    expect(html).toContain("累计");
    expect(html).toContain("本项目空间上限（已登记占用＋预留）");
    expect(html).not.toMatch(
      /<input|<form|人工证据|核验时间|完整性|核验不完整|证据 ID|剩余额度无法确认|<h2>资源用量/,
    );
  });
  it("retains successful metrics while showing transient permission failures in expandable diagnostics", () => {
    fixture.data = sample();
    fixture.data.cards[0].diagnostics = [
      {
        source: "R2 metrics",
        state: "restricted",
        httpStatus: 403,
        codes: [10000],
        checkedAt: 1,
        note: "运行时访问被拒绝；不代表零用量",
      },
    ];
    const html = renderToStaticMarkup(<ResourceUsage />);
    expect(html).toContain("部分自动查询异常");
    expect(html).toContain("<details");
    expect(html).toContain("HTTP 403");
    expect(html).toContain("官方自动统计");
    expect(html).toContain("运行时访问被拒绝");
  });
  it("marks incomplete cumulative coverage in the visible card status", () => {
    fixture.data = sample();
    fixture.data.cards[0].diagnostics = [
      { source: "累计", state: "partial", checkedAt: 1, note: "已知数据缺口" },
    ];
    const html = renderToStaticMarkup(<ResourceUsage />);
    expect(html).toContain("数据覆盖不完整");
    expect(html).toContain("badge-warning");
  });
  it("shows project scope and background collection while allowing the first project's metrics to be read", () => {
    fixture.data = sample();
    fixture.data.collection = {
      checkedAt: 0,
      status: "collecting",
      retryAt: 35000,
      scope: "test / fixture-test",
      intervalMinutes: 60,
      coverageStart: null,
      note: "首次采集没有把未知用量填零。",
    };
    const html = renderToStaticMarkup(<ResourceUsage />);
    expect(html).toContain("采集范围：test / fixture-test");
    expect(html).toContain("正在后台采集，已保存结果与项目记录可先查看");
    expect(html).toContain("尚未完成首次检查");
    expect(html).toContain("已登记记录");
    expect(html).not.toContain("正在读取本项目资源用量");
    expect(html).not.toContain("自动采集更新于");
    expect(html).not.toContain("租约");
  });
  it("formats cumulative CPU and observed time units without pretending query row counts are query events", () => {
    const metric = (
      unit: ResourceMetric["unit"],
      value: number,
    ): ResourceMetric => ({
      key: "fixture",
      label: "fixture",
      value,
      unit,
      source: "official",
      observedAt: 1,
    });
    expect(resourceValue(metric("milliseconds", 120_000))).toBe("2 分钟");
    expect(resourceValue(metric("seconds", 3600))).toBe("1 小时");
    expect(resourceValue(metric("count", 1234))).toBe("1,234");
    expect(resourceValue(metric("gib-seconds", 2))).toBe("2 GiB·秒");
    expect(resourceValue(metric("vcpu-seconds", 40))).toBe("40 vCPU·秒");
    expect(resourceValue(metric("gib-seconds", 0.000001))).not.toBe("0 GiB·秒");
  });
});
