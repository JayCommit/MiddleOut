import { AccountSettings } from "@/components/account-settings";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, Field, Input, Modal, PageHeader, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  cleanupExpiredFn,
  listSharesFn,
  revokeShareFn,
  setRegionFn,
  settingsFn,
  updateStorageLimitsFn,
  getDriveCredentialsFn,
  saveDriveCredentialsFn,
  deleteDriveCredentialsFn,
  testDriveConnectionFn,
} from "@/lib/storage/api";
import { absoluteUrl, s3Endpoint, withBase } from "@/lib/storage/paths";
import { REGIONS, formatBytes, formatWhen } from "@/lib/storage/pure";
import { Cloud } from "lucide-react";

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

  // Storage limits controls
  const [maxObjectVal, setMaxObjectVal] = useState(1);
  const [maxObjectUnit, setMaxObjectUnit] = useState<"MB" | "GB">("GB");
  const [quotaVal, setQuotaVal] = useState(10);
  const [quotaUnit, setQuotaUnit] = useState<"MB" | "GB" | "TB">("GB");
  const [savingLimits, setSavingLimits] = useState(false);

  // Google Drive state
  const [driveCreds, setDriveCreds] = useState<Awaited<ReturnType<typeof getDriveCredentialsFn>> | null>(null);
  const [driveModalOpen, setDriveModalOpen] = useState(false);
  const [driveAuthType, setDriveAuthType] = useState<"oauth" | "service_account">("oauth");
  const [driveClientId, setDriveClientId] = useState("");
  const [driveClientSecret, setDriveClientSecret] = useState("");
  const [driveRefreshToken, setDriveRefreshToken] = useState("");
  const [driveServiceAccountJson, setDriveServiceAccountJson] = useState("");
  const [testingDrive, setTestingDrive] = useState(false);
  const [savingDrive, setSavingDrive] = useState(false);

  async function loadDrive() {
    getDriveCredentialsFn()
      .then((c) => setDriveCreds(c))
      .catch(() => undefined);
  }

  useEffect(() => setEndpoint(s3Endpoint()), []);

  async function loadShares() {
    listSharesFn()
      .then((rows) => setShares(rows))
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    loadDrive();
    settingsFn()
      .then((settings) => {
        if (cancelled) return;
        setNodeInfo(
          `${settings.version} · ${settings.backend} · ${settings.origin} · ${settings.accountMode}`,
        );
        setRegion(settings.region);
        setQuota(settings.quota);
        setMaxObject(settings.maxObject);

        if (settings.maxObject >= 1024 * 1024 * 1024) {
          setMaxObjectVal(Math.round(settings.maxObject / (1024 * 1024 * 1024)));
          setMaxObjectUnit("GB");
        } else {
          setMaxObjectVal(Math.max(1, Math.round(settings.maxObject / (1024 * 1024))));
          setMaxObjectUnit("MB");
        }

        if (settings.quota >= 1024 ** 4) {
          setQuotaVal(Math.round(settings.quota / 1024 ** 4));
          setQuotaUnit("TB");
        } else if (settings.quota >= 1024 * 1024 * 1024) {
          setQuotaVal(Math.round(settings.quota / (1024 * 1024 * 1024)));
          setQuotaUnit("GB");
        } else {
          setQuotaVal(Math.max(1, Math.round(settings.quota / (1024 * 1024))));
          setQuotaUnit("MB");
        }
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
            <h2 className="text-sm font-medium">Storage & upload limits</h2>
            <p className="mt-1 text-xs text-muted">
              Configure upload size maximums and total account storage quota. Default object upload max is 1 GB, and can be configured higher or lower.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted">Max upload size</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="50000"
                    value={maxObjectVal}
                    onChange={(e) => setMaxObjectVal(Math.max(1, Number(e.target.value)))}
                    className="h-10 w-full rounded-md border border-border bg-bg px-3 text-sm font-mono"
                  />
                  <select
                    value={maxObjectUnit}
                    onChange={(e) => setMaxObjectUnit(e.target.value as "MB" | "GB")}
                    className="h-10 rounded-md border border-border bg-bg px-2 text-sm"
                  >
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                  </select>
                </div>
                <p className="mt-1 text-xs text-muted">Current: {maxObject ? formatBytes(maxObject) : "1 GB"}</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Account quota</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="50000"
                    value={quotaVal}
                    onChange={(e) => setQuotaVal(Math.max(1, Number(e.target.value)))}
                    className="h-10 w-full rounded-md border border-border bg-bg px-3 text-sm font-mono"
                  />
                  <select
                    value={quotaUnit}
                    onChange={(e) => setQuotaUnit(e.target.value as "MB" | "GB" | "TB")}
                    className="h-10 rounded-md border border-border bg-bg px-2 text-sm"
                  >
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                    <option value="TB">TB</option>
                  </select>
                </div>
                <p className="mt-1 text-xs text-muted">Current: {quota ? formatBytes(quota) : "10 GB"}</p>
              </div>
            </div>

            <Button
              type="button"
              className="mt-4"
              disabled={savingLimits}
              onClick={async () => {
                const finalMax = maxObjectVal * (maxObjectUnit === "GB" ? 1024 * 1024 * 1024 : 1024 * 1024);
                const finalQuota = quotaVal * (quotaUnit === "TB" ? 1024 ** 4 : quotaUnit === "GB" ? 1024 * 1024 * 1024 : 1024 * 1024);
                if (finalQuota < finalMax) {
                  toast.error("Account quota must be at least the max upload size.");
                  return;
                }
                setSavingLimits(true);
                try {
                  const res = await updateStorageLimitsFn({ data: { maxObject: finalMax, quota: finalQuota } });
                  if (res.ok) {
                    setMaxObject(finalMax);
                    setQuota(finalQuota);
                    toast.success(`Storage limits saved: Max object ${formatBytes(finalMax)}, Quota ${formatBytes(finalQuota)}`);
                  } else {
                    toast.error(res.error || "Failed to update storage limits.");
                  }
                } catch {
                  toast.error("Failed to update storage limits.");
                } finally {
                  setSavingLimits(false);
                }
              }}
            >
              {savingLimits ? "Saving limits…" : "Save storage limits"}
            </Button>
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

          {/* Google Drive Cloud Integration */}
          <section className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-medium">Google Drive Integration</h2>
              </div>
              {driveCreds ? (
                <Pill tone="accent">Connected</Pill>
              ) : (
                <Pill tone="neutral">Not connected</Pill>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              Map Google Drive folders directly to S3 buckets. Store large datasets without database quota constraints.
            </p>

            {driveCreds ? (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-raised/40 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Account:</span>
                  <span className="font-mono font-medium">{driveCreds.email || "Google Account"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Authentication:</span>
                  <span className="capitalize">{driveCreds.authType === "service_account" ? "Service Account JSON" : "OAuth2"}</span>
                </div>
                {driveCreds.totalBytes ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Google Drive Storage:</span>
                    <span>
                      {formatBytes(driveCreds.usedBytes || 0)} used of {formatBytes(driveCreds.totalBytes)}
                    </span>
                  </div>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={testingDrive}
                    onClick={() => {
                      setTestingDrive(true);
                      void testDriveConnectionFn()
                        .then((res) => {
                          if (res.ok) {
                            toast.success(`Google Drive connected: ${res.email || "OK"}`);
                            void loadDrive();
                          } else {
                            toast.error(res.error || "Connection test failed");
                          }
                        })
                        .catch(() => toast.error("Connection test failed"))
                        .finally(() => setTestingDrive(false));
                    }}
                  >
                    {testingDrive ? "Testing…" : "Test connection"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void deleteDriveCredentialsFn().then(() => {
                        toast.success("Disconnected Google Drive");
                        void loadDrive();
                      });
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => setDriveModalOpen(true)}
              >
                Connect Google Drive
              </Button>
            )}
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

        {driveModalOpen && (
          <Modal title="Connect Google Drive" onClose={() => setDriveModalOpen(false)}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setSavingDrive(true);
                void saveDriveCredentialsFn({
                  data: {
                    authType: driveAuthType,
                    clientId: driveClientId,
                    clientSecret: driveClientSecret,
                    refreshToken: driveRefreshToken,
                    serviceAccountJson: driveServiceAccountJson,
                  },
                })
                  .then(() => {
                    toast.success("Google Drive credentials saved");
                    setDriveModalOpen(false);
                    void loadDrive();
                  })
                  .catch((err: unknown) => {
                    toast.error(err instanceof Error ? err.message : "Failed to save credentials");
                  })
                  .finally(() => setSavingDrive(false));
              }}
            >
              <Field label="Authentication Method">
                <select
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg"
                  value={driveAuthType}
                  onChange={(e) => setDriveAuthType(e.target.value as typeof driveAuthType)}
                >
                  <option value="oauth">Google OAuth2 (Client ID & Refresh Token)</option>
                  <option value="service_account">Google Service Account JSON Key</option>
                </select>
              </Field>

              {driveAuthType === "service_account" ? (
                <Field label="Service Account JSON Key">
                  <textarea
                    rows={6}
                    className="w-full rounded border border-border bg-bg p-2 font-mono text-xs text-fg"
                    placeholder={`{\n  "type": "service_account",\n  "client_email": "middleout@project.iam.gserviceaccount.com",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n..."\n}`}
                    value={driveServiceAccountJson}
                    onChange={(e) => setDriveServiceAccountJson(e.target.value)}
                    required
                  />
                  <span className="mt-1 block text-xs text-muted">
                    Paste the entire JSON key downloaded from Google Cloud IAM.
                  </span>
                </Field>
              ) : (
                <>
                  <Field label="OAuth Client ID">
                    <Input
                      value={driveClientId}
                      onChange={(e) => setDriveClientId(e.target.value)}
                      placeholder="xxxx.apps.googleusercontent.com"
                      required
                    />
                  </Field>
                  <Field label="OAuth Client Secret">
                    <Input
                      type="password"
                      value={driveClientSecret}
                      onChange={(e) => setDriveClientSecret(e.target.value)}
                      placeholder="Client secret"
                      required
                    />
                  </Field>
                  <Field label="OAuth Refresh Token">
                    <Input
                      type="password"
                      value={driveRefreshToken}
                      onChange={(e) => setDriveRefreshToken(e.target.value)}
                      placeholder="1//04xxxx..."
                      required
                    />
                  </Field>
                </>
              )}

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setDriveModalOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingDrive}>
                  {savingDrive ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </form>
          </Modal>
        )}
      </Shell>
    </Authed>
  );
}
