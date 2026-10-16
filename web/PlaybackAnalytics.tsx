import { useState } from "react";
import { date, duration, useLoad } from "./client";
import {
  Empty,
  ErrorBox,
  Icon,
  Loading,
  Modal,
  Notice,
  Pagination,
} from "./ui";
import "./playback-analytics.css";

type Summary = {
  visits: number;
  visitors: number;
  attempts?: number;
  plays: number;
  viewers: number;
  watchedSeconds: number;
  completed: number;
  startupMs: number | null;
  errors: number;
  stalls: number;
  recentActive: number;
};
type Session = {
  id: string;
  started_at: number;
  last_at: number;
  video_id: string;
  title: string | null;
  version_id: string;
  host: string;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  ua: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  referrer_host: string | null;
  started: number;
  watched_seconds: number;
  duration: number | null;
  completed: number;
  startup_ms: number | null;
  errors: number;
  stalls: number;
  result: string;
};
type Analytics = {
  range: { start: number; end: number; label: string };
  summary: Summary;
  trend: {
    day: string;
    visits: number;
    plays: number;
    watchedSeconds: number;
  }[];
  videos: {
    videoId: string;
    title: string;
    plays: number;
    watchedSeconds: number;
    completed: number;
  }[];
  hosts: { host: string; visits: number; plays: number }[];
  countries: { country: string; plays: number }[];
  browsers: { browser: string; plays: number }[];
  systems: { os: string; plays: number }[];
  devices: { device: string; plays: number }[];
  sessions: { items: Session[]; total: number; page: number; pageSize: number };
  coverage: {
    since: number | null;
    detailDays: number;
    aggregateDays: string;
    note: string;
  };
};
const number = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-CN");
const time = (seconds: number) =>
  seconds >= 3600
    ? `${(seconds / 3600).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时`
    : seconds >= 60
      ? `${(seconds / 60).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分钟`
      : `${Math.round(seconds)} 秒`;
const startup = (value: number | null) =>
  value == null
    ? "暂无记录"
    : `${(value / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒`;
const display = (value: string | number | null | undefined) =>
  value == null || value === "" || value === "unknown" ? "未知" : String(value);
