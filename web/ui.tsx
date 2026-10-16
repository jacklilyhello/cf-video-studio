import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, label } from "./client";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    play: <path d="m9 5 11 7-11 7z" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    storage: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v7c0 4 18 4 18 0V5M3 12v7c0 4 18 4 18 0v-7" />
      </>
    ),
    activity: <path d="M2 12h4l3-8 5 16 3-8h5" />,
    settings: (
      <>
        <path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 2 3-1 2 3 4-1 1-3 3-1 1-4-3-2-1-3-4-1z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-8" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 7M4 12l2 7a7 7 0 0 0 12-2" />
      </>
    ),
    logout: (
      <>
        <path d="M9 3H4v18h5m6-15 6 6-6 6m6-6H9" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    film: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M7 3v18m10-18v18M3 8h4m-4 8h4m10-8h4m-4 8h4" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    moon: <path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.film}
    </svg>
  );
}
export function Logo({
  small = false,
  brand,
}: {
  small?: boolean;
  brand?: { name: string; logoUrl: string | null };
}) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const image = brand?.logoUrl && failedLogo !== brand.logoUrl;
  return (
    <a className={`brand ${small ? "small" : ""}`} href="/">
      <span className="brand-icon">
        {image ? (
          <img
            className="brand-image"
            src={brand.logoUrl!}
            alt=""
            decoding="async"
            onError={() => setFailedLogo(brand.logoUrl)}
          />
        ) : (
          <Icon name="play" size={20} />
        )}
      </span>
      <span>
        {brand ? (
          brand.name
        ) : (
          <>
            Video<span className="brand-light">Hub</span>
          </>
        )}
        <small>你的私人放映室</small>
      </span>
    </a>
  );
}
export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{label(value)}</span>;
}
export function Loading({ text = "正在加载…" }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
export function Empty({
  icon = "film",
  title,
  description,
  children,
}: {
  icon?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function ErrorBox({
  error,
  retry,
  publicMessage,
}: {
  error: Error | string | null;
  retry?: () => void;
  publicMessage?: boolean;
}) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <Icon name="info" />
      <div>
        <strong>
          {publicMessage
            ? "暂时无法加载，请稍后重试。"
            : typeof error === "string"
              ? error
              : error.message}
        </strong>
        {!publicMessage && error instanceof ApiError && error.requestId && (
          <details>
            <summary>诊断信息</summary>
            <small>请求编号：{error.requestId}</small>
            <small>代码：{error.code}</small>
          </details>
        )}
      </div>
      {retry && (
        <button className="button small" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}
export function Pagination({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>
        共 {total} 项 · 第 {page} / {pages} 页
      </span>
      <div>
        <button
          className="button small"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          className="button small"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus();
    function onKey(e: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== box.current) return;
      if (e.key === "Escape" && !busy) onClose();
      if (e.key !== "Tab") return;
      const nodes = box.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], video, [tabindex="0"]',
      );
      if (!nodes?.length) {
        e.preventDefault();
        return;
      }
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === box.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [busy, onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function JsonData({ value }: { value: unknown }) {
  return (
    <pre className="data-box">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
