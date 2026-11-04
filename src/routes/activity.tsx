import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { listAuditFn } from "@/lib/storage/api";
import { ACTION_LABEL, formatWhen } from "@/lib/storage/pure";

export const Route = createFileRoute("/activity")({ component: ActivityPage });

function ActivityPage() {
  const { user } = useCurrentUserState();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listAuditFn>> | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    listAuditFn({ data: { offset } })
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load activity.");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, offset]);

  return (
    <Authed>
      <Shell>
        <PageHeader
          title="Activity"
          description="Creates, uploads, deletes, and key changes for this account."
        />
        {error ? <p className="mt-8 text-sm text-danger">{error}</p> : null}
        {!rows && !error ? <p className="mt-8 text-sm text-muted">Loading activity…</p> : null}
        <div className="mt-4 flex gap-4">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
            Previous
          </button>
          <span>Page {offset / 100 + 1}</span>
          <button disabled={!rows || rows.length < 100} onClick={() => setOffset(offset + 100)}>
            Next
          </button>
        </div>
        {rows && (
          <button
            className="mt-3 text-sm underline"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
              );
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `activity-page-${offset / 100 + 1}.json`;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export this page
          </button>
        )}
        {rows ? (
          <ol className="mt-6 overflow-hidden rounded-lg border border-border">
            {rows.length === 0 ? (
              <li className="px-4 py-6 text-sm text-muted">No activity yet.</li>
            ) : null}
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="text-sm">{ACTION_LABEL[row.action] ?? row.action}</span>
                <span className="truncate font-mono text-xs text-muted">{row.detail}</span>
                <span className="text-xs text-muted">{formatWhen(row.createdAt)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </Shell>
    </Authed>
  );
}
