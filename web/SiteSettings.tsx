import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, send, useLoad } from "./client";
import { ErrorBox, Icon, Loading, Notice } from "./ui";
import "./site-settings.css";

interface SiteSettingsData {
  name: string;
  logoUrl: string | null;
  searchIndexing: boolean;
  updatedAt: number;
}

function announceSiteChange() {
  window.dispatchEvent(new Event("hub-site-changed"));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("video-hub-site");
    channel.postMessage("changed");
    channel.close();
  }
}

function readPreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      clearTimeout(timeout);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const fail = () => {
      cleanup();
      reject(new Error("图片读取失败，请重新选择。"));
    };
    const timeout = setTimeout(() => {
      reader.abort();
      fail();
    }, 10000);
    reader.onload = () => {
      const value = reader.result;
      cleanup();
      if (
        typeof value !== "string" ||
        !/^data:image\/(png|jpeg);base64,/.test(value)
      ) {
        reject(new Error("图片格式不受支持。"));
        return;
      }
      resolve(value);
    };
    reader.onerror = fail;
    reader.onabort = fail;
    reader.readAsDataURL(file);
  });
}

export function SiteSettings() {
  const settings = useLoad<SiteSettingsData>("/api/admin/site");
  const [name, setName] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [checkingImage, setCheckingImage] = useState(false);
  const selection = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settings.data) return;
    setName(settings.data.name);
    setIndexing(settings.data.searchIndexing);
    setLogoFailed(false);
  }, [settings.data]);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );

  function accepted(result: SiteSettingsData, text: string) {
    settings.setData(result);
    setMessage(text);
    announceSiteChange();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      accepted(
        await send<SiteSettingsData>(
          "/api/admin/site",
          { name, searchIndexing: indexing },
          "PATCH",
        ),
        "网站名称与搜索引擎设置已保存。",
      );
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function chooseImage(chosen: File | null) {
    const epoch = ++selection.current;
    setFile(null);
    setPreview(null);
    setLogoFailed(false);
    setError(null);
    setMessage("");
    if (!chosen) return;
    if (
      !["image/png", "image/jpeg"].includes(chosen.type) ||
      chosen.size > 512 * 1024 ||
      chosen.size === 0
    ) {
      setError(new Error("请选择不超过 512 KiB 的 PNG 或 JPEG 图片。"));
      return;
    }
    setCheckingImage(true);
    try {
      // A bounded data URL works with the existing img-src 'self' data: CSP.
      const previewUrl = await readPreview(chosen);
      if (epoch !== selection.current) return;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error("图片无法解码，请选择有效的 PNG 或 JPEG。"));
      });
      image.src = previewUrl;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          loaded,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("图片读取超时，请重新选择。")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
      }
      if (epoch !== selection.current) return;
      if (
        image.naturalWidth < 32 ||
        image.naturalHeight < 32 ||
        image.naturalWidth > 2048 ||
        image.naturalHeight > 2048 ||
        image.naturalWidth * image.naturalHeight > 4_000_000
      )
        throw new Error(
          "图片宽高须在 32–2048 像素之间，总像素不超过 400 万。请使用清晰、留白适当的 Logo。",
        );
      setFile(chosen);
      setPreview(previewUrl);
    } catch (failure) {
      if (epoch === selection.current) setError(failure as Error);
    } finally {
      if (epoch === selection.current) setCheckingImage(false);
    }
  }
  async function saveLogo() {
    if (!file || busy || checkingImage) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      accepted(
        await api<SiteSettingsData>(
          "/api/admin/site/logo",
          {
            method: "POST",
            headers: { "Content-Type": file.type },
            body: file,
          },
          30000,
        ),
        "Logo 已保存，各入口刷新后使用同一品牌设置。",
      );
      setFile(null);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function restoreLogo() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      accepted(
        await api<SiteSettingsData>("/api/admin/site/logo", {
          method: "DELETE",
        }),
        "已恢复默认 Logo，视频文件保持原状。",
      );
      setFile(null);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error && !settings.data)
    return <ErrorBox error={settings.error} retry={settings.reload} />;
  const shownLogo = preview || settings.data?.logoUrl;
  return (
    <section
      className="panel site-settings"
      aria-labelledby="site-settings-heading"
    >
      <div className="section-heading">
        <h3 id="site-settings-heading">网站品牌与收录</h3>
        <span className="badge">保存后直接生效</span>
      </div>
      <ErrorBox error={settings.error} retry={settings.reload} />
      <form onSubmit={save}>
        <label htmlFor="site-display-name">网站名称</label>
        <input
          id="site-display-name"
          maxLength={60}
          value={name}
          placeholder="Video Hub"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="muted small-text">
          留空使用默认名称 Video Hub。前台页头、页脚与页面标题共用此设置。
        </p>
        <label className="site-indexing-choice">
          <input
            type="checkbox"
            checked={indexing}
            disabled={busy}
            onChange={(event) => setIndexing(event.target.checked)}
          />
          <span>允许搜索引擎收录本站</span>
        </label>
        <p className="muted small-text">
          默认关闭。开启只影响正常公开页面与已发布内容，后台、私人观看记录和管理员预览仍受保护。这是收录控制，不能保证阻止所有爬虫；已有搜索结果消失可能需要时间。
        </p>
        <button className="button primary" disabled={busy}>
          {busy ? "保存中…" : "保存网站设置"}
        </button>
      </form>
      <div className="site-logo-settings">
        <h4>网站 Logo</h4>
        <div className="site-logo-preview" aria-label="Logo 预览">
          {shownLogo && !logoFailed ? (
            <img
              src={shownLogo}
              alt="网站 Logo 预览"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="brand-icon">
              <Icon name="play" size={24} />
            </span>
          )}
          <span>{name.trim() || "Video Hub"}</span>
        </div>
        <label htmlFor="site-logo-file">选择 Logo 图片</label>
        <input
          ref={fileInput}
          id="site-logo-file"
          type="file"
          accept="image/png,image/jpeg"
          disabled={busy || checkingImage}
          onChange={(event) =>
            void chooseImage(event.target.files?.[0] || null)
          }
        />
        <p className="muted small-text">
          PNG／JPEG，最多 512 KiB，宽高 32–2048
          像素。图片按比例显示，上传不会启动视频处理。图片存储与读取可能产生相应用量。
        </p>
        <div className="site-logo-actions">
          <button
            type="button"
            className="button primary"
            disabled={!file || busy || checkingImage}
            onClick={() => void saveLogo()}
          >
            {checkingImage ? "正在检查图片…" : "保存 Logo"}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || checkingImage || !settings.data?.logoUrl}
            onClick={() => void restoreLogo()}
          >
            恢复默认 Logo
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={settings.reload}
          >
            重新读取当前设置
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {message && (
        <p className="success-text" role="status">
          <Icon name="check" size={15} />
          {message}
        </p>
      )}
      <Notice>
        同一 Worker
        的各域名共用品牌与收录设置，测试和生产环境分别保存。保存结果因网络中断无法确认时，先重新读取当前设置再重试。
      </Notice>
    </section>
  );
}
