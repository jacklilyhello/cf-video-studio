import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../web/client";
import {
  explainMediaError,
  MediaErrorBox,
  type MediaStage,
} from "../web/media-errors";

const explanation = (code: string, stage: MediaStage = "check") =>
  explainMediaError(new ApiError("合成诊断，不是真实账户或原片数据", code), {
    stage,
  });

describe("media causes choose evidence-based recovery rather than blanket transcode or retry", () => {
  it.each([
    "source_check_timeout",
    "source_read_unverified",
    "source_response_unverified",
    "mp4_check_timeout",
  ])(
    "%s is an unfinished read, not a format or encoding conclusion",
    (code) => {
      expect(explanation(code)).toMatchObject({
        category: "read",
        action: "retry-read",
        encoding: "none",
        output: "none",
        processing: "not-needed",
        retryable: true,
      });
      expect(explanation(code).unknown).toContain("尚未判定");
      expect(explanation(code).nextStep).toContain("点击“重新检查原片”");
      expect(explanation(code).nextStep).toContain("仅在结构检查通过后可用");
      expect(explanation(code).nextStep).toContain("日志与诊断");
    },
  );

  it.each([
    "unsupported_edit_list",
    "unsupported_composition_offset",
    "metadata_limit",
    "fragment_count_limit",
    "unsupported_header_version",
  ])(
    "%s identifies an inspection limit and does not recommend repeating a fixed restriction",
    (code) => {
      const result = explanation(code);
      expect(result).toMatchObject({
        category: "inspection-limit",
        action: "inspect-structure",
        encoding: "undetermined",
        directPlayback: "try-private-native",
        processing: "separate-confirmation",
        retryable: false,
      });
      expect(result.unknown).toContain("暂不能判断");
      expect(result.nextStep).toContain("固定格式限制不会");
      expect(result.nextStep).not.toContain("前置索引");
      expect(result.fileEffect).toContain("不要删除或忽略编辑列表");
    },
  );

  it.each([
    ["unsupported_audio_codec", "audio-support", "verify-audio"],
    ["unsupported_audio_codec_or_channels", "audio-support", "verify-audio"],
    ["unsupported_aac_profile", "audio-support", "verify-audio"],
    ["unsupported_video_codec", "video-support", "verify-video"],
    ["unsupported_avc_profile", "video-support", "verify-video"],
    ["unsupported_avc_bit_depth", "video-support", "verify-video"],
  ])(
    "%s isolates the affected track without claiming all browsers reject it",
    (code, category, action) => {
      const result = explanation(code);
      expect(result).toMatchObject({
        category,
        action,
        encoding: "undetermined",
        retryable: false,
      });
      expect(result.unknown).toContain("还不是浏览器实播不兼容的证据");
      expect(result.fileEffect).toContain("对应轨道");
      expect(result.processingNote).toContain("确认");
    },
  );

  it("an EBML signature selects the unsupported container path without claiming WebM validation, damage or mandatory conversion", () => {
    const result = explanation("unsupported_source_container");
    expect(result).toMatchObject({
      category: "source-container-unsupported",
      action: "inspect-structure",
      directPlayback: "try-private-native",
      output: "possible-new-file",
      encoding: "undetermined",
      processing: "separate-confirmation",
      retryable: false,
    });
    expect(result.confirmed).toContain("EBML 容器标识（常见于 WebM/Matroska）");
    expect(result.unknown).toContain(
      "尚未核实具体容器类型、轨道编码和文件完整性",
    );
    expect(result.unknown).toContain("当前浏览器能否原生播放仍未知");
    expect(result.unknown).toContain("暂不能判断是否需要转码");
    expect(result.playback).toContain("受控管理员原生预览路径后");
    expect(result.nextStep).toContain("重新上传同一文件或反复重试不会改变");
    expect(result.fileEffect).toContain(
      "能否仅复制码流取决于轨道编码和目标封装兼容性",
    );
    expect(result.processingNote).toContain("另取报价");
    expect(result.processingNote).toContain("Container");
    expect(result.processingNote).toContain("单独确认");
    const html = renderToStaticMarkup(
      <MediaErrorBox
        stage="check"
        code="unsupported_source_container"
        retry={vi.fn()}
      />,
    );
    expect(html).not.toContain("<button");
    expect(html.split("<details")[0]).not.toContain(
      "unsupported_source_container",
    );
  });

  it.each([
    [
      "Audio must be re-encoded to AAC-LC.",
      "audio-transcode",
      "verify-audio",
      "audio-if-confirmed",
    ],
    [
      "Video must be re-encoded to compatible 8-bit H.264.",
      "video-transcode",
      "verify-video",
      "video-if-confirmed",
    ],
  ])(
    "trusted processing reason %s scopes any conversion to that track",
    (reason, category, action, encoding) => {
      const result = explainMediaError(reason, { stage: "processing" });
      expect(result).toMatchObject({
        category,
        action,
        encoding,
        output: "possible-new-file",
        processing: "separate-confirmation",
      });
      expect(result.unknown).toContain("当前处理输出的要求");
      expect(result.playback).toContain("私有原片预览");
      expect(result.fileEffect).toContain("原片保留");
      if (encoding === "audio-if-confirmed") {
        expect(result.nextStep).toContain("仅处理音频、复制视频");
        expect(result.nextStep).toContain("不得直接确认全片转码");
      }
    },
  );

  it.each([
    "Multiple audio tracks require an explicit preservation plan.",
    "HDR or Dolby Vision requires an explicit color and metadata plan.",
    "unsupported_track_count",
    "unsupported_video_transform",
    "Unsupported media metadata requires an explicit preservation plan.",
    "Complex stream side data requires an explicit preservation plan.",
  ])(
    "%s requires a preservation plan rather than dropping tracks or metadata",
    (reason) => {
      const result = explainMediaError(reason, { stage: "processing" });
      expect(result).toMatchObject({
        category: "preservation",
        action: "inspect-structure",
        encoding: "undetermined",
        retryable: false,
      });
      expect(result.unknown).toContain("不能默认丢弃");
      expect(result.fileEffect).toContain("不自动执行");
    },
  );

  it.each([
    "fragment_audio_video_timeline_mismatch",
    "fragment_decode_discontinuity",
    "sample_duration_mismatch",
    "invalid_time_table",
  ])(
    "%s preserves the relationship between audio and video while evaluating remux",
    (code) => {
      const result = explanation(code);
      expect(result).toMatchObject({
        category: "timeline",
        action: "inspect-structure",
        encoding: "undetermined",
        output: "possible-new-file",
      });
      expect(result.nextStep).toContain("保留音视频偏移");
      expect(result.unknown).toContain("不能保证无损整理成功");
      expect(result.fileEffect).toContain("不重新编码");
    },
  );

  it.each([
    "sample_outside_mdat",
    "invalid_box_size",
    "truncated_metadata",
    "not_complete_mp4",
  ])(
    "%s uses concrete integrity evidence and checks reads before replacing the file",
    (code) => {
      const result = explanation(code);
      expect(result).toMatchObject({
        category: "structure-incomplete",
        action: "replace-source",
        encoding: "undetermined",
        output: "new-upload",
      });
      expect(result.nextStep).toContain(
        "媒体连接诊断仅在结构检查通过且提供入口后可执行",
      );
      expect(result.nextStep).toContain("日志与诊断");
      expect(result.nextStep).toContain("读取完整仍有同一结构错误");
      expect(result.fileEffect).toContain("转码不能恢复缺失");
    },
  );

  it("login, upload integrity and an unverified completion each choose a different recovery", () => {
    expect(
      explainMediaError(
        new ApiError("登录已过期", "unauthorized", "fixture", 401),
        { stage: "upload" },
      ),
    ).toMatchObject({
      category: "session",
      action: "sign-in",
      encoding: "none",
      retryable: false,
    });
    expect(explanation("part_hash", "upload")).toMatchObject({
      category: "upload-integrity",
      action: "resume-upload",
      encoding: "none",
      retryable: true,
    });
    expect(explanation("part_conflict", "upload")).toMatchObject({
      category: "upload-integrity",
      action: "resume-upload",
      retryable: false,
    });
    const saved = explanation("completion_unverified", "upload");
    expect(saved).toMatchObject({
      category: "upload-unverified",
      action: "reconcile-upload",
      encoding: "none",
    });
    expect(saved.nextStep).toContain("不要另建重复上传");
    expect(explanation("parts_missing", "upload")).toMatchObject({
      category: "source-unavailable",
      directPlayback: "blocked-until-complete",
      action: "resume-upload",
    });
  });

  it("file identity changes invalidate old proof, rather than converting the file", () => {
    expect(explanation("source_changed")).toMatchObject({
      category: "identity",
      action: "recheck-source",
      encoding: "none",
      output: "none",
    });
    expect(explanation("source_changed").confirmed).toContain(
      "旧证据不能继续使用",
    );
  });

  it("native network and decode failures remain distinct and do not prove corrupt input", () => {
    expect(
      explainMediaError(null, {
        stage: "preview",
        code: "playback_native_error",
        nativeErrorCode: 2,
      }),
    ).toMatchObject({
      category: "playback-read",
      action: "retry-read",
      output: "none",
      encoding: "undetermined",
    });
    expect(
      explainMediaError(null, {
        stage: "preview",
        code: "playback_native_error",
        nativeErrorCode: 3,
      }),
    ).toMatchObject({
      category: "playback-unverified",
      action: "verify-native",
      output: "none",
      encoding: "undetermined",
    });
    expect(
      explainMediaError(null, {
        stage: "preview",
        code: "playback_hls_fatal",
        hlsErrorType: "networkError",
      }).category,
    ).toBe("playback-read");
    expect(explanation("playback_mse_failed", "preview").nextStep).toContain(
      "使用原生播放重试",
    );
  });

  it("a missing valid video stream first verifies the file and parser rather than requiring re-encoding", () => {
    const result = explainMediaError("A valid video stream is required.", {
      stage: "processing",
    });
    expect(result).toMatchObject({
      category: "video-track-unverified",
      action: "inspect-structure",
      output: "none",
      encoding: "undetermined",
      processing: "not-needed",
      retryable: false,
    });
    expect(result.unknown).toContain(
      "需区分原文件没有视频轨道与当前解析未识别",
    );
    expect(result.nextStep).toContain("先修复检查支持");
    expect(result.fileEffect).toContain("转码不能凭空恢复");
  });

  it("a confirmed unsupported HLS browser path requires a supported browser, not repeat refresh or transcoding", () => {
    const result = explanation("playback_hls_unsupported", "preview");
    expect(result).toMatchObject({
      category: "browser-path-unsupported",
      action: "change-browser",
      retryable: false,
      output: "none",
      encoding: "none",
      processing: "not-needed",
    });
    expect(result.confirmed).toContain("原生 HLS 与当前播放适配器");
    expect(result.nextStep).toContain("另一款浏览器");
    expect(result.nextStep).toContain("反复重新加载不会改变");
    expect(result.unknown).toContain("不是原片损坏或必须转码");
  });

  it("an uncertain source-version response reconciles the existing version without declaring failed creation or billable work", () => {
    const result = explanation("source_version_creation_unverified", "check");
    expect(result).toMatchObject({
      category: "source-version-unverified",
      action: "recheck-source",
      retryable: false,
      output: "none",
      encoding: "none",
      processing: "not-needed",
    });
    expect(result.nextStep).toContain("核对是否已经出现对应原片版本");
    expect(result.nextStep).toContain("不重复创建或自动发布");
    expect(result.fileEffect).toContain("共用原文件");
  });

  it("budget and processing switches stay authorization barriers, not format diagnoses", () => {
    for (const code of [
      "budget_unknown",
      "budget_exceeded",
      "processing_disabled",
      "project_storage_unknown",
      "storage_limit",
      "quote_expired",
      "billing_period_boundary",
    ]) {
      const result = explanation(code, "processing");
      expect(result).toMatchObject({
        category: "admission",
        action: "review-quote",
        encoding: "none",
        output: "none",
        processing: "separate-confirmation",
        retryable: false,
      });
      expect(result.processingNote).toContain("不授权提高预算");
      expect(result.unknown).toContain("不代表取得全账户剩余额度");
    }
    expect(explanation("quote_expired", "processing").nextStep).toContain(
      "获取处理报价",
    );
    expect(explanation("budget_unknown", "processing").nextStep).toContain(
      "来源、覆盖与缺口",
    );
    expect(explanation("project_storage_unknown", "upload").nextStep).toContain(
      "R2 存储",
    );
    expect(explanation("probe_required", "processing").nextStep).toContain(
      "探测任务也须获取报价并确认费用",
    );
  });

  it("unverified stop does not promise costs have ended or start another task", () => {
    const result = explanation("cancel_unverified", "processing");
    expect(result).toMatchObject({
      category: "stop-unverified",
      action: "verify-stop",
      processing: "existing-task",
      encoding: "none",
    });
    expect(result.processingNote).toContain("可能仍在运行并产生费用");
    expect(result.nextStep).toContain("不要重复启动");
    expect(
      explainMediaError("Unclassified processing failure", {
        stage: "processing",
        stopVerified: true,
      }).processingNote,
    ).toContain("实例已核实停止");
  });

  it("an uncertain paid confirmation inspects the same task instead of retrying a media read or starting another job", () => {
    const result = explainMediaError(
      new ApiError("合成请求超时", "request_timeout"),
      { stage: "processing", startRequest: true },
    );
    expect(result).toMatchObject({
      category: "start-unverified",
      action: "review-output",
      processing: "task-unverified",
      retryable: false,
    });
    expect(result.unknown).toContain("尚不能确认任务是否启动");
    expect(result.nextStep).toContain("不要重新创建另一个收费任务");
    expect(result.processingNote).toContain("可能已启动 Container");
  });

  it("unknown diagnostics remain explicitly undecided", () => {
    const result = explainMediaError(new Error("Fixture unknown failure"), {
      stage: "check",
    });
    expect(result).toMatchObject({
      category: "unknown",
      action: "inspect-structure",
      output: "none",
      encoding: "undetermined",
      retryable: false,
    });
    expect(result.unknown).toContain("暂不能判断是否需要转码");
  });
});

