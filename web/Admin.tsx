import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ApiError,
  api,
  bytes,
  date,
  duration,
  label,
  send,
  useLoad,
  type Config,
  type Job,
  type Paged,
  type Version,
  type Video,
  type SourcePreviewEvidence,
} from "./client";
import {
  Badge,
  Empty,
  ErrorBox,
  Icon,
  JsonData,
  Loading,
  Logo,
  Modal,
  Notice,
  Pagination,
} from "./ui";
import { Player } from "./Player";
import { Uploads } from "./Uploads";
import { Storage, DeletionDialog, type DeleteRequest } from "./Storage";
import { ProcessingQuoteValues } from "./ProcessingQuoteValues";
import { PlaybackAnalytics, PlaybackSummary } from "./PlaybackAnalytics";
import { SourcePreview } from "./SourcePreview";
import { WatchSettings } from "./WatchSettings";
import { ResourceUsage } from "./ResourceUsage";
import { SiteSettings } from "./SiteSettings";
import { ThemeToggle, useSiteBrand } from "./public-theme";
import { MediaErrorBox, type MediaStage } from "./media-errors";

const sections = [
  {
    key: "overview",
    title: "总览",
    icon: "grid",
    description: "查看视频库、处理任务与资源状态。",
  },
  {
    key: "library",
    title: "视频库",
    icon: "film",
    description: "上传、管理与发布你的每一部视频。",
  },
  {
    key: "jobs",
    title: "处理任务",
    icon: "activity",
    description: "跟踪云端任务与实例停止证据。",
  },
  {
    key: "analytics",
    title: "播放统计",
    icon: "chart",
    description: "访问、实际观看、热门视频与播放体验。",
  },
  {
    key: "usage",
    title: "资源用量",
    icon: "chart",
    description: "本项目资源统计、自动数据与任务预算保护。",
  },
  {
    key: "storage",
    title: "R2 存储",
    icon: "storage",
    description: "按视频查看原片、生成文件与删除影响。",
  },
  {
    key: "logs",
    title: "日志与诊断",
    icon: "activity",
    description: "只对管理员显示的运行记录。",
  },
  {
    key: "settings",
    title: "站点设置",
    icon: "settings",
    description: "运行参数与当前入口信息。",
  },
];
type Session = { authenticated: boolean; configured: boolean };
type Detail = { video: Video; versions: Version[]; jobs: Job[] };
type RawQuote = {
  id: string;
  mode: string;
  quality: string;
  expiresAt?: number;
  expires_at?: number;
  data?: Record<string, unknown>;
  data_json?: string;
  [key: string]: unknown;
};
type Quote = {
  id: string;
  mode: string;
  quality: string;
  expires_at: number;
  processingEnabled?: boolean;
  data: Record<string, unknown>;
  state: string;
};

