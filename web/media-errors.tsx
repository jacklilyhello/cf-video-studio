import type { ReactNode } from "react";
import { ApiError } from "./client";
import { Icon } from "./ui";
import "./media-errors.css";

export type MediaStage =
  "upload" | "check" | "preview" | "faststart" | "processing";
export type MediaAction =
  | "sign-in"
  | "retry-read"
  | "resume-upload"
  | "reconcile-upload"
  | "recheck-source"
  | "inspect-structure"
  | "verify-native"
  | "verify-audio"
  | "verify-video"
  | "replace-source"
  | "review-quote"
  | "verify-stop"
  | "change-browser"
  | "review-output";
export type MediaExplanation = {
  category: string;
  title: string;
  confirmed: string;
  unknown: string;
  directPlayback:
    | "unverified"
    | "blocked-until-complete"
    | "try-private-native"
    | "check-existing-source";
  playback: string;
  action: MediaAction;
  nextStep: string;
  output: "none" | "possible-new-file" | "new-upload";
  encoding:
    "none" | "undetermined" | "audio-if-confirmed" | "video-if-confirmed";
  fileEffect: string;
  processing:
    | "not-needed"
    | "separate-confirmation"
    | "existing-task"
    | "task-unverified";
  processingNote: string;
  retryable: boolean;
  retryLabel: string;
};
export type MediaErrorContext = {
  stage: MediaStage;
  code?: string;
  nativeErrorCode?: number;
  hlsErrorType?: string;
  stopVerified?: boolean;
  startRequest?: boolean;
  retryLabel?: string;
};

const noProcessing =
  "当前诊断和管理员预览不启动 Container；若之后选择云端处理，须另取报价并确认费用。";
const uploadProcessing =
  "上传和恢复上传不重新编码，也不启动 Container；后续处理另行报价和确认费用。";
const processingConfirmation =
  "云端整理或转码会启动 Container，可能产生费用；先另取报价，核对具体方案、费用上界和影响，再单独确认。";
const aliases: Record<string, string> = {
  "Video must be re-encoded to compatible 8-bit H.264.":
    "confirmed_video_transcode_required",
  "Audio must be re-encoded to AAC-LC.": "confirmed_audio_transcode_required",
  "A reliable media duration is unavailable.": "probe_required",
  "A valid video stream is required.": "video_track_required",
  "Multiple video streams or attached artwork require an explicit preservation plan.":
    "preservation_plan_required",
  "Multiple audio tracks require an explicit preservation plan.":
    "preservation_plan_required",
  "Subtitles, attachments, or data streams require an explicit preservation plan.":
    "preservation_plan_required",
  "HDR or Dolby Vision requires an explicit color and metadata plan.":
    "preservation_plan_required",
  "Display rotation requires an explicit orientation preservation plan.":
    "preservation_plan_required",
  "Multichannel audio requires an explicit preservation or downmix plan.":
    "preservation_plan_required",
  "Chapter tracks require an explicit preservation plan.":
    "preservation_plan_required",
  "Attached artwork requires an explicit preservation plan.":
    "preservation_plan_required",
  "Unsupported media metadata requires an explicit preservation plan.":
    "preservation_plan_required",
  "Complex stream side data requires an explicit preservation plan.":
    "preservation_plan_required",
  "Faststart requires a compatible MP4 source.":
    "faststart_container_unsupported",
  "无法核实 Container 已停止；预算预留继续保留，监督重试":
    "container_stop_unverified",
};
function mediaCode(error: unknown, context: MediaErrorContext) {
  if (context.code) return context.code;
  if (error instanceof ApiError) return error.code;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return (
    aliases[message] ||
    (/^[a-z][a-z0-9_]{1,95}$/.test(message) ? message : "media_unknown")
  );
}
const inCodes = (code: string, values: string[]) => values.includes(code);