const deviceNames: Record<string, string> = {
  desktop: "电脑",
  mobile: "手机",
  tablet: "平板",
  bot: "自动化",
  other: "其他",
  unknown: "未知",
};
function Cards({
  summary,
  compact = false,
}: {
  summary: Summary;
  compact?: boolean;
}) {
  const stats = [
    ["访问人数", number(summary.visitors), "按域名内访客标识去重"],
    ["实际观看人数", number(summary.viewers), "至少真正开始播放一次"],
    ["播放次数", number(summary.plays), "已开始播放的会话"],
    ["有效观看时长", time(summary.watchedSeconds), "不计拖动跳过的部分"],
    ...(!compact
      ? [
          ["页面访问", number(summary.visits), "打开页面的次数"],
          ["尝试播放", number(summary.attempts), "进入播放流程的会话"],
          ["完成播放", number(summary.completed), "依据实际观看记录判断"],
          ["平均首播耗时", startup(summary.startupMs), "从播放操作到开始播放"],
          [
            "播放错误 / 卡顿",
            `${number(summary.errors)} / ${number(summary.stalls)}`,
            "播放器报告的事件",
          ],
        ]
      : []),
  ];
  return (
    <div
      className={`playback-stat-grid${compact ? " playback-stat-grid-compact" : ""}`}
    >
      {stats.map(([title, value, note]) => (
        <div className="stat-card" key={title}>
          <small>{title}</small>
          <strong>{value}</strong>
          <span className="muted small-text">{note}</span>
        </div>
      ))}
    </div>
  );
}
export function PlaybackSummary({ onOpen }: { onOpen: () => void }) {
  const usage = useLoad<Analytics>("/api/admin/playback-analytics?range=today");
  return (
    <section className="panel stack">
      <div className="toolbar">
        <div>
          <h3>今日前台播放</h3>
          <small className="muted">Asia/Singapore 当天零点起</small>
        </div>
        <button className="button" onClick={onOpen}>
          <Icon name="chart" size={16} />
          查看播放统计
        </button>
      </div>
      {usage.loading ? (
        <Loading text="正在读取播放数据…" />
      ) : usage.error ? (
        <ErrorBox error={usage.error} retry={usage.reload} />
      ) : usage.data ? (
        <>
          <Cards summary={usage.data.summary} compact />
          <p className="muted small-text">
            各域名分别识别访客，不跨域合并人数。管理员预览与验收流量不计入日常播放。
          </p>
        </>
      ) : null}
    </section>
  );
}
function Trend({ rows }: { rows: Analytics["trend"] }) {
  const [metric, setMetric] = useState<"plays" | "visits" | "watchedSeconds">(
    "plays",
  );
  const titles = {
    plays: "播放次数",
    visits: "页面访问",
    watchedSeconds: "有效观看时长",
  };
  const max = Math.max(1, ...rows.map((row) => row[metric]));
  const width = 760,
    height = 200,
    margin = 32;
  const x = (index: number) =>
    rows.length === 1
      ? width / 2
      : margin + (index / (rows.length - 1)) * (width - margin * 2);
  const y = (value: number) =>
    height - margin - (value / max) * (height - margin * 2);
  const points = rows
    .map((row, index) => `${x(index)},${y(row[metric])}`)
    .join(" ");
  const format = (value: number) =>
    metric === "watchedSeconds" ? time(value) : number(value);
  const showLabel = (index: number) =>
    rows.length <= 8 ||
    index === 0 ||
    index === rows.length - 1 ||
    index % Math.ceil(rows.length / 7) === 0;
  const day = (value: string) =>
    /^\d{4}-\d{2}-\d{2}/.test(value)
      ? value.slice(5, 10).replace("-", "/") +
        (value.length > 10 ? ` ${value.slice(11, 16)}` : "")
      : value;
  return (
    <section className="panel stack">
      <div className="toolbar">
        <h3>观看趋势</h3>
        <select
          aria-label="趋势指标"
          value={metric}
          onChange={(e) => setMetric(e.target.value as typeof metric)}
        >
          {Object.entries(titles).map(([key, title]) => (
            <option key={key} value={key}>
              {title}
            </option>
          ))}
        </select>
      </div>
      {!rows.length ? (
        <Empty
          icon="chart"
          title="这个范围还没有播放数据"
          description="访客打开页面或开始观看后，这里会逐步积累趋势。"
        />
      ) : (
        <>
          <div className="playback-chart">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${titles[metric]}趋势，最高${format(max)}`}
            >
              {[0, 0.5, 1].map((ratio) => (
                <g key={ratio}>
                  <line
                    x1={margin}
                    x2={width - margin}
                    y1={y(max * ratio)}
                    y2={y(max * ratio)}
                    className="playback-chart-grid"
                  />
                  <text
                    x={margin}
                    y={y(max * ratio) - 5}
                    className="playback-chart-label"
                  >
                    {format(max * ratio)}
                  </text>
                </g>
              ))}
              <polyline
                points={points}
                fill="none"
                className="playback-chart-line"
              />
              {rows.map((row, index) => (
                <g key={row.day}>
                  <circle
                    cx={x(index)}
                    cy={y(row[metric])}
                    r={rows.length > 14 ? 2.5 : 4}
                    className="playback-chart-dot"
                  >
                    <title>
                      {row.day}：{format(row[metric])}
                    </title>
                  </circle>
                  {showLabel(index) && (
                    <text
                      x={x(index)}
                      y={height - 8}
                      textAnchor={
                        index === 0
                          ? "start"
                          : index === rows.length - 1
                            ? "end"
                            : "middle"
                      }
                      className="playback-chart-label"
                    >
                      {day(row.day)}
                    </text>
                  )}
                </g>
              ))}
            </svg>
          </div>
          <details>
            <summary>查看趋势明细</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>页面访问</th>
                    <th>播放次数</th>
                    <th>有效观看</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.day}>
                      <td>{row.day}</td>
                      <td>{number(row.visits)}</td>
                      <td>{number(row.plays)}</td>
                      <td>{time(row.watchedSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
function Distribution({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; plays: number }[];
}) {
  const max = Math.max(1, ...rows.map((row) => row.plays));
  return (
    <section className="panel stack">
      <h3>{title}</h3>
      {!rows.length ? (
        <p className="muted">暂无观看记录</p>
      ) : (
        rows.slice(0, 12).map((row, index) => (
          <div key={`${row.name}:${index}`} className="playback-distribution">
            <div>
              <span title={row.name}>{display(row.name)}</span>
              <strong>{number(row.plays)}</strong>
            </div>
            <div className="playback-meter">
              <span
                style={{
                  width: `${Math.max(0, Math.min(100, (row.plays / max) * 100))}%`,
                }}
              />
            </div>
          </div>
        ))
      )}
    </section>
  );
}
function SessionDetail({ session }: { session: Session }) {
  const items: [string, string][] = [
    [
      "开始 / 最近活动",
      `${date(session.started_at)} / ${date(session.last_at)}`,
    ],
    ["视频", session.title || session.video_id],
    ["播放版本", display(session.version_id)],
    ["实际访问域名", display(session.host)],
    ["外部来源域名", session.referrer_host || "直接访问或未提供"],
    ["请求 IP", display(session.ip)],
    [
      "IP 推断地区",
      [session.country, session.region, session.city]
        .filter(Boolean)
        .join(" · ") || "未知",
    ],
    ["ASN", display(session.asn)],
    [
      "浏览器 / 系统 / 设备",
      `${display(session.browser)} / ${display(session.os)} / ${deviceNames[session.device || "unknown"] || display(session.device)}`,
    ],
    [
      "有效观看 / 视频时长",
      `${time(session.watched_seconds)} / ${session.duration == null ? "未知" : duration(session.duration)}`,
    ],
    ["首播耗时", startup(session.startup_ms)],
    ["错误 / 卡顿", `${number(session.errors)} / ${number(session.stalls)}`],
    [
      "播放结果",
      session.completed
        ? "实际观看完成"
        : session.started
          ? "已开始观看"
          : "尚未开始播放",
    ],
    ["技术状态", display(session.result)],
    ["会话编号", session.id],
    ["User-Agent", display(session.ua)],
  ];
  return (
    <dl className="playback-session-detail-list">
      {items.map(([title, value]) => (
        <div key={title}>
          <dt>{title}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function PlaybackAnalytics() {
  const [range, setRange] = useState("7d");
  const [host, setHost] = useState("");
  const [videoId, setVideoId] = useState("");
  const [page, setPage] = useState(1);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [knownHosts, setKnownHosts] = useState<string[]>([]);
  const [knownVideos, setKnownVideos] = useState<
    { videoId: string; title: string }[]
  >([]);
  const analytics = useLoad<Analytics>(
    `/api/admin/playback-analytics?range=${range}&host=${encodeURIComponent(host)}&videoId=${encodeURIComponent(videoId)}&page=${page}`,
  );
  const data = analytics.data;
  const hostOptions = [
    ...new Set([
      ...knownHosts,
      ...(data?.hosts.map((row) => row.host) || []),
      ...(host ? [host] : []),
    ]),
  ];
  const videoOptions = [
    ...new Map(
      [...knownVideos, ...(data?.videos || [])].map((row) => [
        row.videoId,
        row,
      ]),
    ).values(),
  ];
  function rememberFilters() {
    if (data) {
      setKnownHosts(hostOptions);
      setKnownVideos(videoOptions);
    }
  }
  return (
    <div className="stack playback-analytics">
      <div className="panel">
        <div className="toolbar playback-filters">
          <label>
            时间范围
            <select
              aria-label="播放统计时间范围"
              value={range}
              onChange={(e) => {
                rememberFilters();
                setRange(e.target.value);
                setPage(1);
              }}
            >
              <option value="today">今天（新加坡时间）</option>
              <option value="24h">近24小时</option>
              <option value="7d">近7天</option>
              <option value="30d">近30天</option>
            </select>
          </label>
          <label>
            访问域名
            <select
              aria-label="按访问域名筛选"
              value={host}
              onChange={(e) => {
                rememberFilters();
                setHost(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部访问域名</option>
              {hostOptions.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            视频
            <select
              aria-label="按视频筛选统计"
              value={videoId}
              onChange={(e) => {
                rememberFilters();
                setVideoId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部视频</option>
              {videoOptions.map((video) => (
                <option key={video.videoId} value={video.videoId}>
                  {video.title || video.videoId}
                </option>
              ))}
            </select>
          </label>
          <button className="button" onClick={analytics.reload}>
            <Icon name="refresh" size={16} />
            刷新
          </button>
        </div>
      </div>
      {analytics.loading ? (
        <Loading text="正在汇总播放统计…" />
      ) : analytics.error ? (
        <ErrorBox error={analytics.error} retry={analytics.reload} />
      ) : data ? (
        <>
          <div className="toolbar">
            <p className="muted small-text">
              {data.range.label} · {date(data.range.start)} 至{" "}
              {date(data.range.end)}
            </p>
            <span className="small-text">
              近5分钟活跃观看人数（估算）：{number(data.summary.recentActive)}
            </span>
          </div>
          <Cards summary={data.summary} />
          <Notice>
            访问与真正开始播放分别计数。人数按各访问域名内的访客标识估算，不跨域合并；IP
            不等于一个人。管理员预览、健康检查和标记的验收流量不计入日常统计。
          </Notice>
          <Trend rows={data.trend} />
          <section className="panel stack">
            <h3>视频观看排行</h3>
            {!data.videos.length ? (
              <p className="muted">这个范围还没有视频观看记录。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>视频</th>
                      <th>播放次数</th>
                      <th>有效观看时长</th>
                      <th>完成播放</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.videos.map((video, index) => (
                      <tr key={video.videoId}>
                        <td className="playback-video-title">
                          <strong>
                            {index + 1}. {video.title || "已移除的视频"}
                          </strong>
                        </td>
                        <td>{number(video.plays)}</td>
                        <td>{time(video.watchedSeconds)}</td>
                        <td>{number(video.completed)}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => {
                              rememberFilters();
                              setVideoId(video.videoId);
                              setPage(1);
                            }}
                          >
                            查看会话
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <div className="playback-distribution-grid">
            <Distribution
              title="实际访问域名 · 播放次数"
              rows={data.hosts.map((row) => ({
                name: row.host,
                plays: row.plays,
              }))}
            />
            <Distribution
              title="国家或地区 · 播放次数"
              rows={data.countries.map((row) => ({
                name: row.country,
                plays: row.plays,
              }))}
            />
            <Distribution
              title="浏览器 · 播放次数"
              rows={data.browsers.map((row) => ({
                name: row.browser,
                plays: row.plays,
              }))}
            />
            <Distribution
              title="操作系统 · 播放次数"
              rows={data.systems.map((row) => ({
                name: row.os,
                plays: row.plays,
              }))}
            />
            <Distribution
              title="设备类型 · 播放次数"
              rows={data.devices.map((row) => ({
                name: deviceNames[row.device] || row.device,
                plays: row.plays,
              }))}
            />
          </div>
          <section className="panel stack">
            <h3>观看会话</h3>
            <p className="muted small-text">
              播放会话关联当前域名和浏览器标签页，短时间刷新复用会话；Range
              请求和 HLS 分片不会分别算作播放。地区来自 IP
              推断，无法代表精确位置。
            </p>
            {!data.sessions.items.length ? (
              <Empty
                icon="play"
                title="这个范围没有会话"
                description="选择其他时间、域名或视频再查看。"
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="playback-session-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>视频 / 域名</th>
                        <th>观看情况</th>
                        <th>体验</th>
                        <th>明细</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.items.map((session) => (
                        <tr key={session.id}>
                          <td>{date(session.started_at)}</td>
                          <td className="playback-video-title">
                            <strong>{session.title || "未关联视频"}</strong>
                            <small>{session.host}</small>
                          </td>
                          <td>
                            {session.started
                              ? session.completed
                                ? "已完成播放"
                                : "已开始播放"
                              : "仅访问 / 尚未开始"}
                            <small>
                              有效观看 {time(session.watched_seconds)}
                            </small>
                          </td>
                          <td>
                            {session.started
                              ? startup(session.startup_ms)
                              : "—"}
                            <small>
                              {session.errors
                                ? `${session.errors} 次错误`
                                : "无已报告错误"}
                              {session.stalls
                                ? ` · ${session.stalls} 次卡顿`
                                : ""}
                            </small>
                          </td>
                          <td>
                            <button
                              className="button small"
                              onClick={() => setSelectedSession(session)}
                            >
                              查看详情
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  total={data.sessions.total}
                  pageSize={data.sessions.pageSize}
                  onPage={setPage}
                />
              </>
            )}
          </section>
          <section className="panel stack">
            <h3>统计范围与保存方式</h3>
            <p>
              可靠记录起点：
              {data.coverage.since == null
                ? "等待首次记录"
                : date(data.coverage.since)}
              。包含 IP、UA 的会话明细保留 {data.coverage.detailDays}{" "}
              天；长期汇总
              {data.coverage.aggregateDays === "永久"
                ? "长期保留"
                : `保留 ${data.coverage.aggregateDays}`}
              ，不会随明细清理归零。
            </p>
            <p className="muted">{data.coverage.note}</p>
            <p className="muted small-text">
              有效观看时长依据实际播放进度与事件间隔统计，拖动跳过的片段不会计入。最近活跃表示最近5分钟收到过播放事件的访客，不代表准确实时在线人数。播放事件批量提交；统计失败不会阻止观看。
            </p>
          </section>
        </>
      ) : null}
      {selectedSession && (
        <Modal
          title="观看会话详情"
          wide
          onClose={() => setSelectedSession(null)}
        >
          <SessionDetail session={selectedSession} />
          <div className="modal-actions">
            <button className="button" onClick={() => setSelectedSession(null)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
