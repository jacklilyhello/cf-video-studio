import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBox, Icon, Loading, Logo } from "./ui";
import { Welcome } from "./Welcome";
import { WatchAccess } from "./WatchAccess";
import "./styles.css";
import "./admin-theme.css";
import { recordPageVisit } from "./playback-telemetry";

const Admin = React.lazy(() =>
  import("./Admin").then((module) => ({ default: module.Admin })),
);
const PublicSite = React.lazy(() =>
  import("./PublicSite").then((module) => ({ default: module.PublicSite })),
);

export function App() {
  React.useEffect(() => {
    void recordPageVisit();
  }, []);
  if (/^\/admin(?:\/|$)/.test(location.pathname))
    return (
      <React.Suspense
        fallback={
          <div className="public-app admin-app">
            <Loading text="正在载入管理后台…" />
          </div>
        }
      >
        <Admin />
      </React.Suspense>
    );
  if (
    location.pathname === "/video" ||
    (location.pathname === "/" &&
      new URLSearchParams(location.search).has("video"))
  )
    return (
      <WatchAccess>
        <React.Suspense
          fallback={
            <div className="public-app">
              <Loading text="正在进入放映室…" />
            </div>
          }
        >
          <PublicSite />
        </React.Suspense>
      </WatchAccess>
    );
  return <Welcome />;
}
class AppBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div
          className={
            /^\/admin(?:\/|$)/.test(location.pathname)
              ? "public-app admin-app login-page"
              : "public-app login-page"
          }
        >
          <Logo />
          <div className="login-card">
            <ErrorBox error="页面暂时无法加载。请检查网络后重新打开。" />
            <button
              className="button primary full"
              onClick={() => location.reload()}
            >
              重新加载页面
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