/** The action fields are evidence decisions, not permissions to process media. */
export function explainMediaError(
  error: unknown,
  context: MediaErrorContext,
): MediaExplanation {
  const code = mediaCode(error, context);
  const upload = context.stage === "upload";
  const retryLabel =
    context.retryLabel ||
    (context.stage === "check"
      ? "重新检查原片"
      : context.stage === "preview"
        ? "重新加载"
        : upload
          ? "重试"
          : "刷新");
  const base: MediaExplanation = {
    category: "unknown",
    title: upload ? "上传结果暂不能确认" : "暂不能判断这份媒体是否需要处理",
    confirmed: upload
      ? "本次上传操作没有取得可核实的结果。"
      : "当前操作未完成，现有证据不足以确认原因。",
    unknown: "暂不能判断是否需要转码，也不能据此认定原片损坏。",
    directPlayback: upload ? "blocked-until-complete" : "unverified",
    playback: upload
      ? "完整原片保存核实后，仍可先检查和预览原片。"
      : "原片直接播放尚未确认；先核对原片身份、结构和读取结果。",
    action: upload ? "reconcile-upload" : "inspect-structure",
    nextStep: upload
      ? "点击“刷新清单”，按文件名和上传编号核对；有可恢复任务时重选同一原文件继续。"
      : "打开“检查并预览原片”，核对当前原片身份和检查结果；读取异常时先查看技术详情与“日志与诊断”，媒体连接诊断需结构检查通过且页面提供入口后才可执行。",
    output: "none",
    encoding: "undetermined",
    fileEffect:
      "诊断本身不生成新文件；是否需要无损整理或重新编码，须取得进一步证据。",
    processing: "not-needed",
    processingNote: upload ? uploadProcessing : noProcessing,
    retryable: false,
    retryLabel,
  };
  const result = (change: Partial<MediaExplanation>): MediaExplanation => ({
    ...base,
    ...change,
  });
  if (
    (error instanceof ApiError && error.status === 401) ||
    inCodes(code, [
      "unauthorized",
      "auth_required",
      "session_expired",
      "csrf_invalid",
      "admin_required",
    ])
  )
    return result({
      category: "session",
      title: "管理员登录或操作凭据已失效",
      confirmed: "服务器未允许当前读取或操作。",
      unknown: "尚未完成媒体检查，这不是编码或文件损坏结论。",
      action: "sign-in",
      nextStep: "重新登录管理员后，返回当前视频或上传任务继续核对。",
      fileEffect: "重新登录不生成新文件，也不重新编码。",
      encoding: "none",
    });
  if (
    context.startRequest &&
    (inCodes(code, [
      "request_timeout",
      "request_failed",
      "request_aborted",
      "media_unknown",
    ]) ||
      error instanceof TypeError)
  )
    return result({
      category: "start-unverified",
      title: "处理确认请求的结果尚未核实",
      confirmed:
        "确认请求没有取得可靠响应；服务器可能已经创建或启动了这一个任务。",
      unknown:
        "尚不能确认任务是否启动、是否已经产生费用，也不能认定媒体需要转码。",
      directPlayback: "check-existing-source",
      action: "review-output",
      nextStep:
        "先打开“处理任务”，按当前视频和报价核对已有任务及停止证据；不要重新创建另一个收费任务。",
      fileEffect:
        "核对不生成新文件；已有产物是否可用以完整校验结果为准，原片保留。",
      processing: "task-unverified",
      processingNote:
        "任务可能已启动 Container 并产生费用；先核实同一任务，不自动重启或扩大费用授权。",
      retryable: false,
    });
  if (
    inCodes(code, [
      "request_timeout",
      "request_aborted",
      "request_failed",
      "upload_network",
      "upload_timeout",
      "upload_response_invalid",
      "source_check_timeout",
      "source_read_unverified",
      "source_response_unverified",
      "mp4_check_timeout",
    ]) ||
    (error instanceof TypeError && /fetch|network|load/i.test(error.message))
  )
    return result({
      category: "read",
      title: upload ? "上传连接或响应未完成" : "媒体读取或检查未完成",
      confirmed: "本次网络、范围读取或响应核对未完成。",
      unknown: "尚未判定编码兼容性和文件完整性；不能据此建议转码。",
      action: upload ? "resume-upload" : "retry-read",
      nextStep: upload
        ? context.retryLabel
          ? `检查网络和登录后，点击“${retryLabel}”重新取得当前数据；核对已有上传与空间后再继续，不另建重复上传。`
          : "检查网络和登录后，点击“重试”或重选同一原文件继续；已有分片会先核对再复用。"
        : context.stage === "check"
          ? `检查网络和登录后，点击“${retryLabel}”。媒体连接诊断仅在结构检查通过后可用；当前仍失败时，展开技术详情，在“日志与诊断”核对本次原片检查请求。`
          : context.stage === "preview"
            ? `检查网络和登录后，点击“${retryLabel}”；若页面提供媒体连接诊断，可点“检查媒体连接”核对 HEAD 与范围读取。没有入口时返回“检查并预览原片”核对原片读取。`
            : `检查网络和登录后，刷新页面或点击“${retryLabel}”重新取得当前数据；先核对已有任务，再重新获取报价。`,
      encoding: "none",
      fileEffect: "重试读取或继续上传不会重新编码，也不会另建一份原片。",
      retryable: true,
    });
  if (code === "source_version_creation_unverified")
    return result({
      category: "source-version-unverified",
      title: "原片播放版本的建立结果尚未核实",
      confirmed:
        "建立版本请求没有取得可靠响应；服务器可能已建立共用同一原片的版本。",
      unknown:
        "尚不能将响应超时视为创建失败，也不能宣称已有版本通过了新一次浏览器验收。",
      directPlayback: "check-existing-source",
      action: "recheck-source",
      nextStep:
        "关闭预览，回到同一视频并刷新页面，核对是否已经出现对应原片版本；已有版本先核对身份和预览结果，不重复创建或自动发布。",
      encoding: "none",
      fileEffect:
        "原片播放版本共用原文件，不生成新媒体文件、不重新编码，也不会自动发布。",
    });
  if (
    inCodes(code, [
      "completion_unverified",
      "upload_unknown",
      "creation_unverified",
      "multipart_create_unverified",
    ])
  )
    return result({
      category: "upload-unverified",
      title: "上传保存结果尚未核实",
      confirmed:
        "创建或完成上传的响应未得到可靠确认；服务器可能已保存任务或原片。",
      unknown: "尚不能据此判断保存失败或原片损坏。",
      action: "reconcile-upload",
      nextStep:
        "点击“核对保存结果”或“刷新清单”，重选同一原文件按指纹核对；复用已有上传和分片，不要另建重复上传。",
      encoding: "none",
      fileEffect: "核对操作不重新编码；确认已有完整原片时直接复用。",
      retryable: true,
    });
  if (inCodes(code, ["abort_unverified", "upload_cancel_unverified"]))
    return result({
      category: "upload-cancel",
      title: "上传取消结果尚未核实",
      confirmed: "尚未取得终止上传的可靠结果，空间预留继续保留。",
      unknown: "不能视为已经取消，也不是原片兼容性问题。",
      action: "reconcile-upload",
      nextStep:
        "点击“刷新清单”，按文件名和上传编号找到任务后再点“取消”，核对最终状态。",
      encoding: "none",
      fileEffect: "此操作核对未完成上传，不生成播放文件或重新编码。",
      retryable: true,
    });
  if (code === "already_complete")
    return result({
      category: "upload-complete",
      title: "上传已完成，不能按未完成上传取消",
      confirmed: "服务器已确认这个上传保存完成，取消未完成任务的操作没有执行。",
      unknown: "完成保存不代表已通过媒体兼容性和浏览器实播检查。",
      directPlayback: "check-existing-source",
      action: "reconcile-upload",
      nextStep:
        "刷新视频库找到该原片，点击“检查并预览原片”；如需清理文件，应另行核对存储清理范围，不能重复取消已完成上传。",
      encoding: "none",
      fileEffect: "核对已保存原片不生成新文件，也不重新编码。",
    });
  if (
    inCodes(code, [
      "hash_required",
      "invalid_fingerprint",
      "part_size",
      "part_hash",
      "part_conflict",
      "object_conflict",
      "upload_file_mismatch",
    ])
  )
    return result({
      category: "upload-integrity",
      title: "上传内容与校验记录不一致",
      confirmed: "分片大小、校验值或所选文件身份未通过上传核对。",
      unknown: "尚未确认完整原片已保存，这不等于视频编码不兼容。",
      action: "resume-upload",
      nextStep:
        code === "part_hash"
          ? "检查网络后点击“重试”，重新读取并校验该分片；仍失败时重选原文件核对。"
          : "重选同一原文件核对；若确认选错文件，按上传编号取消未完成任务后选择正确原文件。",
      encoding: "none",
      fileEffect: "恢复上传保留原编码；只有重新上传才会保存新的原片。",
      retryable: code === "part_hash",
    });
  if (
    inCodes(code, [
      "parts_missing",
      "source_unavailable",
      "source_missing",
      "upload_state",
      "upload_missing",
    ])
  )
    return result({
      category: "source-unavailable",
      title: "完整原片尚不可用",
      confirmed: "当前没有可用的完整原片记录，或上传仍缺少分片。",
      unknown: "尚不能检查完整文件，也不能判断是否需要转码。",
      directPlayback: "blocked-until-complete",
      action: "resume-upload",
      nextStep:
        "点击“刷新清单”核对上传状态；未完成时重选同一原文件继续，完成后再点“检查并预览原片”。",
      encoding: "none",
      fileEffect: "继续上传不重新编码；已保存的同一文件会先核对再复用。",
    });
  if (code === "completed_source_changed")
    return result({
      category: "identity",
      title: "已完成上传对应的原片已变化或不可用",
      confirmed:
        "已完成任务保存的原片身份与当前实际对象不一致，不能复用旧完成结果。",
      unknown: "尚未确认当前可用原片，也不是原文件必须转码的证据。",
      directPlayback: "blocked-until-complete",
      action: "recheck-source",
      nextStep:
        "刷新视频管理核对原片身份；原片确实缺失或不是所需文件时，重选正确本地原片建立新上传，再检查预览。已有播放版本保留。",
      output: "new-upload",
      encoding: "none",
      fileEffect: "新上传保存独立原片且不重新编码；不删除或覆盖已有播放版本。",
    });
  if (code === "source_changed")
    return result({
      category: "identity",
      title: "当前文件与检查或报价记录不一致",
      confirmed:
        "文件修订、大小、校验标识或对象登记发生变化，旧证据不能继续使用。",
      unknown: "当前文件的可播放性尚未重新确认。",
      action: "recheck-source",
      nextStep:
        "刷新视频管理并核对原片身份，然后点击“重新检查原片”；涉及处理时关闭旧报价，重新获取该原片的报价。",
      encoding: "none",
      fileEffect: "刷新和重新检查不生成新文件，也不覆盖原片。",
      retryable: true,
    });
  if (code === "video_track_required")
    return result({
      category: "video-track-unverified",
      title: "当前检查未确认有效的视频轨道",
      confirmed: "检查或可信探测没有取得所需的有效视频轨道与画面尺寸。",
      unknown:
        "需区分原文件没有视频轨道与当前解析未识别；不能直接认定需要转码或文件损坏。",
      action: "inspect-structure",
      nextStep:
        "查看技术详情中的轨道和原片身份，核对本地文件是否确实包含视频画面；解析能力不足时先修复检查支持，确实选错或缺少视频轨道时更换正确原片。",
      fileEffect:
        "当前诊断不生成新文件；转码不能凭空恢复原文件中不存在的视频轨道。",
    });
  if (
    inCodes(code, [
      "preservation_plan_required",
      "unsupported_track_count",
      "unsupported_track_type",
      "unsupported_video_transform",
    ])
  )
    return result({
      category: "preservation",
      title: "需要先确认轨道和媒体信息的保留方案",
      confirmed:
        "检查或探测发现额外轨道、方向、色彩、声道、媒体元数据或流侧信息，当前默认处理范围不能证明会完整保留。",
      unknown:
        "尚不能判断是否需要转码；不能默认丢弃音轨、字幕、旋转或 HDR 信息。",
      directPlayback: "try-private-native",
      action: "inspect-structure",
      nextStep:
        "展开技术详情核对具体轨道和媒体信息；先评估原片私有预览，确需处理时明确要保留的内容、画面方向与音视频关系，再重新报价。",
      output: "possible-new-file",
      fileEffect:
        "当前诊断不生成新文件；整理可否保持编码取决于保留方案，不自动执行降混、丢轨或全片重编码。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
    });
  if (
    inCodes(code, [
      "encrypted_samples",
      "encrypted_or_grouped_fragment_samples",
      "external_data_reference",
      "fragmented_or_encrypted_mp4",
    ])
  )
    return result({
      category: "self-contained-unverified",
      title: "原片的自包含媒体数据尚未核实",
      confirmed: "检查遇到加密、分组、外部数据引用，或无法区分的分片结构。",
      unknown: "当前检查不能保证完整读取与播放，不能直接认定需要转码。",
      action: "inspect-structure",
      nextStep:
        "核对技术详情和原文件来源；确认是否为完整、可读取的自包含原片，再评估检查器支持和私有预览路径。",
      fileEffect: "诊断不生成新文件；不自动解密、丢弃媒体信息或重新编码。",
    });
  if (
    code === "confirmed_audio_transcode_required" ||
    code === "confirmed_video_transcode_required"
  ) {
    const audio = code === "confirmed_audio_transcode_required";
    return result({
      category: audio ? "audio-transcode" : "video-transcode",
      title: audio
        ? "处理探测确认音频轨道不符合当前输出要求"
        : "处理探测确认视频轨道不符合当前输出要求",
      confirmed: audio
        ? "可信处理探测发现音频不是当前输出要求的 AAC-LC。"
        : "可信处理探测发现视频不符合当前输出要求的 8 位 H.264。",
      unknown: "这是当前处理输出的要求；原片能否在指定浏览器播放仍需单独验证。",
      directPlayback: "try-private-native",
      playback:
        "可以先评估管理员私有原片预览；不能据此确认所有浏览器都不兼容。",
      action: audio ? "verify-audio" : "verify-video",
      nextStep: audio
        ? "核对音频轨道与浏览器实播；确需转换时先评估仅处理音频、复制视频的方案。现有任务若不能按轨道处理，不得直接确认全片转码。"
        : "核对视频轨道与浏览器实播；确需转换时评估视频编码方案，并保留已兼容音频。处理范围改变须重新报价。",
      output: "possible-new-file",
      encoding: audio ? "audio-if-confirmed" : "video-if-confirmed",
      fileEffect: "确认处理后会生成独立文件并重新编码对应轨道；原片保留。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
    });
  }
  if (
    inCodes(code, [
      "unsupported_audio_codec",
      "unsupported_audio_codec_or_channels",
      "unsupported_aac_profile",
      "unsupported_audio_descriptor",
      "unsupported_video_codec",
      "unsupported_avc_profile",
      "unsupported_avc_bit_depth",
      "unsupported_dimensions",
      "unsupported_hdr_or_encryption",
      "unsupported_color_metadata",
    ])
  ) {
    const audio = code.includes("audio") || code.includes("aac");
    return result({
      category: audio ? "audio-support" : "video-support",
      title: audio
        ? "音频轨道超出当前检查支持范围"
        : "视频轨道超出当前检查支持范围",
      confirmed: audio
        ? "当前检查器未支持这条音频轨道的编码、配置或声道布局。"
        : "当前检查器未支持这条视频轨道的编码、配置或画面参数。",
      unknown: "这还不是浏览器实播不兼容的证据；暂不能判断是否需要转码。",
      directPlayback: "try-private-native",
      playback:
        "先核对具体轨道和浏览器能力；有受控原生预览路径时，可在管理员私有预览验证。",
      action: audio ? "verify-audio" : "verify-video",
      nextStep: audio
        ? "查看技术详情中的音频信息，验证原生预览的声音；确认音频不兼容后才评估仅处理音频，保留可兼容的视频。"
        : "查看技术详情中的视频信息，验证原生预览的首帧、拖动和画面；确认视频不兼容后才评估视频转码，避免重编码已兼容音频。",
      output: "possible-new-file",
      encoding: "undetermined",
      fileEffect:
        "当前诊断不生成新文件；只有确认对应轨道确需转换后，才生成独立版本并重新编码该轨道。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
    });
  }
  if (code === "unsupported_source_container")
    return result({
      category: "source-container-unsupported",
      title: "当前 MP4 检查路径不支持这份原片容器",
      confirmed:
        "已识别到 EBML 容器标识（常见于 WebM/Matroska）；当前检查路径只进行 MP4 结构检查。",
      unknown:
        "尚未核实具体容器类型、轨道编码和文件完整性；当前浏览器能否原生播放仍未知，暂不能判断是否需要转码。这个标识本身不能证明文件损坏。",
      directPlayback: "try-private-native",
      playback:
        "继续优先评估原片播放；维护人员提供适合该容器的受控管理员原生预览路径后，再验证同一原片的画面、声音和拖动。当前 MP4 检查窗口不能给出直接播放通过结论。",
      action: "inspect-structure",
      nextStep:
        "展开技术详情核对原片身份，由维护人员评估适合该容器的检查和私有预览路径，先核对轨道编码与实播。重新上传同一文件或反复重试不会改变固定的容器支持限制。",
      output: "possible-new-file",
      encoding: "undetermined",
      fileEffect:
        "当前诊断保留原文件。若需整理为另一种封装，能否仅复制码流取决于轨道编码和目标封装兼容性，尚未验证，不能保证无损整理成功；只有确认具体轨道不兼容后才评估对应轨道重新编码。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
      retryable: false,
    });
  if (
    code === "faststart_container_unsupported" ||
    code === "box_limit_or_truncation" ||
    code.startsWith("unsupported_") ||
    /(?:^|_)(?:metadata|table|box|fragment|sample|reordering|index|count|run)_limit$/.test(
      code,
    )
  )
    return result({
      category: "inspection-limit",
      title:
        code === "unsupported_edit_list"
          ? "当前检查器尚不能确认这份时间轴"
          : "文件结构超出当前检查器支持范围",
      confirmed:
        code === "unsupported_edit_list"
          ? "检查在编辑列表或音视频时间轴核验处停止；这可能是合法结构的程序支持限制。"
          : "有界元数据检查遇到尚未支持的结构、参数或检查上限。",
      unknown: "没有证据证明原片损坏；暂不能判断是否需要转码或无损整理。",
      directPlayback: "try-private-native",
      playback:
        "优先核对结构并完善检查支持；经安全核对且提供原生预览路径时，可在管理员私有预览验证。",
      action: "inspect-structure",
      nextStep:
        "展开技术详情，核对当前文件身份、轨道和时间轴；确定限制后修复检查支持或验证原生路径。固定格式限制不会因反复重新检查而消失。",
      output: "possible-new-file",
      encoding: "undetermined",
      fileEffect:
        "不要删除或忽略编辑列表。只有证据表明需要封装或时间轴整理时才评估保留编码的新文件，成功与否仍需验证。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
    });
  if (
    inCodes(code, [
      "sample_outside_mdat",
      "fragment_sample_outside_mdat",
      "overlapping_samples",
      "overlapping_fragment_samples",
      "invalid_mp4_size",
      "invalid_box_size",
      "truncated_metadata",
      "truncated_fragment_metadata",
      "not_complete_mp4",
    ])
  )
    return result({
      category: "structure-incomplete",
      title: "文件结构或完整性核验未通过",
      confirmed:
        "读取到的结构存在长度不足、索引范围冲突或媒体样本越界等证据；详情列出具体触发点。",
      unknown:
        "还需区分读取未完成、封装错误与实际文件损坏；暂不能判断是否需要转码。",
      action: "replace-source",
      nextStep:
        "先核对实际文件大小、原片身份与检查请求的技术详情；媒体连接诊断仅在结构检查通过且提供入口后可执行。当前无法进入诊断时，在“日志与诊断”核对读取结果；读取完整仍有同一结构错误时，检查本地原文件，重新上传完整文件或更换来源。",
      output: "new-upload",
      encoding: "undetermined",
      fileEffect:
        "重新上传保留原编码；转码不能恢复缺失的原始数据，不应作为默认修复。",
    });
  if (
    /(?:timeline|duration|sequence|presentation|decode)_mismatch$|(?:timeline|sequence|presentation|decode)_discontinuity$/.test(
      code,
    ) ||
    inCodes(code, [
      "invalid_time_table",
      "invalid_composition_table",
      "invalid_duration",
      "chunk_sample_mismatch",
    ])
  )
    return result({
      category: "timeline",
      title: "封装时间轴或样本记录未通过一致性检查",
      confirmed: "元数据中的时长、样本次序或音视频时间关系未通过当前核验。",
      unknown:
        "需继续核对结构与解码结果；暂不能保证无损整理成功，也不能直接认定必须转码。",
      directPlayback: "try-private-native",
      action: "inspect-structure",
      nextStep:
        "核对技术详情中的轨道时间轴和实际原片；优先评估保留码流、保留音视频偏移的整理方案，再验证首帧、拖动、结尾和同步。",
      output: "possible-new-file",
      encoding: "undetermined",
      fileEffect:
        "无损整理若可行，会生成独立封装文件且不重新编码；只有进一步证据确认编码问题时才评估对应轨道转码。",
      processing: "separate-confirmation",
      processingNote: processingConfirmation,
    });
  if (code === "playback_hls_unsupported")
    return result({
      category: "browser-path-unsupported",
      title: "当前浏览器不支持此 HLS 播放路径",
      confirmed: "浏览器原生 HLS 与当前播放适配器的能力检查均未通过。",
      unknown: "这是当前浏览器播放路径的限制，不是原片损坏或必须转码的证据。",
      directPlayback: "check-existing-source",
      action: "change-browser",
      nextStep:
        "使用支持此播放方式的另一款浏览器打开同一视频；管理员也可回到同一原片的“检查并预览原片”评估原生路径。反复重新加载不会改变已确认的浏览器能力限制。",
      encoding: "none",
      fileEffect:
        "更换浏览器或核对原片不生成新文件、不重新编码，也不改变当前播放版本。",
      retryable: false,
    });
  if (
    inCodes(code, [
      "playback_native_error",
      "playback_hls_fatal",
      "playback_loader_failed",
      "playback_mse_failed",
    ])
  ) {
    const network =
      context.nativeErrorCode === 2 || context.hlsErrorType === "networkError";
    return result({
      category: network ? "playback-read" : "playback-unverified",
      title: network ? "播放器读取媒体失败" : "当前播放路径未能完成播放",
      confirmed: network
        ? "浏览器报告媒体网络读取失败。"
        : "浏览器或播放适配器报告失败；结构检查通过不代表实际解码成功。",
      unknown: network
        ? "尚未确认网络、登录或读取服务的具体原因，不能据此建议转码。"
        : "尚未区分浏览器兼容性、读取、封装或编码问题；暂不能判断是否需要转码。",
      directPlayback: "try-private-native",
      action: network ? "retry-read" : "verify-native",
      nextStep: network
        ? "检查网络和管理员登录后点击“重新加载”；若页面提供媒体连接诊断，可点“检查媒体连接”核对范围读取。没有入口时返回同一原片的“检查并预览原片”。"
        : "先查看技术详情；若页面提供媒体连接诊断，可点“检查媒体连接”核对读取。若提供“使用原生播放重试”，可验证同一原文件的另一播放路径，再检查具体轨道。",
      fileEffect:
        "切换播放路径或诊断不生成新文件、不重新编码，也不改变正式播放版本。",
      retryable: true,
    });
  }
  if (
    inCodes(code, ["source_attestation_required", "mp4_attestation_required"])
  )
    return result({
      category: "attestation",
      title: "这个确切版本尚未完成管理员播放确认",
      confirmed: "缺少该版本的播放、拖动或声音人工确认。",
      unknown: "结构记录不能代替浏览器实播和人工听音。",
      directPlayback: "check-existing-source",
      action: "verify-native",
      nextStep:
        "打开当前版本预览，核对画面、声音和拖动后勾选确认；只确认亲自核实的结果。",
      encoding: "none",
      fileEffect: "播放确认不生成新媒体文件，也不重新编码。",
    });
  if (code === "source_proof_unverified")
    return result({
      category: "source-proof",
      title: "当前原片检查证据尚未完整保存或核实",
      confirmed: "本次结构检查记录与当前原片身份尚未完成可靠绑定。",
      unknown: "不能沿用旧检查记录建立播放版本，也不能据此认定需要转码。",
      action: "recheck-source",
      nextStep:
        "核对原片名称和身份后点击“重新检查原片”，待本次检查保存完成，再验证同一原片的播放、拖动与声音。",
      encoding: "none",
      fileEffect: "重新检查不生成新媒体文件，不重新编码或覆盖原片。",
      retryable: true,
    });
  if (
    inCodes(code, [
      "source_version_unverified",
      "mp4_changed",
      "mp4_incomplete",
      "mp4_unverified",
      "mp4_invalid",
      "output_invalid",
      "output_conflict",
      "object_mismatch",
      "completion_invalid",
      "validation_missing",
      "manifest_invalid",
      "manifest_missing",
      "manifest_changed",
      "inventory_invalid",
    ])
  )
    return result({
      category: "output-unverified",
      title: "媒体版本的完整校验证据不足或不一致",
      confirmed:
        "当前版本的文件、清单、结构或校验记录未通过核对，不能作为已验证版本发布。",
      unknown: "尚不能认定原片需要转码，也不能把未核实产物当成可播放文件。",
      directPlayback: "check-existing-source",
      action: "review-output",
      nextStep:
        "刷新视频管理，核对本版本任务和技术详情；原片仍完整时可另行检查并私有预览原片。处理产物需先查清失败原因。",
      encoding: "undetermined",
      fileEffect:
        "核对不会覆盖原片；重新生成产物需独立方案，是否重编码取决于确认的处理方式。",
      processing:
        context.stage === "processing" || context.stage === "faststart"
          ? "existing-task"
          : "not-needed",
      processingNote:
        "已有处理任务可能已产生费用；先核对任务和实例停止证据。重新生成须重新报价、确认费用，不自动重启 Container。",
    });
  if (inCodes(code, ["cancel_unverified", "container_stop_unverified"]))
    return result({
      category: "stop-unverified",
      title: "处理实例停止尚未核实",
      confirmed: "停止请求没有取得可靠的停止证据，预算预留继续保留。",
      unknown: "不能宣称实例已经停止或费用已经结束。",
      action: "verify-stop",
      nextStep:
        "在“处理任务”刷新当前任务，必要时再次点击“取消任务”核对停止；不要重复启动新任务。",
      directPlayback: "check-existing-source",
      fileEffect: "停止核对不重新编码；原片与已核实版本保留。",
      encoding: "none",
      processing: "existing-task",
      processingNote:
        "已有 Container 可能仍在运行并产生费用；停止核实前保留预算，不自动重新启动。",
      retryable: true,
    });
  const admission: Record<string, [string, string, string]> = {
    processing_disabled: [
      "视频处理总开关已关闭",
      "当前环境禁止启动云端处理。",
      "先检查和预览原片；只有取得这一个任务的处理与费用授权后，才由管理员按部署配置开启处理并重新报价。",
    ],
    processor_unconfigured: [
      "当前环境的处理器尚未配置完成",
      "服务器没有可用的 Container 处理配置。",
      "先使用原片检查和私有预览；需要云端处理时由维护人员核对测试环境部署与处理器配置，再重新报价。",
    ],
    processing_busy: [
      "处理槽位暂被已有任务占用",
      "已有任务或停止待核实实例占用了并发槽位。",
      "打开“处理任务”核对已有任务；等待结束并核实实例停止后重新获取报价，不重复启动任务。",
    ],
    job_active: [
      "此视频已有尚未结束的处理任务",
      "当前视频已有运行中或停止尚未核实的任务。",
      "打开“处理任务”核对同一视频的任务和停止证据；需要取消时点“取消任务”，停止核实后再重新报价。",
    ],
    deployment_busy: [
      "部署核验期间暂不能确认处理",
      "发布互斥保护正在阻止新处理任务启动。",
      "等待测试部署核验结束，刷新当前视频并重新确认有效报价；不要重复触发部署或任务启动。",
    ],
    budget_unknown: [
      "本任务的资源额度尚不能可靠确认",
      "账户用量、包含额度、账期或项目存储证据不完整，不能核实本任务的可用额度。",
      "查看“资源用量”中的来源、覆盖与缺口，等待自动核验后重新报价；若确需承担额外费用，应针对这一个任务另行确认具体费用风险。",
    ],
    budget_exceeded: [
      "当前已核实额度不能覆盖这一个处理任务",
      "计划资源消耗超过当前可用额度与保留余量。",
      "查看报价的资源范围与费用上界，等待额度恢复或另行确认具体方案；不要通过提高预算绕过本次核验。",
    ],
    capacity_unknown: [
      "处理规格的账户容量尚不能确认",
      "当前账户的 Container 可用容量未通过核验。",
      "核对测试环境账户容量与已有实例状态，证据恢复后重新报价；不能把未知容量视为可用或免费。",
    ],
    processing_resources: [
      "原片超出当前处理规格范围",
      "输入、输出、镜像、临时空间或内存超过当前受支持规格。",
      "先评估原片直接播放；确需处理时提出具体规格和费用方案并另行确认，不能自动升配。",
    ],
    project_storage_unknown: [
      "项目存储占用或预留尚未核实",
      "项目空间上限、实际对象目录或在途预留数据不完整。",
      "打开“R2 存储”核对目录与预留，再点“刷新空间”；不能把未知空间当作零占用。",
    ],
    storage_limit: [
      "项目剩余空间不足以容纳此次操作",
      "原片、已有文件和上传或处理预留加上本次新增空间超过项目上限。",
      "核对“R2 存储”和上传清单中的占用、预留与本次新增空间；调整方案须另行确认，不自动删除文件或提高上限。",
    ],
    output_budget: [
      "处理产物超出本任务已确认范围",
      "产物大小或数量超过报价确认的输出上限。",
      "打开“处理任务”核对实例停止和产物诊断；需要更大输出范围时重新给出方案与费用并单独确认。",
    ],
    quote_missing: [
      "当前处理报价不存在",
      "服务器无法找到这个报价。",
      "关闭报价弹窗，回到同一视频点击“获取处理报价”，重新核对方案和费用。",
    ],
    quote_expired: [
      "当前处理报价已过期",
      "报价已超过有效时间，旧费用和资源核验不能用于启动。",
      "关闭弹窗，点击“获取处理报价”，核对最新范围和费用后再确认。",
    ],
    quote_consumed: [
      "当前处理报价已使用或失效",
      "这个报价已不能创建新的处理任务。",
      "先在“处理任务”核对是否已有同一报价对应的任务；确需另一次处理时重新获取报价，避免重复收费。",
    ],
    quote_changed: [
      "处理报价与当前范围不一致",
      "原片、资源预留、输出范围或费用核验条件已变化。",
      "关闭旧报价，核对当前原片和任务，重新点击“获取处理报价”；不得沿用旧确认扩大范围。",
    ],
    quote_requires_review: [
      "当前方案仍需独立核对费用授权",
      "当前费用证据不能证明任务完全处于已授权范围。",
      "核对这一个任务的方式、规格、总时限、费用范围和风险，再单独确认；勾选报价弹窗不会扩大费用政策。",
    ],
    billing_period_boundary: [
      "任务最长运行时间可能跨账期",
      "当前报价不能在同一已核实账期内覆盖任务总时限。",
      "等待新账期确认后重新获取报价；不要沿用旧账期用量或擅自缩短核验时限。",
    ],
    probe_required: [
      "处理方案缺少可信媒体探测信息",
      "时长、分辨率或轨道信息不足，不能直接确定转码范围。",
      "先“检查并预览原片”；仍需云端探测时，该探测任务也须获取报价并确认费用，保存可信结果后再评估按轨道处理。",
    ],
    probe_missing: [
      "转码报价缺少绑定的可信探测结果",
      "当前报价没有可用于核对原片的可信媒体探测记录。",
      "回到同一原片核对已有探测结果；需要新探测时先报价并确认探测费用，再重新获取处理报价。",
    ],
    processing_single_put_limit: [
      "原片或产物超出当前处理传输范围",
      "本方案的单对象输出或传输大小超过当前实现支持范围。",
      "先评估原片直接播放；确需处理时由维护人员评估受支持的输出方案和费用，不自动提高规格。",
    ],
    upload_size: [
      "文件大小不在上传支持范围",
      "所选文件超过 20 GiB 硬上限，或大小无效。",
      "选择完整且大小在支持范围内的原文件；不要反复重试同一超限文件。",
    ],
    upscale_denied: [
      "所选输出分辨率高于原片",
      "可信探测显示原片分辨率不足以达到当前选择，默认禁止放大。",
      "选择“原分辨率”或不高于原片的画质，再重新获取报价；是否转码仍由实际兼容性决定。",
    ],
  };
  const blocked = admission[code];
  if (
    blocked ||
    inCodes(code, [
      "quote_invalid",
      "concurrency_invalid",
      "start_denied",
      "invalid_processing",
      "invalid_timeout",
      "invalid_budget",
    ])
  )
    return result({
      category: "admission",
      title: blocked?.[0] || "当前处理配置或授权未通过核验",
      confirmed: blocked?.[1] || "处理参数、并发设置、总时限或启动授权无效。",
      unknown:
        "这不是媒体损坏或必须转码的证据；已记录用量也不代表取得全账户剩余额度。",
      directPlayback: "check-existing-source",
      action: "review-quote",
      nextStep:
        blocked?.[2] ||
        "核对处理配置和当前任务授权；由维护人员修复具体配置后重新获取有效报价，不重复点击启动。",
      encoding: "none",
      fileEffect: "当前操作不生成新媒体文件；完整原片仍可先检查和私有预览。",
      processing: upload ? "not-needed" : "separate-confirmation",
      processingNote: upload
        ? uploadProcessing
        : "本次失败不授权提高预算、开启付费模式或启动任务。云端处理必须在条件核实后单独确认报价与费用。",
    });
  if (context.stage === "processing" || context.stage === "faststart")
    return result({
      category: "processing-unverified",
      title: "处理未完成，需先核对任务结果",
      confirmed: "处理任务报告异常；已生成产物不能视为通过完整校验。",
      unknown: "暂不能判断是否需要转码；也不能仅凭失败消息认定原片损坏。",
      directPlayback: "check-existing-source",
      action: "review-output",
      nextStep:
        "打开“处理任务”核对阶段、技术详情和停止证据；原片完整时先检查并预览。查清原因后再评估整理或按轨道转换方案。",
      output: "possible-new-file",
      fileEffect:
        "重新处理将生成独立产物；是否重新编码依确认方案，不能自动升级为全片转码。",
      processing: "existing-task",
      processingNote: context.stopVerified
        ? "实例已核实停止，已经产生的费用仍保留；重做须重新报价和确认，不自动重启 Container。"
        : "实例停止尚未核实，预算预留继续保留；可能仍产生费用，先核对停止，再单独报价和确认重做。",
    });
  return base;
}