describe("administrator error display", () => {
  it.each([
    ["check", undefined, "重新检查原片"],
    ["preview", undefined, "重新加载"],
    ["upload", undefined, "重试"],
    ["processing", undefined, "刷新"],
    ["upload", "刷新空间", "刷新空间"],
    ["upload", "刷新清单", "刷新清单"],
  ] as const)(
    "%s/%s recovery refers to the same actionable label the component renders",
    (stage, retryLabel, expected) => {
      const error = new ApiError("合成网络读取失败", "request_timeout");
      const result = explainMediaError(error, { stage, retryLabel });
      const html = renderToStaticMarkup(
        <MediaErrorBox
          stage={stage}
          retryLabel={retryLabel}
          error={error}
          retry={vi.fn()}
        />,
      );
      expect(result).toMatchObject({
        category: "read",
        retryable: true,
        retryLabel: expected,
      });
      expect(result.nextStep).toContain(`“${expected}”`);
      expect(html).toContain(`>${expected}</button>`);
    },
  );
  it("keeps error codes, request IDs and detailed service messages behind an expandable section", () => {
    const html = renderToStaticMarkup(
      <MediaErrorBox
        stage="check"
        error={
          new ApiError(
            "合成服务技术说明",
            "unsupported_edit_list",
            "synthetic-request",
          )
        }
      />,
    );
    const main = html.split("<details")[0];
    expect(main).toContain("当前检查器尚不能确认");
    expect(main).not.toContain("unsupported_edit_list");
    expect(main).not.toContain("synthetic-request");
    expect(main).not.toContain("合成服务技术说明");
    expect(html).toContain("<summary>管理员技术详情</summary>");
    expect(html).toContain("unsupported_edit_list");
    expect(html).toContain("synthetic-request");
  });

  it("offers a retry button only for causes that can change through rechecking", () => {
    const retry = vi.fn();
    expect(
      renderToStaticMarkup(
        <MediaErrorBox
          stage="check"
          code="unsupported_edit_list"
          retry={retry}
        />,
      ),
    ).not.toContain("<button");
    expect(
      renderToStaticMarkup(
        <MediaErrorBox
          stage="check"
          code="source_check_timeout"
          retry={retry}
        />,
      ),
    ).toContain("<button");
    expect(
      renderToStaticMarkup(
        <MediaErrorBox
          stage="upload"
          error={new ApiError("登录失效", "unauthorized", undefined, 401)}
          retry={retry}
        />,
      ),
    ).not.toContain("<button");
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not surface arbitrary browser diagnostics or URLs as the main error", () => {
    const html = renderToStaticMarkup(
      <MediaErrorBox
        stage="preview"
        error={new Error("https://private.invalid/file?token=synthetic-secret")}
      />,
    );
    expect(html).not.toContain("private.invalid");
    expect(html).not.toContain("synthetic-secret");
    expect(html).toContain("暂不能判断");
  });
});
