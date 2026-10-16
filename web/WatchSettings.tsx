import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, useLoad, date } from "./client";
import { ErrorBox, Icon, Loading, Modal, Notice } from "./ui";

type WatchSettingsData = {
  enabled: boolean;
  configured: boolean;
  revision: number;
  updatedAt: number;
};
export function WatchSettings() {
  const settings = useLoad<WatchSettingsData>("/api/admin/watch");
  const [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (settings.data) setEnabled(settings.data.enabled);
  }, [settings.data]);
  useEffect(() => () => flight.current?.abort(), []);
  async function mutate(revoke = false) {
    if (submitting.current || !settings.data || (revoke && !ack)) return;
    if (!revoke && enabled === settings.data.enabled && !password) return;
    if (
      !revoke &&
      (password.length > 128 ||
        (password.length > 0 && password.length < 8) ||
        (enabled && !settings.data.configured && !password))
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    const controller = new AbortController();
    flight.current = controller;
    try {
      const result = await api<WatchSettingsData>(
        revoke ? "/api/admin/watch/revoke" : "/api/admin/watch",
        {
          method: revoke ? "POST" : "PATCH",
          signal: controller.signal,
          body: JSON.stringify(
            revoke
              ? { expectedRevision: settings.data.revision, confirmed: true }
              : {
                  enabled,
                  ...(password ? { password } : {}),
                  expectedRevision: settings.data.revision,
                },
          ),
        },
        10000,
      );
      if (controller.signal.aborted) return;
      settings.setData(result);
      setPassword("");
      setRevokeOpen(false);
      setAck(false);
      setMessage(
        revoke
          ? "已撤销全部访客观看授权。"
          : "观看口令设置已保存，旧访客授权已失效。",
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure as Error);
        settings.reload();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      submitting.current = false;
    }
  }
  const dirty =
    settings.data && (enabled !== settings.data.enabled || !!password);
  return (
    <section
      className="panel watch-settings"
      aria-labelledby="watch-settings-title"
    >
      <div className="section-heading">
        <h3 id="watch-settings-title">
          <Icon name="lock" size={18} /> 访客观看口令
        </h3>
        <span className="badge">独立于管理员密码</span>
      </div>
      <p className="muted">
        欢迎页保持开放；开启后，访客需输入口令才能查看影片、播放媒体和访问自己的观看记录。管理员使用后台身份查看。授权
        Cookie 仅属于当前域名。
      </p>
      {settings.loading && !settings.data ? (
        <Loading />
      ) : settings.error ? (
        <ErrorBox error={settings.error} retry={settings.reload} />
      ) : (
        settings.data && (
          <>
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void mutate();
              }}
            >
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setMessage("");
                  }}
                />
                启用访客观看口令
              </label>
              <div className="field">
                <label htmlFor="viewing-password">
                  {settings.data.configured
                    ? "更换观看口令（留空保留）"
                    : "设置观看口令"}
                </label>
                <input
                  id="viewing-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  value={password}
                  disabled={busy}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setMessage("");
                  }}
                />
                <small className="muted">
                  8–128
                  个字符。保存开关或更换口令都会撤销旧访客授权；不会删除观看记录。
                </small>
              </div>
              <div className="form-footer">
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !dirty ||
                    (enabled &&
                      !settings.data.configured &&
                      password.length < 8) ||
                    (password.length > 0 && password.length < 8)
                  }
                >
                  {busy ? "保存中…" : "保存观看设置"}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={busy || !settings.data.enabled}
                  onClick={() => {
                    setAck(false);
                    setRevokeOpen(true);
                  }}
                >
                  撤销全部访客授权
                </button>
              </div>
            </form>
            <p className="muted small-text">
              当前：{settings.data.enabled ? "已启用" : "未启用"} · 口令
              {settings.data.configured ? "已设置" : "未设置"} · 更新{" "}
              {date(settings.data.updatedAt)}
            </p>
          </>
        )
      )}
      <ErrorBox error={error} />
      {message && (
        <p role="status" className="success-text">
          {message}
        </p>
      )}
      {revokeOpen && (
        <Modal
          title="撤销全部访客观看授权"
          busy={busy}
          onClose={() => setRevokeOpen(false)}
        >
          <Notice>
            所有域名上由当前 Worker
            签发的旧访客授权都会失效；访客需要重新输入当前口令。已下载或已缓冲的数据无法收回，播放页面最长约
            30 秒或下次请求时发现失效。管理员会话与观看记录保留。
          </Notice>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(event) => setAck(event.target.checked)}
            />
            我确认撤销所有访客授权，并了解已缓冲内容无法收回。
          </label>
          <ErrorBox error={error} />
          <div className="form-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setRevokeOpen(false)}
            >
              返回
            </button>
            <button
              className="button danger"
              disabled={busy || !ack}
              onClick={() => void mutate(true)}
            >
              {busy ? "撤销中…" : "确认撤销全部授权"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