export function MediaErrorBox({
  error,
  retry,
  technicalDetails,
  ...context
}: MediaErrorContext & {
  error?: unknown;
  retry?: () => void;
  technicalDetails?: ReactNode;
}) {
  if (!error && !context.code) return null;
  const explanation = explainMediaError(error, context);
  const code = mediaCode(error, context);
  return (
    <div className="error-box media-error-box" role="alert">
      <Icon name="info" />
      <div>
        <strong>{explanation.title}</strong>
        <p>
          {explanation.confirmed} {explanation.unknown}
        </p>
        <p>{explanation.playback}</p>
        <p>
          <b>下一步：</b>
          {explanation.nextStep}
        </p>
        <p>
          {explanation.fileEffect} {explanation.processingNote}
        </p>
        <details className="media-error-details">
          <summary>管理员技术详情</summary>
          <small>代码：{code}</small>
          {error instanceof ApiError && (
            <small>服务说明：{error.message}</small>
          )}
          {error instanceof ApiError && error.requestId && (
            <small>请求编号：{error.requestId}</small>
          )}
          {context.nativeErrorCode !== undefined && (
            <small>浏览器媒体错误：{context.nativeErrorCode}</small>
          )}
          {context.hlsErrorType && (
            <small>播放错误类型：{context.hlsErrorType}</small>
          )}
          {technicalDetails}
        </details>
        {retry && explanation.retryable && (
          <button className="button small" onClick={retry}>
            {explanation.retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
