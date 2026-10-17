import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError } from "./client";
import { ThemeToggle, useSiteBrand } from "./public-theme";
import { Icon, Loading, Logo } from "./ui";

export type WatchSession = {
  enabled: boolean;
  authorized: boolean;
  configured: boolean;
  expiresAt?: number | null;
};
const WatchContext = createContext<{
  logout: () => void;
  busy: boolean;
} | null>(null);
export function WatchSessionControl() {
  const access = useContext(WatchContext);
  return access ? (
    <button
      className="text-button watch-logout"
      aria-label="退出观看"
      disabled={access.busy}
      onClick={access.logout}
    >
      <Icon name="logout" size={16} />
      <span>退出观看</span>
    </button>
  ) : null;
}
function validSession(value: WatchSession) {
  return (
    value &&
    typeof value.enabled === "boolean" &&
    typeof value.authorized === "boolean" &&
    typeof value.configured === "boolean" &&
    (!value.enabled ? value.authorized : true)
  );
}
export function WatchAccess({ children }: { children: ReactNode }) {
  const brand = useSiteBrand();
  const [session, setSession] = useState<WatchSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [failedLogout, setFailedLogout] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const logoutBlocked = useRef(false);
  const current = (controller: AbortController, epoch: number) =>
    mounted.current &&
    !controller.signal.aborted &&
    generation.current === epoch;
  async function check(force = false) {
    if (flight.current && !force) return;
    flight.current?.abort();
    const controller = new AbortController(),
      epoch = ++generation.current;
    flight.current = controller;
    setChecking(true);
    try {
      const result = await api<WatchSession>(
        "/api/watch/session",
        { signal: controller.signal },
        5000,
      );
      if (!current(controller, epoch)) return;
      if (!validSession(result)) throw new Error("Invalid session receipt");
      setSession(result);
      setError("");
      setFailedLogout(false);
    } catch {
      if (current(controller, epoch)) {
        setSession(null);
        setError("暂时无法核验观看权限，请稍后重试。");
      }
    } finally {
      if (current(controller, epoch)) {
        flight.current = null;
        setChecking(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void check();
    const refresh = () => {
      if (!submitting.current && !logoutBlocked.current) void check();
    };
    const rejected = () => {
      setSession(null);
      if (logoutBlocked.current) return;
      submitting.current = false;
      setBusy(false);
      if (!logoutBlocked.current) void check(true);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("hub-watch-required", rejected);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      mounted.current = false;
      generation.current++;
      flight.current?.abort();
      flight.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("hub-watch-required", rejected);
    };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || password.length < 8 || password.length > 128)
      return;
    submitting.current = true;
    logoutBlocked.current = false;
    setBusy(true);
    setError("");
    setFailedLogout(false);
    flight.current?.abort();
    const controller = new AbortController(),
      epoch = ++generation.current;
    flight.current = controller;
    try {
      await api(
        "/api/watch/login",
        {
          method: "POST",
          body: JSON.stringify({ password }),
          signal: controller.signal,
        },
        5000,
      );
      if (!current(controller, epoch)) return;
      const result = await api<WatchSession>(
        "/api/watch/session",
        { signal: controller.signal },
        5000,
      );
      if (!current(controller, epoch)) return;
      if (!validSession(result)) throw new Error("Invalid session receipt");
      setSession(result);
      if (!result.authorized)
        setError("浏览器未接受观看授权，允许 Cookie 后可重试。");
      setPassword("");
    } catch (failure) {
      if (current(controller, epoch))
        setError(
          failure instanceof ApiError && failure.status === 401
            ? "观看口令不正确或已更新，请重新输入。"
            : failure instanceof ApiError && failure.status === 429
              ? "操作较频繁，请稍后重试。"
              : "暂时无法验证观看口令，请稍后重试。",
        );
    } finally {
      if (current(controller, epoch)) {
        flight.current = null;
        setBusy(false);
        setChecking(false);
      }
      if (generation.current === epoch) submitting.current = false;
    }
  }
  async function logout() {
    if (submitting.current) return;
    submitting.current = true;
    logoutBlocked.current = true;
    setBusy(true);
    setSession(null);
    setChecking(false);
    setError("");
    flight.current?.abort();
    const controller = new AbortController(),
      epoch = ++generation.current;
    flight.current = controller;
    try {
      await api(
        "/api/watch/logout",
        { method: "POST", body: "{}", signal: controller.signal },
        5000,
      );
      if (!current(controller, epoch)) return;
      const result = await api<WatchSession>(
        "/api/watch/session",
        { signal: controller.signal },
        5000,
      );
      if (!current(controller, epoch)) return;
      if (!validSession(result) || (result.enabled && result.authorized))
        throw new Error("Logout not confirmed");
      logoutBlocked.current = false;
      setFailedLogout(false);
      setSession(result);
    } catch {
      if (current(controller, epoch)) {
        setFailedLogout(true);
        setError("退出观看尚未核实，请重试。历史记录和主题偏好仍保留。");
      }
    } finally {
      if (current(controller, epoch)) {
        flight.current = null;
        setBusy(false);
        submitting.current = false;
      }
    }
  }
  if (session?.authorized) {
    const canLogout =
      session.enabled &&
      typeof session.expiresAt === "number" &&
      session.expiresAt > 0;
    return (
      <WatchContext.Provider
        value={canLogout ? { logout: () => void logout(), busy } : null}
      >
        {children}
      </WatchContext.Provider>
    );
  }
  const unavailable = session?.enabled && !session.configured;
  return (
    <div className="public-app watch-access-page">
      <header className="welcome-header public-container">
        <Logo brand={brand} />
        <ThemeToggle />
      </header>
      <main className="watch-access-card" aria-labelledby="watch-access-title">
        <span className="watch-access-lock">
          <Icon name="lock" size={27} />
        </span>
        <span className="eyebrow">A QUIET PLACE FOR STORIES</span>
        <h1 id="watch-access-title">
          {unavailable ? "放映室暂时不可用" : "输入观看口令"}
        </h1>
        <p>一段只与受邀的人分享的观影时光。</p>
        {checking && !busy ? (
          <Loading text="正在核验观看权限…" />
        ) : unavailable ? (
          <p role="status">观看口令尚未配置，请稍后再来。</p>
        ) : session ? (
          <form onSubmit={login}>
            <label className="field-label" htmlFor="watch-password">
              观看口令
            </label>
            <input
              id="watch-password"
              type="password"
              autoComplete="current-password"
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={busy}
            />
            <button
              className="button primary full"
              disabled={busy || password.length < 8 || password.length > 128}
            >
              {busy ? "正在验证…" : "进入放映室"}
              <Icon name="arrow" size={17} />
            </button>
          </form>
        ) : null}
        {error && (
          <p className="watch-access-error" role="alert">
            {error}
          </p>
        )}
        {!checking && (error || unavailable) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => (failedLogout ? void logout() : void check(true))}
          >
            {failedLogout ? "重试退出观看" : "重新核验"}
          </button>
        )}
        <a className="text-button" href="/">
          ← 返回欢迎页
        </a>
        <small>授权仅属于当前域名。观看记录不会因退出而清除。</small>
      </main>
    </div>
  );
}
