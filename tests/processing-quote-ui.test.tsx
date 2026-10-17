import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessingQuoteValues } from "../web/ProcessingQuoteValues";

it("shows understandable resource specifications, maximum runtime and possible fees without raw arrays or snapshot IDs", () => {
  const html = renderToStaticMarkup(
    <ProcessingQuoteValues
      data={{
        instance: {
          name: "standard-1",
          vcpu: 0.5,
          memoryBytes: 4 * 1024 ** 3,
          diskBytes: 8e9,
        },
        totalTimeoutSeconds: 1800,
        estimatedSeconds: [0, 1800],
        maxOutputBytes: 2 * 1024 ** 2,
        sourceBytes: 1024 ** 2,
        costUpperUsd: 5.342,
        outputKind: "mp4",
        encoding: "copy-only",
        snapshotId: "private-diagnostic-snapshot",
        executionAllowed: false,
        executionNextStep:
          "请明确批准这一个任务的费用风险后重新报价，无需抄账。",
      }}
    />,
  );
  expect(html).toContain("0.5 vCPU");
  expect(html).toContain("4 GiB 内存");
  expect(html).toContain("8 GB 磁盘");
  expect(html).toContain("30 分钟");
  expect(html).toContain("0 至 US$5.3420");
  expect(html).toContain("尚不能可靠预测");
  expect(html).toContain("原片与已有成功版本保留");
  expect(html).not.toContain("请明确批准这一个任务");
  expect(html).toContain("不是通常处理价");
  expect(html).not.toContain("[0,1800]");
  expect(html).not.toContain("private-diagnostic-snapshot");
});

it("keeps missing quantities unknown and gives a useful next step", () => {
  const html = renderToStaticMarkup(<ProcessingQuoteValues data={{}} />);
  expect(html).toContain("规格未提供，请重新报价");
  expect(html).toContain("无法确认，请重新报价");
  expect(html).not.toContain("US$0.0000");
});

it("renders the quote's fee components without hardcoding a task price", () => {
  const html = renderToStaticMarkup(
    <ProcessingQuoteValues
      data={{
        costUpperUsd: 3.75,
        costBreakdown: [
          {
            key: "r2-operations",
            label: "文件读写操作",
            upperUsd: 0.75,
            billingRule: "本报价的操作计费单位",
          },
          {
            key: "coordination-duration",
            label: "任务协调运行时间",
            upperUsd: 3,
            billingRule: "本报价的运行计费单位",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("费用构成与计费单位");
  expect(html).toContain("US$0.7500");
  expect(html).toContain("US$3.0000");
  expect(html).not.toContain("US$4.8600");
  expect(html).not.toContain("US$12.5000");
});
