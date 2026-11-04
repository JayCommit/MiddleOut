import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Logo } from "@/components/logo";
import { SignInPanel } from "@/components/sign-in-panel";
import { Shell } from "@/components/shell";
import { PageHeader, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { fetchOverview } from "@/lib/storage/api";
import { ACTION_LABEL, formatBytes, formatWhen } from "@/lib/storage/pure";

export const Route = createFileRoute("/")({ component: Home });

type Overview = Awaited<ReturnType<typeof fetchOverview>>;

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending || user) return <Console pending={isPending} />;
  return <Landing />;
}

function Landing() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-5 py-12 text-fg">
      <section className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <Logo />
        <h1 className="mt-8 text-2xl font-semibold">Storage console</h1>
        <p className="mb-6 mt-2 text-sm text-muted">Sign in to manage this node.</p>
        <SignInPanel />
      </section>
    </main>
  );
}

function Console({ pending }: { pending: boolean }) {
  const { user } = useCurrentUserState();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    fetchOverview()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load storage.");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <Shell>
      <PageHeader title="Dashboard" description="One node. Persistent object storage, private until you open a bucket." />
      {pending || (!data && !error) ? <LoadingDash /> : error ? (
        <p className="mt-8 text-sm text-danger">{error}</p>
      ) : data ? (
        <Dashboard data={data} />
      ) : null}
    </Shell>
  );
}

function Dashboard({ data }: { data: Overview }) {
  const pct = Math.min(100, data.quota ? Math.round((data.stats.bytes / data.quota) * 100) : 0);
  const chart = data.buckets.map((bucket) => ({
    name: bucket.name.length > 18 ? `${bucket.name.slice(0, 16)}…` : bucket.name,
    bytes: bucket.bytes,
  }));
  return (
    <div className="mt-8 flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Buckets" value={String(data.stats.buckets)} />
        <Stat label="Objects" value={String(data.stats.objects)} />
        <Stat label="Stored" value={formatBytes(data.stats.bytes)} />
        <Stat label="Public" value={String(data.stats.publicBuckets)} />
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between text-sm">
          <span>Account usage</span>
          <span className="text-muted">
            {formatBytes(data.stats.bytes)} / {formatBytes(data.quota)}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised">
          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-lg border border-border bg-surface p-4 lg:col-span-3">
          <h2 className="text-sm font-medium">Storage by bucket</h2>
          {chart.length === 0 ? (
            <p className="mt-6 text-sm text-muted">No buckets yet.</p>
          ) : (
            <div className="mt-4 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={120}
                    tick={{ fill: "var(--color-muted)", fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    formatter={(value) => formatBytes(Number(value))}
                    cursor={{ fill: "var(--color-raised)" }}
                    contentStyle={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      color: "var(--color-fg)",
                    }}
                  />
                  <Bar dataKey="bytes" fill="var(--color-primary)" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
        <section className="rounded-lg border border-border bg-surface p-4 lg:col-span-2">
          <h2 className="text-sm font-medium">Recent activity</h2>
          <ul className="mt-3 flex flex-col">
            {data.activity.length === 0 ? <li className="text-sm text-muted">Nothing recorded yet.</li> : null}
            {data.activity.map((event) => (
              <li key={event.id} className="border-b border-border py-3 last:border-b-0">
                <p className="text-sm">{ACTION_LABEL[event.action] ?? event.action}</p>
                <p className="truncate font-mono text-xs text-muted">{event.detail}</p>
                <p className="text-xs text-muted">{formatWhen(event.createdAt)}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Buckets</h2>
          <Link to="/buckets" className="text-sm text-primary">
            Manage
          </Link>
        </div>
        <ul>
          {data.buckets.map((bucket) => (
            <li key={bucket.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
              <Link to="/buckets/$name" params={{ name: bucket.name }} search={{ prefix: "" }} className="min-w-0 truncate font-mono text-sm">
                {bucket.name}
              </Link>
              <div className="flex items-center gap-3">
                <span className="hidden text-xs text-muted sm:inline">{formatBytes(bucket.bytes)}</span>
                <Pill tone={bucket.isPublic ? "accent" : "neutral"}>{bucket.isPublic ? "Public" : "Private"}</Pill>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LoadingDash() {
  return (
    <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {["Buckets", "Objects", "Stored", "Public"].map((label) => (
        <div key={label} className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs text-muted">{label}</p>
          <div className="mt-3 h-7 w-16 animate-pulse rounded-md bg-raised" />
        </div>
      ))}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}
