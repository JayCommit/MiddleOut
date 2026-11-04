import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, PageHeader } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { setRegionFn, settingsFn } from "@/lib/storage/api";
import { s3Endpoint, withBase } from "@/lib/storage/paths";
import { REGIONS, formatBytes } from "@/lib/storage/pure";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const { user } = useCurrentUserState();
  const [region, setRegion] = useState("us-east-1");
  const [quota, setQuota] = useState(0);
  const [maxObject, setMaxObject] = useState(0);
  const [endpoint, setEndpoint] = useState("/api/s3");
  const [health, setHealth] = useState("Checking…");

  useEffect(() => setEndpoint(s3Endpoint()), []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    settingsFn()
      .then((settings) => {
        if (cancelled) return;
        setRegion(settings.region);
        setQuota(settings.quota);
        setMaxObject(settings.maxObject);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load settings.");
      });
    fetch(withBase("/api/health"))
      .then((response) => response.json() as Promise<{ ok?: boolean }>)
      .then((body) => {
        if (!cancelled) setHealth(body.ok ? "Healthy" : "Not ready");
      })
      .catch(() => {
        if (!cancelled) setHealth("Unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <Authed>
    <Shell>
      <PageHeader title="Settings" description="Region is a label on new buckets and the location constraint clients read back." />
      <div className="mt-6 grid max-w-2xl gap-4">
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">Node</h2>
          <dl className="mt-3 grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Health</dt>
              <dd>{health}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Object limit</dt>
              <dd>{maxObject ? formatBytes(maxObject) : "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">Account quota</dt>
              <dd>{quota ? formatBytes(quota) : "—"}</dd>
            </div>
          </dl>
        </section>
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">S3 endpoint</h2>
          <p className="mt-2 break-all font-mono text-xs">{endpoint}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            onClick={() => {
              void navigator.clipboard.writeText(endpoint);
              toast.success("Endpoint copied");
            }}
          >
            Copy endpoint
          </Button>
        </section>
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">Default region</h2>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <select
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              className="h-11 flex-1 rounded-md border border-border bg-bg px-3 text-sm"
            >
              {REGIONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <Button
              type="button"
              onClick={() => {
                void setRegionFn({ data: { region } }).then((result) => {
                  if (!result.ok) toast.error(result.error);
                  else toast.success("Region saved");
                });
              }}
            >
              Save
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted">Existing buckets keep the region they were created with.</p>
        </section>
      </div>
    </Shell>
    </Authed>
  );
}
