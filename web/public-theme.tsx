import { useEffect, useRef, useState } from "react";
import { useLoad } from "./client";
import { Icon } from "./ui";

export type PublicTheme = "light" | "dark";
export type SiteBrand = {
  name: string;
  logoUrl: string | null;
  searchIndexing: boolean;
  updatedAt: number;
};
export const THEME_STORAGE_KEY = "video-hub-public-theme";
export const DEFAULT_SITE: SiteBrand = {
  name: "Video Hub",
  logoUrl: null,
  searchIndexing: false,
  updatedAt: 0,
};
export function normalizeSiteBrand(value: unknown): SiteBrand {
  const input =
    value && typeof value === "object" ? (value as Partial<SiteBrand>) : {};
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : DEFAULT_SITE.name;
  const logo =
    typeof input.logoUrl === "string" &&
    input.logoUrl.trim() === input.logoUrl &&
    /^\/site-logo\/[a-f0-9]{64}\.(?:png|jpg)$/.test(input.logoUrl)
      ? input.logoUrl
      : null;
  return {
    name,
    logoUrl: logo,
    searchIndexing: input.searchIndexing === true,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : 0,
  };
}
export function useSiteBrand() {
  const site = useLoad<SiteBrand>("/api/site");
  useEffect(() => {
    let refreshedAt = -Infinity;
    let trailingRefresh: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const remaining = 1000 - (Date.now() - refreshedAt);
      if (remaining > 0) {
        if (!trailingRefresh)
          trailingRefresh = setTimeout(() => {
            trailingRefresh = null;
            refresh();
          }, remaining);
        return;
      }
      if (trailingRefresh) clearTimeout(trailingRefresh);
      trailingRefresh = null;
      refreshedAt = Date.now();
      site.reload();
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("video-hub-site");
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === "changed") refresh();
      };
    window.addEventListener("focus", refresh);
    window.addEventListener("hub-site-changed", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (trailingRefresh) clearTimeout(trailingRefresh);
      channel?.close();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("hub-site-changed", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [site.reload]);
  return normalizeSiteBrand(site.data);
}
function storedTheme(): PublicTheme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}
export function systemPublicTheme(): PublicTheme {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
export function readPublicTheme(): PublicTheme {
  const applied =
    typeof document !== "undefined"
      ? document.documentElement?.getAttribute("data-public-theme")
      : null;
  return applied === "light" || applied === "dark"
    ? applied
    : (storedTheme() ?? systemPublicTheme());
}
export function applyPublicTheme(theme: PublicTheme) {
  document.documentElement?.setAttribute("data-public-theme", theme);
  document
    .querySelector?.('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#18313d" : "#f5f2e9");
}
export function ThemeToggle() {
  const [theme, setTheme] = useState<PublicTheme>(readPublicTheme);
  const manual = useRef<PublicTheme | null>(storedTheme());
  useEffect(() => {
    const update = () => {
      const next = manual.current ?? systemPublicTheme();
      applyPublicTheme(next);
      setTheme(next);
    };
    update();
    const query =
      typeof matchMedia === "function"
        ? matchMedia("(prefers-color-scheme: dark)")
        : null;
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        manual.current = storedTheme();
        update();
      }
    };
    query?.addEventListener("change", update);
    window.addEventListener("storage", storage);
    return () => {
      query?.removeEventListener("change", update);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={
        theme === "dark" ? "切换至月白浅色模式" : "切换至月夜深色模式"
      }
      title={theme === "dark" ? "切换至浅色" : "切换至深色"}
      aria-pressed={theme === "dark"}
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        manual.current = next;
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          /* A blocked preference store does not block this page. */
        }
        applyPublicTheme(next);
        setTheme(next);
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={19} />
      <span>{theme === "dark" ? "月白" : "月夜"}</span>
    </button>
  );
}
