import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, Field, Input, Modal, Pill } from "./ui";
import {
  getLifecycleFn,
  previewLifecycleFn,
  runLifecycleNowFn,
  saveLifecycleFn,
} from "@/lib/storage/api";
import { validateLifecycleRules, type LifecycleRule } from "@/lib/storage/lifecycle";
import { formatBytes, formatWhen } from "@/lib/storage/pure";

type State = Awaited<ReturnType<typeof getLifecycleFn>>;
type Preview = Awaited<ReturnType<typeof previewLifecycleFn>>;
type Form = {
  originalId?: string;
  id: string;
  status: "Enabled" | "Disabled";
  prefix: string;
  tags: { key: string; value: string }[];
  expiration: "none" | "days" | "date";
  days: string;
  date: string;
  abortDays: string;
  minSize: string;
  maxSize: string;
};
type Pending = { rules: LifecycleRule[]; revision: string | null; mode: "save" | "run" };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to update lifecycle rules.";

export function LifecyclePanel({
  bucket,
  provider,
  onCleanup,
}: {
  bucket: string;
  provider: string;
  onCleanup: () => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const previewRequest = useRef(0);
  const invalidatePreview = useCallback(() => {
    previewRequest.current++;
  }, []);
  const reload = useCallback(async () => {
    const next = await getLifecycleFn({ data: { bucket } });
    setState(next);
    setError("");
  }, [bucket]);
  useEffect(() => {
    let active = true;
    if (provider === "local") {
      void getLifecycleFn({ data: { bucket } })
        .then((next) => {
          if (active) setState(next);
        })
        .catch((cause) => {
          if (active) setError(message(cause));
        });
    }
    return () => {
      active = false;
      invalidatePreview();
    };
  }, [bucket, provider, invalidatePreview]);

  if (provider !== "local")
    return (
      <EmptyState
        title="Lifecycle is managed by the storage provider"
        body="Middle Out lifecycle rules apply to local buckets. Mounted Google Drive folders are never deleted by this scheduler."
      />
    );

  async function persist(rules: LifecycleRule[], revision: string | null) {
    setBusy(true);
    setError("");
    try {
      await saveLifecycleFn({ data: { bucket, rules, revision } });
      await reload();
      setForm(null);
      setPending(null);
      toast.success("Lifecycle rules saved");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  function review(rules: LifecycleRule[], mode: Pending["mode"]) {
    if (!state) return;
    previewRequest.current++;
    setPending({ rules, revision: state.revision, mode });
    setPreview(null);
    setAcknowledged(false);
    setError("");
  }
  async function previewChanges() {
    if (!pending) return;
    const requestId = ++previewRequest.current;
    setBusy(true);
    try {
      const result = await previewLifecycleFn({ data: { bucket, rules: pending.rules } });
      if (requestId === previewRequest.current) setPreview(result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!pending || !preview || !acknowledged) return;
    if (pending.mode === "save") return persist(pending.rules, pending.revision);
    setBusy(true);
    try {
      const result = await runLifecycleNowFn({ data: { bucket, revision: pending.revision } });
      await reload();
      onCleanup();
      setPending(null);
      toast.success(
        `Expired ${result.expiredObjects} files and aborted ${result.abortedUploads} uploads.${result.morePending ? " More will be processed by the next pass." : ""}`,
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  function edit(rule?: LifecycleRule) {
    setError("");
    setForm({
      originalId: rule?.id,
      id: rule?.id || "",
      status: rule?.status || "Enabled",
      prefix: rule?.prefix || "",
      tags: rule?.tags.map((tag) => ({ ...tag })) || [],
      expiration: rule?.expirationDate
        ? "date"
        : rule?.expirationDays !== undefined || !rule
          ? "days"
          : "none",
      days: String(rule?.expirationDays ?? 30),
      date: rule?.expirationDate?.slice(0, 10) || "",
      abortDays: rule?.abortDays === undefined ? "" : String(rule.abortDays),
      minSize: rule?.sizeGreaterThan === undefined ? "" : String(rule.sizeGreaterThan),
      maxSize: rule?.sizeLessThan === undefined ? "" : String(rule.sizeLessThan),
    });
  }
  function submitRule() {
    if (!form || !state) return;
    try {
      const rule = validateLifecycleRules([
        {
          id: form.id,
          status: form.status,
          prefix: form.prefix,
          tags: form.tags,
          ...(form.expiration === "days" && { expirationDays: Number(form.days) }),
          ...(form.expiration === "date" && { expirationDate: `${form.date}T00:00:00.000Z` }),
          ...(form.abortDays !== "" && { abortDays: Number(form.abortDays) }),
          ...(form.minSize !== "" && { sizeGreaterThan: Number(form.minSize) }),
          ...(form.maxSize !== "" && { sizeLessThan: Number(form.maxSize) }),
        },
      ])[0];
      const rules = form.originalId
        ? state.rules.map((item) => (item.id === form.originalId ? rule : item))
        : [...state.rules, rule];
      validateLifecycleRules(rules);
      review(rules, "save");
    } catch (cause) {
      setError(message(cause));
    }
  }

  return (
    <section
      className="mt-4 max-w-5xl rounded-lg border border-border bg-surface p-5"
      aria-label="Bucket lifecycle"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Clock className="h-4 w-4" />
            Lifecycle rules
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Automatically remove old files and unfinished multipart uploads. Rules apply to existing
            and future files. Deletions are permanent.
          </p>
          <p className="mt-2 text-xs text-muted">
            {state ? `Automatic cleanup checks every ${state.intervalSeconds / 60} minutes. ` : ""}
            Age-based expiry rounds up to midnight UTC. Files remain readable until cleanup deletes
            them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void reload().catch((cause) => setError(message(cause)))}
            aria-label="Refresh lifecycle rules"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            disabled={busy || !state?.rules.some((rule) => rule.status === "Enabled")}
            onClick={() => state && review(state.rules, "run")}
          >
            Run cleanup
          </Button>
          <Button disabled={busy || !state || state.rules.length >= 1000} onClick={() => edit()}>
            <Plus className="h-4 w-4" />
            Create rule
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void reload().catch((cause) => setError(message(cause)))}
          >
            Reload rules
          </button>
        </p>
      )}
      {state?.lastError && (
        <p role="alert" className="mt-4 text-sm text-danger">
          Last cleanup failed: {state.lastError}
        </p>
      )}
      {!state ? (
        <p className="mt-4 text-sm text-muted">
          {error ? "Lifecycle rules could not be loaded." : "Loading lifecycle rules…"}
        </p>
      ) : (
        <>
          <div className="my-5 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted">Last checked</span>
              <p>{state.lastEvaluatedAt ? formatWhen(state.lastEvaluatedAt) : "Not checked yet"}</p>
            </div>
            <div>
              <span className="text-muted">Files expired</span>
              <p>
                {state.expiredObjects} · {formatBytes(state.expiredBytes)} removed from quota
              </p>
            </div>
            <div>
              <span className="text-muted">Uploads aborted</span>
              <p>{state.abortedUploads}</p>
            </div>
          </div>
          {!state.rules.length ? (
            <EmptyState
              title="No lifecycle rules"
              body="Keep logs, temporary artifacts, and old exports only as long as you need them."
            />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {state.rules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-all font-medium">{rule.id}</h3>
                      <Pill tone={rule.status === "Enabled" ? "accent" : "neutral"}>
                        {rule.status}
                      </Pill>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted">
                      {rule.prefix ? `Prefix: ${rule.prefix}` : "All files"}
                      {rule.tags.length
                        ? ` · Tags: ${rule.tags.map((tag) => `${tag.key}=${tag.value}`).join(", ")}`
                        : ""}
                      {rule.sizeGreaterThan !== undefined
                        ? ` · Larger than ${rule.sizeGreaterThan} bytes`
                        : ""}
                      {rule.sizeLessThan !== undefined
                        ? ` · Smaller than ${rule.sizeLessThan} bytes`
                        : ""}
                    </p>
                    <p className="mt-2 text-sm">
                      {rule.expirationDays !== undefined
                        ? `Expire files after ${rule.expirationDays} days`
                        : rule.expirationDate
                          ? `Expire files on ${rule.expirationDate.slice(0, 10)} (UTC)`
                          : ""}
                      {rule.abortDays !== undefined
                        ? `${rule.expirationDays !== undefined || rule.expirationDate ? " · " : ""}Abort unfinished uploads after ${rule.abortDays} days`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={busy} onClick={() => edit(rule)}>
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const rules = state.rules.map((item) =>
                          item.id === rule.id
                            ? {
                                ...item,
                                status:
                                  rule.status === "Enabled"
                                    ? ("Disabled" as const)
                                    : ("Enabled" as const),
                              }
                            : item,
                        );
                        if (rule.status === "Disabled") review(rules, "save");
                        else void persist(rules, state.revision);
                      }}
                    >
                      {rule.status === "Enabled" ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Delete rule ${rule.id}`}
                      onClick={() =>
                        void persist(
                          state.rules.filter((item) => item.id !== rule.id),
                          state.revision,
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {form && !pending && (
        <Modal
          title={form.originalId ? "Edit lifecycle rule" : "Create lifecycle rule"}
          onClose={() => {
            if (!busy) {
              setForm(null);
              setError("");
            }
          }}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitRule();
            }}
          >
            <Field label="Rule name">
              <Input
                autoFocus
                required
                maxLength={255}
                value={form.id}
                onChange={(event) => setForm({ ...form, id: event.target.value })}
              />
            </Field>
            <Field label="File prefix (leave empty for all files)">
              <Input
                value={form.prefix}
                placeholder="logs/"
                onChange={(event) => setForm({ ...form, prefix: event.target.value })}
              />
            </Field>
            <Field label="Rule status">
              <select
                className="h-11 w-full rounded-md border border-border bg-bg px-3"
                aria-label="Rule status"
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as Form["status"] })
                }
              >
                <option>Enabled</option>
                <option>Disabled</option>
              </select>
            </Field>
            <Field label="Expire files">
              <select
                className="h-11 w-full rounded-md border border-border bg-bg px-3"
                aria-label="Expire files"
                value={form.expiration}
                onChange={(event) =>
                  setForm({ ...form, expiration: event.target.value as Form["expiration"] })
                }
              >
                <option value="none">Do not expire files</option>
                <option value="days">After a number of days</option>
                <option value="date">On a date (midnight UTC)</option>
              </select>
            </Field>
            {form.expiration === "days" && (
              <Field label="Expire after days">
                <Input
                  type="number"
                  min={1}
                  max={365000}
                  required
                  value={form.days}
                  onChange={(event) => setForm({ ...form, days: event.target.value })}
                />
              </Field>
            )}
            {form.expiration === "date" && (
              <Field label="Expiration date (UTC)">
                <Input
                  type="date"
                  required
                  value={form.date}
                  onChange={(event) => setForm({ ...form, date: event.target.value })}
                />
              </Field>
            )}
            <Field label="Abort unfinished uploads after days (optional)">
              <Input
                type="number"
                min={1}
                max={365000}
                value={form.abortDays}
                onChange={(event) => setForm({ ...form, abortDays: event.target.value })}
              />
            </Field>
            <details>
              <summary className="cursor-pointer text-sm text-muted">Tag and size filters</summary>
              <div className="mt-3 grid gap-3">
                <p className="text-xs text-muted">
                  All filters must match. Size bounds are exclusive. Use a separate prefix-only rule
                  to abort unfinished uploads.
                </p>
                <Field label="File size greater than bytes (optional)">
                  <Input
                    type="number"
                    min={0}
                    value={form.minSize}
                    onChange={(event) => setForm({ ...form, minSize: event.target.value })}
                  />
                </Field>
                <Field label="File size less than bytes (optional)">
                  <Input
                    type="number"
                    min={1}
                    value={form.maxSize}
                    onChange={(event) => setForm({ ...form, maxSize: event.target.value })}
                  />
                </Field>
                {form.tags.map((tag, index) => (
                  <div className="flex gap-2" key={index}>
                    <Input
                      aria-label={`Tag ${index + 1} key`}
                      placeholder="Tag key"
                      required
                      value={tag.key}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          tags: form.tags.map((item, i) =>
                            i === index ? { ...item, key: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Input
                      aria-label={`Tag ${index + 1} value`}
                      placeholder="Tag value"
                      value={tag.value}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          tags: form.tags.map((item, i) =>
                            i === index ? { ...item, value: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove tag ${index + 1}`}
                      onClick={() =>
                        setForm({ ...form, tags: form.tags.filter((_, i) => i !== index) })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  disabled={form.tags.length >= 10}
                  onClick={() => setForm({ ...form, tags: [...form.tags, { key: "", value: "" }] })}
                >
                  Add tag filter
                </Button>
              </div>
            </details>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              Review rule
            </Button>
          </form>
        </Modal>
      )}
      {pending && (
        <Modal
          title={pending.mode === "save" ? "Review lifecycle changes" : "Review cleanup"}
          onClose={() => {
            if (!busy) {
              previewRequest.current++;
              setPending(null);
              setError("");
            }
          }}
        >
          <div className="grid gap-4 text-sm">
            <p>
              Preview the files and unfinished uploads eligible for permanent deletion now. Rules
              also apply to future files. Previewing changes nothing.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void previewChanges()}>
              {busy ? "Working…" : "Preview affected files"}
            </Button>
            {preview && (
              <div aria-live="polite" className="rounded-md border border-border bg-bg p-3">
                <p>
                  <strong>{preview.objectCount} files</strong> ({formatBytes(preview.objectBytes)})
                  and <strong>{preview.uploadCount} unfinished uploads</strong> (
                  {formatBytes(preview.uploadBytes)}) eligible now.
                </p>
                <p className="mt-1 text-xs text-muted">
                  As of {formatWhen(preview.asOf)}. Files and eligibility may change before cleanup
                  runs.
                </p>
                {preview.sample.length > 0 && (
                  <>
                    <p className="mt-3 text-xs text-muted">Sample of up to 20 affected files:</p>
                    <ul className="mt-1 max-h-40 overflow-auto font-mono text-xs">
                      {preview.sample.map((item) => (
                        <li key={item.key} className="break-all">
                          {item.key}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I understand that matching files and unfinished uploads will be permanently deleted.
              </span>
            </label>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <Button
              variant={pending.mode === "run" ? "danger" : "primary"}
              disabled={busy || !preview || !acknowledged}
              onClick={() => void confirm()}
            >
              {pending.mode === "run" ? "Run cleanup now" : "Save lifecycle rules"}
            </Button>
            <p className="text-xs text-muted">
              {pending.mode === "save"
                ? "Saving schedules the rules; it does not immediately delete files."
                : "Each pass processes up to 200 files and 200 unfinished uploads. Additional eligible items are handled by later passes."}
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
}