export function Admin() {
  const brand = useSiteBrand();
  const [section, setSection] = useState(
    location.pathname.split("/")[2] || "overview",
  );
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const session = useLoad<Session>("/api/admin/session");
  useEffect(() => {
    const pop = () => setSection(location.pathname.split("/")[2] || "overview");
    window.addEventListener("popstate", pop);
    const expired = () => session.reload();
    window.addEventListener("hub-session-expired", expired);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("hub-session-expired", expired);
    };
  }, [session.reload]);
  useEffect(() => {
    document.title = `管理后台 · ${brand.name}`;
  }, [brand.name]);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError(null);
    try {
      await send("/api/admin/login", { password });
      setPassword("");
      session.reload();
    } catch (error) {
      setLoginError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await send("/api/admin/logout");
      session.reload();
    } catch (error) {
      setLoginError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  function navigate(key: string) {
    setSection(key);
    setMenu(false);
    window.history.pushState({}, "", `/admin/${key}`);
    window.scrollTo(0, 0);
  }
  if (session.loading && !session.data)
    return (
      <div className="login-page admin-login">
        <div className="admin-login-theme">
          <ThemeToggle />
        </div>
        <Logo brand={brand} />
        <Loading text="正在核验管理员会话…" />
      </div>
    );
  if (session.error)
    return (
      <div className="login-page admin-login">
        <div className="admin-login-theme">
          <ThemeToggle />
        </div>
        <Logo brand={brand} />
        <div className="login-card">
          <ErrorBox error={session.error} retry={session.reload} />
        </div>
      </div>
    );
  if (!session.data?.authenticated)
    return (
      <div className="login-page admin-login">
        <div className="admin-login-theme">
          <ThemeToggle />
        </div>
        <a className="login-back text-button" href="/video">
          ← 返回放映室
        </a>
        <Logo brand={brand} />
        <div className="login-card">
          <span className="login-lock">
            <Icon name="lock" size={27} />
          </span>
          <div className="eyebrow">WELCOME BACK</div>
          <h1>管理你的放映室</h1>
          <p>输入管理员密码，继续你的创作之旅。</p>
          {session.data && !session.data.configured && (
            <Notice>
              后台尚未配置。请在当前 Worker 的 Variables and Secrets
              中设置必要运行时变量。
            </Notice>
          )}
          <form onSubmit={login}>
            <label className="field-label" htmlFor="password">
              管理员密码
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="输入密码"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || !session.data?.configured}
            />
            <ErrorBox error={loginError} />
            <button
              className="button primary full"
              disabled={busy || !session.data?.configured || !password}
            >
              {busy ? "正在登录…" : "登录管理后台"}
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <div className="login-security">
            <Icon name="shield" size={14} />
            登录会话仅在当前域名有效
          </div>
        </div>
        <small className="muted">{brand.name} · V3.0</small>
      </div>
    );
  const selected = sections.find((item) => item.key === section) || sections[0];
  return (
    <div className="admin-app">
      <a className="skip-link" href="#admin-content">
        跳至管理内容
      </a>
      <button
        className="mobile-menu button"
        aria-label="打开导航"
        aria-expanded={menu}
        aria-controls="admin-navigation"
        onClick={() => setMenu(!menu)}
      >
        <Icon name="grid" />
        导航
      </button>
      <aside
        id="admin-navigation"
        className={`sidebar ${menu ? "is-open" : ""}`}
      >
        <Logo brand={brand} />
        <div className="sidebar-label">工作空间</div>
        <nav aria-label="后台导航">
          {sections.map((item) => (
            <button
              className={
                selected.key === item.key
                  ? "sidebar-link active"
                  : "sidebar-link"
              }
              key={item.key}
              aria-current={selected.key === item.key ? "page" : undefined}
              onClick={() => navigate(item.key)}
            >
              <Icon name={item.icon} size={19} />
              {item.title}
              {selected.key === item.key && <span className="sidebar-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            className="sidebar-link"
            href="/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="play" size={19} />
            打开前台
            <Icon name="arrow" size={15} />
          </a>
          <button
            className="sidebar-link"
            disabled={busy}
            onClick={() => void logout()}
          >
            <Icon name="logout" size={19} />
            退出登录
          </button>
          <div className="admin-identity">
            <span className="avatar">
              <Icon name="shield" size={18} />
            </span>
            <div>
              <strong>管理员</strong>
              <small>当前域名的安全会话</small>
            </div>
            <span className="live-dot" />
          </div>
        </div>
      </aside>
      {menu && (
        <div className="sidebar-overlay" onClick={() => setMenu(false)} />
      )}
      <main className="admin-main">
        <header className="admin-header">
          <div className="breadcrumb">
            工作空间 <span>/</span> {selected.title}
          </div>
          <div className="admin-header-actions">
            <span className="secure-label">
              <Icon name="shield" size={14} />
              管理员已登录
            </span>
            <ThemeToggle />
          </div>
        </header>
        <div id="admin-content" className="admin-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {brand.name} / {selected.key.toUpperCase()}
              </span>
              <h1>{selected.title}</h1>
              <p>{selected.description}</p>
            </div>
            <span className="version-pill">V3.0</span>
          </div>
          <ErrorBox error={loginError} />
          {selected.key === "overview" && <Overview navigate={navigate} />}
          {selected.key === "library" && <Library />}
          {selected.key === "jobs" && <Jobs />}
          {selected.key === "usage" && <Usage />}
          {selected.key === "storage" && <Storage />}
          {selected.key === "analytics" && <PlaybackAnalytics />}
          {selected.key === "logs" && <Logs />}
          {selected.key === "settings" && <Settings />}
        </div>
        <footer className="admin-footer">
          {brand.name} V3.0 <span>Cloudflare · 当前域名独立会话</span>
        </footer>
      </main>
    </div>
  );
}

function Stat({
  icon,
  title,
  value,
  sub,
}: {
  icon: string;
  title: string;
  value: ReactNode;
  sub: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className="stat-icon">
          <Icon name={icon} />
        </span>
      </div>
      <strong className="stat-value">{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
function Overview({ navigate }: { navigate: (key: string) => void }) {
  const overview = useLoad<{
    counts: Record<string, number>;
    activeJobs: Job[];
    storageBytes: number;
    config: Config;
  }>("/api/admin/overview");
  if (overview.loading) return <Loading />;
  if (overview.error)
    return <ErrorBox error={overview.error} retry={overview.reload} />;
  if (!overview.data) return null;
  const { counts, activeJobs, storageBytes, config } = overview.data;
  return (
    <div className="stack">
      <div className="welcome-card">
        <div>
          <span className="eyebrow">EVERY STORY STARTS HERE</span>
          <h2>你的内容，一目了然。</h2>
          <p>上传原片，确认处理方案，再将精彩分享出去。</p>
          <button
            className="button primary"
            onClick={() => navigate("library")}
          >
            <Icon name="upload" size={17} />
            上传新视频
          </button>
        </div>
        <div className="welcome-icon">
          <Icon name="film" size={85} />
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          icon="film"
          title="视频总数"
          value={counts.videos ?? counts.total ?? "无法确认"}
          sub="项目视频目录"
        />
        <Stat
          icon="play"
          title="已发布"
          value={counts.published ?? "无法确认"}
          sub="访客可以播放的视频"
        />
        <Stat
          icon="activity"
          title="活动任务"
          value={activeJobs.length}
          sub="任务与停止监督"
        />
        <Stat
          icon="storage"
          title="已登记存储"
          value={bytes(storageBytes)}
          sub="实际对象占用，非当期累计账单"
        />
      </div>
      <div className="overview-grid">
        <PlaybackSummary onOpen={() => navigate("analytics")} />
        <div className="panel">
          <div className="section-heading">
            <h3>运行状态</h3>
            <Icon name="shield" />
          </div>
          <dl className="info-list">
            <div>
              <dt>当前环境</dt>
              <dd>{config?.env || "无法确认"}</dd>
            </div>
            <div>
              <dt>必要变量</dt>
              <dd>
                <span
                  className={`badge badge-${config?.configured ? "ready" : "missing"}`}
                >
                  {config?.configured ? "已配置" : "缺少配置"}
                </span>
              </dd>
            </div>
            <div>
              <dt>云端处理</dt>
              <dd>
                {config?.processingEnabled ? "总开关已开启" : "总开关已关闭"}
              </dd>
            </div>
            <div>
              <dt>构建版本</dt>
              <dd className="mono">
                {config?.buildCommit?.slice(0, 12) || "未提供"}
              </dd>
            </div>
          </dl>
          <Notice>
            上传和播放不会启动
            Container。每个真实处理任务均需单独报价、确认和停止核验。
          </Notice>
          <button className="button full" onClick={() => navigate("usage")}>
            查看费用与额度
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Library() {
  const [tab, setTab] = useState("videos");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const library = useLoad<Paged<Video>>(
    `/api/admin/videos?q=${encodeURIComponent(query)}&status=${status}&sort=${sort}&page=${page}`,
  );
  useEffect(() => {
    if (library.data && !library.loading) setPage(library.data.page);
  }, [library.data, library.loading]);
  function refresh() {
    library.reload();
  }
  return (
    <div className="stack">
      <div className="tabs">
        <button
          className={tab === "videos" ? "active" : ""}
          onClick={() => setTab("videos")}
        >
          <Icon name="film" size={17} />
          全部视频{library.data && <span>{library.data.total}</span>}
        </button>
        <button
          className={tab === "upload" ? "active" : ""}
          onClick={() => setTab("upload")}
        >
          <Icon name="upload" size={17} />
          上传队列
        </button>
      </div>
      <div className={tab === "upload" ? "" : "hidden"}>
        <Uploads onComplete={refresh} />
      </div>
      {tab === "videos" && (
        <div className="panel library-panel">
          <div className="toolbar">
            <label className="search">
              <Icon name="search" size={18} />
              <input
                aria-label="搜索后台视频"
                placeholder="搜索视频标题…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <select
              aria-label="状态筛选"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="unprocessed">待处理</option>
              <option value="ready">已完成</option>
              <option value="published">已发布</option>
              <option value="failed">失败</option>
              <option value="uploading">上传中</option>
            </select>
            <select
              aria-label="后台视频排序"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
            >
              <option value="newest">最近更新</option>
              <option value="title">标题排序</option>
            </select>
            <button className="button primary" onClick={() => setTab("upload")}>
              <Icon name="upload" size={16} />
              上传视频
            </button>
            <button
              className="icon-button"
              title="刷新视频库"
              aria-label="刷新视频库"
              onClick={refresh}
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
          {library.loading ? (
            <Loading />
          ) : library.error ? (
            <ErrorBox error={library.error} retry={refresh} />
          ) : !library.data?.items.length ? (
            <Empty
              title="还没有相关视频"
              description={
                query || status
                  ? "调整搜索或状态筛选。"
                  : "上传第一个视频，开始建立你的内容库。"
              }
            >
              <button
                className="button primary"
                onClick={() => setTab("upload")}
              >
                上传视频
              </button>
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>视频</th>
                      <th>原片大小</th>
                      <th>状态</th>
                      <th>公开状态</th>
                      <th>更新时间</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {library.data.items.map((video) => (
                      <tr key={video.id}>
                        <td>
                          <button
                            className="table-video"
                            onClick={() => setSelected(video.id)}
                          >
                            <span className="mini-cover">
                              <Icon name="film" />
                            </span>
                            <div>
                              <strong>{video.title}</strong>
                              <small className="truncate">
                                {video.source_name}
                              </small>
                            </div>
                          </button>
                        </td>
                        <td>{bytes(video.source_size)}</td>
                        <td>
                          <Badge value={video.status} />
                        </td>
                        <td>
                          <Badge
                            value={
                              video.published ? "published" : "unpublished"
                            }
                          />
                        </td>
                        <td>{date(video.updated_at)}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => setSelected(video.id)}
                          >
                            管理
                            <Icon name="arrow" size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!library.loading &&
            !library.error &&
            library.data &&
            library.data.total > 0 && (
              <Pagination
                page={page}
                total={library.data.total}
                pageSize={library.data.pageSize}
                onPage={setPage}
              />
            )}
        </div>
      )}
      {selected && (
        <VideoDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function VideoDetail({
  id,
  onClose,
  onChange,
}: {
  id: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const detail = useLoad<Detail>(`/api/admin/videos/${encodeURIComponent(id)}`);
  const data = detail.data;
  const [title, setTitle] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Version | null>(null);
  const [sourcePreview, setSourcePreview] = useState(false);
  const [publish, setPublish] = useState<Version | null>(null);
  const [mp4PreviewEvidence, setMp4PreviewEvidence] = useState<
    Record<string, SourcePreviewEvidence>
  >({});
  const [mp4AudioConfirmed, setMp4AudioConfirmed] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quality, setQuality] = useState("source");
  const [mode, setMode] = useState("probe-remux");
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  const [mediaErrorStage, setMediaErrorStage] = useState<MediaStage | null>(
    null,
  );
  useEffect(() => {
    if (data) setTitle(data.video.title);
  }, [data]);
  function openPublish(version: Version) {
    setMp4AudioConfirmed(false);
    setPublish(version);
  }
  function mp4PreviewReady(versionId: string) {
    const evidence = mp4PreviewEvidence[versionId];
    return (
      !!evidence?.played &&
      !!evidence.seeked &&
      Number.isFinite(evidence.durationSeconds) &&
      evidence.durationSeconds > 0
    );
  }
  async function publishVersion() {
    if (
      !publish ||
      busy ||
      (publish.mode === "faststart" &&
        (!mp4PreviewReady(publish.id) || !mp4AudioConfirmed))
    )
      return;
    const ok = await mutate(
      () =>
        send(`/api/admin/videos/${encodeURIComponent(id)}/publish`, {
          versionId: publish.id,
          ...(publish.mode === "faststart"
            ? {
                attestation: {
                  ...mp4PreviewEvidence[publish.id],
                  audioConfirmed: true,
                },
              }
            : {}),
        }),
      "preview",
    );
    if (ok) setPublish(null);
  }
  async function mutate(
    action: () => Promise<unknown>,
    stage: MediaStage | null = null,
  ) {
    setBusy(true);
    setError(null);
    setMediaErrorStage(stage);
    try {
      await action();
      detail.reload();
      onChange();
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function requestQuote() {
    setBusy(true);
    setError(null);
    setMediaErrorStage(mode === "faststart" ? "faststart" : "processing");
    try {
      const result = await send<{
        quote: RawQuote;
        processingEnabled?: boolean;
      }>(`/api/admin/videos/${encodeURIComponent(id)}/quote`, {
        mode,
        quality,
      });
      const raw = result.quote;
      setQuote({
        id: raw.id,
        mode: raw.mode,
        quality: raw.quality,
        expires_at: raw.expires_at ?? raw.expiresAt ?? 0,
        processingEnabled: result.processingEnabled,
        state: String(raw.state || "open"),
        data: raw.data || (raw.data_json ? parseJSON(raw.data_json) : raw),
      });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="视频管理" wide onClose={onClose} busy={busy}>
      <div className="stack">
        {detail.loading ? (
          <Loading />
        ) : detail.error ? (
          <MediaErrorBox
            error={detail.error}
            stage="preview"
            retry={detail.reload}
          />
        ) : (
          data && (
            <>
              <div className="detail-top">
                <span className="detail-cover">
                  <Icon name="film" size={36} />
                </span>
                <div>
                  <Badge
                    value={data.video.published ? "published" : "unpublished"}
                  />
                  <h2>{data.video.title}</h2>
                  <small className="muted mono">{id}</small>
                </div>
              </div>
              {mediaErrorStage ? (
                <MediaErrorBox error={error} stage={mediaErrorStage} />
              ) : (
                <ErrorBox error={error} />
              )}
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(() =>
                    send(
                      `/api/admin/videos/${encodeURIComponent(id)}`,
                      { title },
                      "PATCH",
                    ),
                  );
                }}
              >
                <label className="field-label" htmlFor="video-title">
                  视频标题
                </label>
                <div className="row">
                  <input
                    id="video-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    required
                  />
                  <button
                    className="button"
                    disabled={
                      busy || title === data.video.title || !title.trim()
                    }
                  >
                    保存标题
                  </button>
                </div>
              </form>
              <div className="detail-stats">
                <div>
                  <small>原片</small>
                  <strong>
                    {data.video.source_key
                      ? bytes(data.video.source_size)
                      : "原片已移除"}
                  </strong>
                </div>
                <div>
                  <small>处理状态</small>
                  <strong>{label(data.video.status)}</strong>
                </div>
                <div>
                  <small>产物版本</small>
                  <strong>{data.versions.length} 个</strong>
                </div>
              </div>
              <section className="subpanel">
                <div className="section-heading">
                  <h3>播放与处理方式</h3>
                  <Icon name="activity" size={18} />
                </div>
                <div className="subpanel stack">
                  <strong>原片直接播放（优先）</strong>
                  <p className="muted">
                    先检查 MP4
                    原片并在浏览器预览。兼容时可建立原片播放版本，共用原片文件，不生成
                    HLS、不启动 Container。
                  </p>
                  <button
                    className="button primary"
                    disabled={busy || !data.video.source_key}
                    onClick={() => setSourcePreview(true)}
                  >
                    检查并预览原片
                  </button>
                </div>
                <p className="muted small-text">
                  <strong>快速起播（faststart）：</strong>
                  单独的 MP4
                  无损重排任务仅复制码流，将索引移至媒体数据之前，可能改善起播；保留编码、画质和原片，不自动转码、发布或替换当前版本。仍须先获取报价并确认费用；不兼容或超出范围时停止。
                </p>
                <h4>MP4 优化、HLS 封装与重新编码</h4>
                <p className="muted">
                  先取得有效报价，再确认启动。原片上传、报价和预览本身不会启动处理器。
                </p>

                <div className="row wrap">
                  <label className="form-option">
                    处理方式
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        if (e.target.value !== "transcode")
                          setQuality("source");
                      }}
                    >
                      <option value="faststart">
                        MP4：无损优化快速起播（faststart）
                      </option>
                      <option value="probe-remux">
                        HLS：探测，兼容时无损封装
                      </option>
                      <option value="transcode">
                        重新编码（需已有探测结果）
                      </option>
                    </select>
                  </label>
                  <label className="form-option">
                    输出画质
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      disabled={mode !== "transcode"}
                    >
                      <option value="source">原分辨率</option>
                      <option value="1080p">1080p</option>
                      <option value="720p">720p</option>
                    </select>
                  </label>
                  <button
                    className="button primary quote-button"
                    disabled={busy || !data.video.source_key}
                    onClick={() => void requestQuote()}
                  >
                    获取处理报价
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
              </section>
              <section>
                <div className="section-heading">
                  <h3>播放版本</h3>
                  {!!data.video.published && (
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          send(
                            `/api/admin/videos/${encodeURIComponent(id)}/unpublish`,
                          ),
                        )
                      }
                    >
                      立即下架
                    </button>
                  )}
                </div>
                {!data.versions.length ? (
                  <Empty
                    title="还没有播放版本"
                    description="可检查并预览原片，建立共用原片文件的播放版本；也可确认处理生成优化 MP4 或 HLS，再预览并明确选择发布。"
                  />
                ) : (
                  data.versions.map((version) => (
                    <div className="version-row" key={version.id}>
                      <div>
                        <div className="row wrap">
                          <strong>
                            {version.mode === "source"
                              ? "原片直接播放"
                              : `${label(version.mode)} · ${label(version.quality)}`}
                          </strong>
                          <Badge value={version.state} />
                          {data.video.current_version_id === version.id && (
                            <span className="badge badge-published">
                              当前播放版本
                            </span>
                          )}
                        </div>
                        <p className="muted small-text">
                          {duration(version.duration)} · {bytes(version.bytes)}{" "}
                          · {date(version.created_at)}
                        </p>
                        <small className="mono muted">{version.id}</small>
                      </div>
                      <div className="row-actions">
                        <button
                          className="button small"
                          disabled={
                            !version.manifest ||
                            !["ready", "verified", "complete"].includes(
                              version.state,
                            )
                          }
                          onClick={() => setPreview(version)}
                        >
                          预览
                        </button>
                        <button
                          className="button small primary"
                          disabled={
                            busy ||
                            !["ready", "verified", "complete"].includes(
                              version.state,
                            ) ||
                            (!!data.video.published &&
                              data.video.current_version_id === version.id)
                          }
                          onClick={() => openPublish(version)}
                        >
                          选择发布
                        </button>
                        <button
                          className="icon-button danger-text"
                          aria-label="删除此版本"
                          disabled={busy}
                          onClick={() =>
                            setDeleteRequest({
                              kind: "version",
                              videoId: id,
                              versionId: version.id,
                            })
                          }
                        >
                          <Icon name="trash" size={17} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </section>
              <section>
                <h3>关联任务</h3>
                {data.jobs.length ? (
                  data.jobs.map((job) => <JobCard key={job.id} job={job} />)
                ) : (
                  <p className="muted">暂无处理任务。</p>
                )}
              </section>
              <div className="danger-zone">
                <div>
                  <strong>存储清理</strong>
                  <p>先核对精确对象清单与依赖，再决定删除。</p>
                </div>
                <div className="row-actions">
                  <button
                    className="button small"
                    disabled={busy || !data.video.source_key}
                    onClick={() =>
                      setDeleteRequest({ kind: "source", videoId: id })
                    }
                  >
                    删除原片
                  </button>
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() =>
                      setDeleteRequest({ kind: "failed", videoId: id })
                    }
                  >
                    清理失败产物
                  </button>
                  <button
                    className="button small danger-outline"
                    disabled={busy}
                    onClick={() =>
                      setDeleteRequest({ kind: "video", videoId: id })
                    }
                  >
                    删除整部视频
                  </button>
                </div>
              </div>
            </>
          )
        )}
        {preview && (
          <Modal title="管理员预览" wide onClose={() => setPreview(null)}>
            <Player
              key={preview.id}
              videoId={id}
              versionId={preview.id}
              mediaKind={
                preview.mode === "source"
                  ? "source"
                  : preview.mode === "faststart"
                    ? "mp4"
                    : "hls"
              }
              timelineId={preview.timeline_id}
              title={data?.video.title || "视频预览"}
              preview
              onPreviewEvidence={
                preview.mode === "faststart"
                  ? (evidence) =>
                      setMp4PreviewEvidence((previous) => ({
                        ...previous,
                        [preview.id]: evidence,
                      }))
                  : undefined
              }
            />
            {preview.mode === "faststart" && (
              <div className="stack">
                <Notice>
                  这是独立的优化 MP4
                  产物。请实际播放、拖动，并核对声音或无音轨状态，再进入发布确认；预览不会自动发布。
                </Notice>
                <p className="muted">
                  实际播放：
                  {mp4PreviewEvidence[preview.id]?.played
                    ? "已观察到播放进度"
                    : "等待播放"}{" "}
                  · 拖动：
                  {mp4PreviewEvidence[preview.id]?.seeked
                    ? "已观察到完成拖动"
                    : "等待拖动"}
                </p>
                <button
                  className="button primary"
                  disabled={!mp4PreviewReady(preview.id)}
                  onClick={() => {
                    setPreview(null);
                    openPublish(preview);
                  }}
                >
                  继续到发布确认
                </button>
              </div>
            )}
          </Modal>
        )}
        {sourcePreview && data && (
          <SourcePreview
            video={data.video}
            onClose={() => setSourcePreview(false)}
            onCreated={(version) => {
              setSourcePreview(false);
              detail.reload();
              onChange();
              openPublish(version);
            }}
          />
        )}
        {publish && (
          <Modal
            title="确认发布版本"
            onClose={() => setPublish(null)}
            busy={busy}
          >
            <p>
              将「{data?.video.title}」的{" "}
              <strong>
                {publish.mode === "source"
                  ? "原片直接播放"
                  : publish.mode === "faststart"
                    ? label(publish.mode)
                    : label(publish.quality)}
              </strong>{" "}
              版本设为当前公开播放版本。所有连接到同一 Worker
              的域名都会使用这个发布设置。
            </p>
            <p className="muted mono small-text">版本：{publish.id}</p>
            {publish.mode === "faststart" && (
              <div className="stack">
                <Notice>
                  发布优化 MP4
                  前，必须预览这个确切版本并核对播放、拖动和声音。此声明记录管理员的浏览器检查，不代表所有浏览器或设备均已验收。
                </Notice>
                <p className="muted">
                  本版本播放与拖动：
                  {mp4PreviewReady(publish.id) ? "已观察到" : "尚未完成"}
                </p>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setPreview(publish);
                    setPublish(null);
                  }}
                >
                  预览此 MP4 版本
                </button>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={mp4AudioConfirmed}
                    disabled={busy || !mp4PreviewReady(publish.id)}
                    onChange={(event) =>
                      setMp4AudioConfirmed(event.target.checked)
                    }
                  />
                  我已核对本版本的画面、声音（无音轨时核对无音轨）和拖动结果，同意发布这个独立
                  MP4 版本。
                </label>
              </div>
            )}
            <MediaErrorBox error={error} stage="preview" />
            <div className="modal-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setPublish(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  (publish.mode === "faststart" &&
                    (!mp4PreviewReady(publish.id) || !mp4AudioConfirmed))
                }
                onClick={() => void publishVersion()}
              >
                {busy ? "发布中…" : "确认发布此版本"}
              </button>
            </div>
          </Modal>
        )}
        {quote && (
          <QuoteDialog
            quote={quote}
            onClose={() => setQuote(null)}
            onConfirmed={() => {
              setQuote(null);
              detail.reload();
              onChange();
            }}
          />
        )}
        {deleteRequest && (
          <DeletionDialog
            request={deleteRequest}
            onClose={() => setDeleteRequest(null)}
            onDone={() => {
              setDeleteRequest(null);
              onChange();
              if (deleteRequest.kind === "video") onClose();
              else detail.reload();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

function QuoteDialog({
  quote,
  onClose,
  onConfirmed,
}: {
  quote: Quote;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/admin/quotes/${encodeURIComponent(quote.id)}/confirm`, {
        confirmation: "START_PAID_TASK",
      });
      onConfirmed();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const expired = now >= quote.expires_at;
  return (
    <Modal title="核对处理方案与费用" onClose={onClose} wide busy={busy}>
      <div className="stack">
        {quote.processingEnabled === false && (
          <Notice>
            视频处理总开关当前关闭。需要管理员在当前 Worker 的 Variables and
            Secrets 中手工开启 PROCESSING_ENABLED，才可启动已确认任务。
          </Notice>
        )}
        <Notice>
          本次确认会实际启动 Cloudflare
          Container，并可能产生费用。超过此方案、需要转码或更大规格时，处理器会停止，等待新的报价和确认。
        </Notice>
        <div className="detail-stats">
          <div>
            <small>处理方式</small>
            <strong>{label(quote.mode)}</strong>
          </div>
          <div>
            <small>单套画质</small>
            <strong>{label(quote.quality)}</strong>
          </div>
          <div>
            <small>报价有效至</small>
            <strong>{date(quote.expires_at)}</strong>
          </div>
        </div>
        {quote.data.executionAllowed === false && (
          <Notice>
            此方案尚不能启动。请先处理下列条件：
            {Array.isArray(quote.data.executionBlockers) &&
              quote.data.executionBlockers
                .filter(
                  (reason): reason is string => typeof reason === "string",
                )
                .map((reason) => <p key={reason}>{reason}</p>)}
            {typeof quote.data.executionNextStep === "string"
              ? quote.data.executionNextStep
              : "请重新报价并核对本任务的费用允许范围。"}
          </Notice>
        )}
        <ProcessingQuoteValues data={quote.data} />
        <details className="details">
          <summary>完整报价、数据来源与费用快照</summary>
          <JsonData value={quote.data} />
        </details>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          我已核对处理范围、规格、输出占用、总时限和费用上界，同意仅启动这一个任务。
        </label>
        <MediaErrorBox
          stage={quote.mode === "faststart" ? "faststart" : "processing"}
          startRequest
          error={
            error ||
            (expired ? new ApiError("报价已过期", "quote_expired") : null)
          }
        />
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={onClose}>
            暂不处理
          </button>
          <button
            className="button primary"
            disabled={
              !acknowledged ||
              expired ||
              busy ||
              quote.processingEnabled === false ||
              quote.data.executionAllowed === false
            }
            onClick={() => void confirm()}
          >
            {busy ? "正在重新核验并预留预算…" : "确认费用并启动任务"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
function JobCard({
  job,
  onCancel,
}: {
  job: Job;
  onCancel?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  let progress: Record<string, unknown> | null = null;
  try {
    progress = job.progress_json ? JSON.parse(job.progress_json) : null;
  } catch {
    /* Malformed diagnostics stay visible below. */
  }
  const fraction =
    typeof progress?.bytes === "number" &&
    typeof progress?.totalBytes === "number" &&
    progress.totalBytes > 0
      ? progress.bytes / progress.totalBytes
      : typeof progress?.positionSeconds === "number" &&
          typeof progress?.durationSeconds === "number" &&
          progress.durationSeconds > 0
        ? progress.positionSeconds / progress.durationSeconds
        : typeof progress?.objects === "number" &&
            typeof progress?.totalObjects === "number" &&
            progress.totalObjects > 0
          ? progress.objects / progress.totalObjects
          : null;
  const canCancel = [
    "queued",
    "starting",
    "running",
    "stopping",
    "stop_unverified",
  ].includes(job.state);
  const processingReasons = Array.isArray(progress?.reasons)
    ? progress.reasons
        .filter((reason): reason is string => typeof reason === "string")
        .slice(0, 8)
    : [];
  return (
    <div className="job-card">
      <div className="section-heading">
        <div className="row wrap">
          <span className="job-symbol">
            <Icon name="activity" size={19} />
          </span>
          <strong className="mono">{job.id.slice(0, 12)}</strong>
          <Badge value={job.state} />
        </div>
        <div className="row-actions">
          {canCancel && onCancel && (
            <button
              className="text-button danger-text"
              onClick={() => onCancel(job.id)}
            >
              取消任务
            </button>
          )}
          <button
            className="text-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起" : "详情"}
          </button>
        </div>
      </div>
      <div className="spread small-text">
        <span>
          {job.stage === "uploading" &&
          progress?.progressBasis === "persisted-bytes"
            ? "已核实存储进度"
            : label(job.stage)}
          {job.started_at ? ` · 开始于 ${date(job.started_at)}` : ""}
        </span>
        <span>
          {fraction == null
            ? "阶段进度"
            : `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`}
        </span>
      </div>
      {fraction != null && (
        <progress
          className="progress"
          value={Math.max(0, Math.min(1, fraction))}
          max={1}
          aria-label="真实任务进度"
        />
      )}
      <div
        className={`stop-state ${job.stop_verified ? "verified" : "unverified"}`}
      >
        <Icon name={job.stop_verified ? "check" : "info"} size={14} />
        {job.stop_verified
          ? "实例已核实停止"
          : "实例停止尚未核实，预算预留保持有效"}
      </div>
      {job.error && (
        <MediaErrorBox
          error={job.error}
          stage="processing"
          stopVerified={job.stop_verified === 1}
          technicalDetails={<small>任务诊断：{job.error}</small>}
        />
      )}
      {processingReasons.map((reason, index) => (
        <MediaErrorBox
          key={index}
          error={reason}
          stage="processing"
          stopVerified={job.stop_verified === 1}
          technicalDetails={<small>处理探测说明：{reason}</small>}
        />
      ))}
      {expanded && (
        <div className="job-details">
          <dl className="info-list">
            <div>
              <dt>视频</dt>
              <dd className="mono">{job.video_id}</dd>
            </div>
            <div>
              <dt>总时限截止</dt>
              <dd>{date(job.deadline_at)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{date(job.updated_at)}</dd>
            </div>
          </dl>
          {job.progress_json && (
            <details open>
              <summary>实际处理反馈</summary>
              <JsonData value={progress || job.progress_json} />
            </details>
          )}
          {job.stop_evidence_json && (
            <details>
              <summary>停止核验证据</summary>
              <JsonData value={parseJSON(job.stop_evidence_json)} />
            </details>
          )}
          {job.consumption_json && (
            <details>
              <summary>消耗与对账</summary>
              <JsonData value={parseJSON(job.consumption_json)} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
function parseJSON(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function Jobs() {
  const jobs = useLoad<{ items: Job[] }>("/api/admin/jobs");
  const [error, setError] = useState<Error | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(jobs.reload, 10000);
    return () => window.clearInterval(timer);
  }, [jobs.reload]);
  async function cancel() {
    if (!cancelId) return;
    setBusy(true);
    setError(null);
    try {
      await send(`/api/admin/jobs/${encodeURIComponent(cancelId)}/cancel`);
      setCancelId(null);
      jobs.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <Notice>
        每个版本独立处理，不会自动公开或替换当前版本。任务总时限包含启动、下载、处理、上传、校验和停止；停止未核实的预留不会自动释放。
      </Notice>
      <div className="section-heading">
        <span className="muted">任务状态每 10 秒刷新</span>
        <button className="button small" onClick={jobs.reload}>
          <Icon name="refresh" size={15} />
          刷新
        </button>
      </div>
      {jobs.loading && !jobs.data ? (
        <Loading />
      ) : jobs.error ? (
        <MediaErrorBox
          error={jobs.error}
          stage="processing"
          retry={jobs.reload}
        />
      ) : jobs.data?.items.length ? (
        jobs.data.items.map((job) => (
          <JobCard job={job} key={job.id} onCancel={setCancelId} />
        ))
      ) : (
        <Empty
          icon="activity"
          title="还没有处理任务"
          description="在视频库中选择原片，获取报价并明确确认后即可开始。"
        />
      )}
      {cancelId && (
        <Modal
          title="取消处理任务"
          onClose={() => setCancelId(null)}
          busy={busy}
        >
          <p>
            将请求取消此任务并监督实例停止。已经产生的消耗会保留，未使用预算在停止核实后释放。
          </p>
          <MediaErrorBox error={error} stage="processing" />
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setCancelId(null)}
            >
              继续任务
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? "正在取消…" : "确认取消任务"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Usage() {
  return <ResourceUsage />;
}

type LogItem = {
  id: string;
  request_id: string | null;
  video_id: string | null;
  task_id: string | null;
  level: string;
  stage: string;
  message: string;
  details_json: string | null;
  created_at: number;
};
function Logs() {
  const [page, setPage] = useState(1);
  const logs = useLoad<Paged<LogItem>>(`/api/admin/logs?page=${page}`);
  return (
    <div className="stack">
      <Notice>
        详细诊断仅在管理员后台可见。日志采用脱敏内容，不应包含原始密码、Cookie、Token
        或带凭据 URL。
      </Notice>
      <div className="panel">
        <div className="section-heading">
          <h3>运行记录</h3>
          <button className="button small" onClick={logs.reload}>
            <Icon name="refresh" size={15} />
            刷新
          </button>
        </div>
        {logs.loading ? (
          <Loading />
        ) : logs.error ? (
          <ErrorBox error={logs.error} retry={logs.reload} />
        ) : !logs.data?.items.length ? (
          <Empty
            icon="activity"
            title="暂无运行记录"
            description="上传、任务、费用查询和删除操作会在此留下关联记录。"
          />
        ) : (
          <>
            <div className="log-list">
              {logs.data.items.map((item) => (
                <details className="log-entry" key={item.id}>
                  <summary>
                    <span className={`log-level level-${item.level}`}>
                      {item.level}
                    </span>
                    <div>
                      <strong>{item.message}</strong>
                      <small>
                        {date(item.created_at)} · {label(item.stage)}
                        {item.request_id
                          ? ` · 请求 ${item.request_id.slice(0, 12)}`
                          : ""}
                      </small>
                    </div>
                  </summary>
                  <div className="log-details">
                    <dl className="info-list">
                      <div>
                        <dt>请求 ID</dt>
                        <dd className="mono">{item.request_id || "—"}</dd>
                      </div>
                      <div>
                        <dt>视频 ID</dt>
                        <dd className="mono">{item.video_id || "—"}</dd>
                      </div>
                      <div>
                        <dt>任务 ID</dt>
                        <dd className="mono">{item.task_id || "—"}</dd>
                      </div>
                    </dl>
                    {item.details_json && (
                      <JsonData value={parseJSON(item.details_json)} />
                    )}
                  </div>
                </details>
              ))}
            </div>
            <Pagination
              page={page}
              total={logs.data.total}
              pageSize={logs.data.pageSize || 50}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}

const settingFields = [
  {
    key: "processing_concurrency",
    label: "同时处理任务数",
    description: "实际并发仍受账户能力与预算协调限制。",
    min: 1,
    max: 10,
  },
  {
    key: "task_timeout_seconds",
    label: "任务总时限（秒）",
    description: "包括启动、下载、探测、处理、上传、校验和停止。",
    min: 60,
    max: 21600,
  },
  {
    key: "history_retention_days",
    label: "观看历史闲置保留（天）",
    description: "仅清理长期闲置的观看记录。",
    min: 1,
    max: 3650,
  },
  {
    key: "log_retention_days",
    label: "详细日志保留（天）",
    description: "限制日志存储与长期成本，不影响视频对象。",
    min: 1,
    max: 90,
  },
  {
    key: "progress_interval_seconds",
    label: "观看进度保存间隔（秒）",
    description: "暂停、切换视频和页面转后台时会补存。",
    min: 15,
    max: 30,
  },
  {
    key: "storage_limit_bytes",
    label: "项目存储上限（字节）",
    description: "GiB = 1,073,741,824 字节；上传与处理预留一并检查。",
    min: 1,
    max: 20 * 1024 ** 3,
  },
  {
    key: "monthly_spend_limit_usd",
    label: "项目月费用上限（USD）",
    description:
      "当前仅使用可核验的包含额度；设置正数不会开启付费超额、订阅套餐或保证账户绝对零超额。",
    min: 0,
    max: 1000,
  },
];
function Settings() {
  const settings = useLoad<{
    settings: Array<{ key: string; value: string }>;
    config: Config;
  }>("/api/admin/settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data)
      setValues(
        Object.fromEntries(
          settings.data.settings
            .filter((item) =>
              settingFields.some((field) => field.key === item.key),
            )
            .map((item) => [item.key, item.value]),
        ),
      );
  }, [settings.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const editableValues = Object.fromEntries(
        settingFields.map(({ key }) => [key, values[key]]),
      );
      await send("/api/admin/settings", editableValues, "PATCH");
      setSaved(true);
      settings.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <SiteSettings />
      <WatchSettings />
      {settings.loading && !settings.data ? (
        <Loading />
      ) : settings.error ? (
        <ErrorBox error={settings.error} retry={settings.reload} />
      ) : (
        settings.data && (
          <>
            <div className="panel">
              <div className="section-heading">
                <h3>运行参数</h3>
                <span className="badge">当前 Worker 共用</span>
              </div>
              <form onSubmit={save}>
                <div className="settings-fields">
                  {settingFields.map((field) => (
                    <div className="setting-row" key={field.key}>
                      <div>
                        <label htmlFor={field.key}>{field.label}</label>
                        <p>{field.description}</p>
                      </div>
                      <input
                        id={field.key}
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={
                          field.key === "monthly_spend_limit_usd" ? "0.01" : "1"
                        }
                        required
                        value={values[field.key] ?? ""}
                        onChange={(e) => {
                          setValues((previous) => ({
                            ...previous,
                            [field.key]: e.target.value,
                          }));
                          setSaved(false);
                        }}
                      />
                    </div>
                  ))}
                </div>
                <ErrorBox error={error} />
                {saved && (
                  <p className="success-text" role="status">
                    <Icon name="check" size={15} />
                    运行参数已保存
                  </p>
                )}
                <div className="form-footer">
                  <button className="button primary" disabled={busy}>
                    {busy ? "保存中…" : "保存设置"}
                  </button>
                </div>
              </form>
            </div>
            <div className="panel">
              <h3>接入与运行时配置</h3>
              <dl className="info-list">
                <div>
                  <dt>当前入口</dt>
                  <dd className="mono">{location.origin}</dd>
                </div>
                <div>
                  <dt>环境</dt>
                  <dd>{settings.data.config.env || "无法确认"}</dd>
                </div>
                <div>
                  <dt>必要变量</dt>
                  <dd>
                    {settings.data.config.configured ? "已配置" : "尚未配置"}
                  </dd>
                </div>
                <div>
                  <dt>处理总开关</dt>
                  <dd>
                    {settings.data.config.processingEnabled ? "开启" : "关闭"}
                  </dd>
                </div>
                <div>
                  <dt>部署 commit</dt>
                  <dd className="mono">
                    {settings.data.config.buildCommit || "未提供"}
                  </dd>
                </div>
              </dl>
              <Notice>
                管理员密码、会话秘密、只读用量 Token 与处理总开关，在 Cloudflare
                Worker → Settings → Variables and Secrets
                中手工配置。不要把秘密填入本页面或发到聊天。正确连接到同一
                Worker 的其他域名共用目录，登录和观看记录分别隔离。
              </Notice>
            </div>
          </>
        )
      )}
    </div>
  );
}
