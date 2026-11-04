import { AccountSettings } from "@/components/account-settings";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, PageHeader } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  cleanupExpiredFn,
  listSharesFn,
  revokeShareFn,
  setRegionFn,
  settingsFn,
} from "@/lib/storage/api";
import { absoluteUrl, s3Endpoint, withBase } from "@/lib/storage/paths";
import { REGIONS, formatBytes, formatWhen } from "@/lib/storage/pure";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

type ShareRow = Awaited<ReturnType<typeof listSharesFn>>[number];

function SettingsPage() {
  const { user } = useCurrentUserState();
  const [nodeInfo, setNodeInfo] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [quota, setQuota] = useState(0);
  const [maxObject, setMaxObject] = useState(0);
  const [endpoint, setEndpoint] = useState("/api/s3");
  const [health, setHealth] = useState("Checking…");
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => setEndpoint(s3Endpoint()), []);

  async function loadShares() {
    listSharesFn()
      .then((rows) => setShares(rows))
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    settingsFn()
      .then((settings) => {
        if (cancelled) return;
        setNodeInfo(
          `${settings.version} · ${settings.backend} · ${settings.origin} · ${settings.accountMode}`,
        );
        setRegion(settings.region);
        setQuota(settings.quota);
        setMaxObject(settings.maxObject);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load settings.");
      });

    loadShares();

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
        <PageHeader
          title="Settings"
          description="Region is a label on new buckets and the location constraint clients read back."
        />
        <div className="mt-6 grid max-w-2xl gap-4">
          <AccountSettings />
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">Node</h2>
            <p className="mt-2 break-all text-xs text-muted">{nodeInfo}</p>
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
            <p className="mt-3 text-sm text-muted">
              Existing buckets keep the region they were created with.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Active share links</h2>
              <span className="text-xs text-muted">{shares.length} active</span>
            </div>
            {shares.length === 0 ? (
              <p className="mt-3 text-xs text-muted">
                No active share links. Create one from any object's preview modal.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {shares.map((s) => (
                  <li
                    key={s.token}
                    className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium">
                        {s.bucket} / {s.key}
                      </p>
                      <p className="text-muted">Expires: {formatWhen(s.expiresAt)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(absoluteUrl(`/api/share/${s.token}`));
                          toast.success("Link copied");
                        }}
                      >
                        Copy
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-danger hover:text-danger"
                        onClick={() => {
                          void revokeShareFn({ data: { token: s.token } }).then((res) => {
                            if (!res.ok) toast.error(res.error);
                            else {
                              toast.success("Share link revoked");
                              loadShares();
                            }
                          });
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">Maintenance</h2>
            <p className="mt-1 text-xs text-muted">
              Clean up expired share links and aborted or orphaned upload parts older than 24 hours.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={cleaning}
              className="mt-3"
              onClick={() => {
                setCleaning(true);
                void cleanupExpiredFn()
                  .then(() => {
                    toast.success("Cleanup completed successfully");
                    loadShares();
                  })
                  .catch(() => toast.error("Cleanup failed"))
                  .finally(() => setCleaning(false));
              }}
            >
              {cleaning ? "Cleaning…" : "Clean up expired uploads & links"}
            </Button>
          </section>
        </div>
      </Shell>
    </Authed>
  );
}
