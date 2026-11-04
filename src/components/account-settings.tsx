import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

export function AccountSettings() {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<
    { token: string; userAgent?: string | null; expiresAt: Date }[]
  >([]);
  async function load() {
    try {
      const result = await authClient.listSessions();
      if (result.error) setMessage(result.error.message || "Could not load sessions.");
      else setSessions(result.data || []);
    } catch {
      setMessage("Could not load sessions. Try again.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function change(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) setMessage(result.error.message || "Password change failed.");
      else {
        setCurrent("");
        setNext("");
        setMessage("Password changed. Other sessions revoked.");
        await load();
      }
    } catch {
      setMessage("Could not connect. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">Account security</h2>
      <p className="mt-2 text-sm text-muted">
        Replace your initial password after signing in. Changing it signs out your other browsers.
      </p>
      <form onSubmit={change} className="mt-4 grid gap-3">
        <label>
          Current password
          <input
            className="mt-1 block w-full rounded border border-border bg-bg p-2"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          New password
          <input
            className="mt-1 block w-full rounded border border-border bg-bg p-2"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={newPassword}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <button
          disabled={busy}
          className="rounded bg-primary p-2 text-primary-fg disabled:opacity-50"
        >
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
      <p role="status" className="mt-2 text-sm">
        {message}
      </p>
      <h3 className="mt-5 text-sm font-medium">Browser sessions ({sessions.length})</h3>
      <ul className="mt-2 space-y-2 text-xs text-muted">
        {sessions.map((session) => (
          <li key={session.token}>
            {session.userAgent || "Unknown browser"} · expires{" "}
            {new Date(session.expiresAt).toLocaleString()}
          </li>
        ))}
      </ul>
      <button
        className="mt-3 text-sm underline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await authClient.revokeOtherSessions();
            setMessage(
              result.error
                ? result.error.message || "Could not revoke sessions."
                : "Other browser sessions revoked.",
            );
            await load();
          } catch {
            setMessage("Could not connect.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign out other browsers
      </button>
    </section>
  );
}
