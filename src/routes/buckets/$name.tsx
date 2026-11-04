import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckSquare,
  Download,
  Folder,
  FolderPlus,
  Move,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, EmptyState, Field, Input, Modal, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  batchDeleteFn,
  browseFn,
  createLinkFn,
  moveObjectFn,
  objectDetailFn,
  removeObjectFn,
  setTagsFn,
} from "@/lib/storage/api";
import { absoluteUrl, withBase } from "@/lib/storage/paths";
import { encodeKeyPath, formatBytes, formatWhen, guessType, leafName } from "@/lib/storage/pure";
import { downloadObject, uploadFile } from "@/lib/storage/upload";

export const Route = createFileRoute("/buckets/$name")({
  validateSearch: (search: Record<string, unknown>) => ({
    prefix: typeof search.prefix === "string" ? search.prefix : "",
  }),
  component: BrowserPage,
});

type Browser = Extract<Awaited<ReturnType<typeof browseFn>>, { ok: true }>;
type Detail = Extract<Awaited<ReturnType<typeof objectDetailFn>>, { ok: true }>["object"];

function BrowserPage() {
  const { name } = Route.useParams();
  const { prefix } = Route.useSearch();
  const [prefixDraft, setPrefixDraft] = useState(prefix);
  useEffect(() => setPrefixDraft(prefix), [prefix]);
  const navigate = Route.useNavigate();
  const { user } = useCurrentUserState();
  const [data, setData] = useState<Browser | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [drag, setDrag] = useState(false);
  const [jobs, setJobs] = useState<{ name: string; ratio: number }[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [preview, setPreview] = useState<Detail | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");

  // Pagination state
  const [startAfter, setStartAfter] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Selection & Batch Delete
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  // Rename / Move
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSourceKey, setMoveSourceKey] = useState("");
  const [moveDestKey, setMoveDestKey] = useState("");

  // Share link duration selection
  const [shareDuration, setShareDuration] = useState(3600);

  const uploadController = useRef<AbortController | null>(null);
  const depth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load(cursor = startAfter) {
    const result = await browseFn({ data: { bucket: name, prefix, startAfter: cursor } });
    if (!result.ok) {
      setError(result.error);
      setData(null);
      return;
    }
    setError("");
    setData(result);
  }

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setStartAfter("");
    setCursorHistory([]);
    setSelectedKeys([]);
    browseFn({ data: { bucket: name, prefix, startAfter: "" } })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) setError(result.error);
        else {
          setError("");
          setData(result);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open the bucket.");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, name, prefix]);

  async function sendFiles(files: FileList | File[]) {
    if (uploadController.current) return;
    const list = [...files];
    if (list.length === 0) return;
    const controller = new AbortController();
    uploadController.current = controller;
    try {
      for (const file of list) {
        if (controller.signal.aborted) break;
        const key = `${prefix}${file.name}`;
        const existing = await objectDetailFn({ data: { bucket: name, key } });
        if (existing.ok && !window.confirm(`Replace ${file.name}?`)) continue;
        setJobs((current) => [...current, { name: file.name, ratio: 0 }]);
        const result = await uploadFile({
          bucket: name,
          key,
          file,
          signal: controller.signal,
          onProgress: (ratio) => {
            setJobs((current) =>
              current.map((job) => (job.name === file.name ? { ...job, ratio } : job)),
            );
          },
        });
        if (!result.ok) toast.error(`${file.name}: ${result.error}`);
      }
    } catch (error) {
      toast.error(
        controller.signal.aborted
          ? "Upload cancelled."
          : error instanceof Error
            ? error.message
            : "Upload failed.",
      );
    } finally {
      uploadController.current = null;
      setJobs([]);
    }
    await load(startAfter);
  }

  async function openPreview(key: string) {
    const detail = await objectDetailFn({ data: { bucket: name, key } });
    if (!detail.ok) {
      toast.error(detail.error);
      return;
    }
    setPreview(detail.object);
    setPreviewText("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    if (detail.object.size === 0) return;
    if (data?.bucket.isPublic) {
      setPreviewUrl(withBase(`/api/public/${encodeURIComponent(name)}/${encodeKeyPath(key)}`));
      return;
    }
    const blob = await downloadObject(detail.object.id, detail.object.partCount);
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    if (
      detail.object.contentType.startsWith("text/") ||
      detail.object.contentType.includes("json") ||
      detail.object.size < 100_000
    ) {
      if (
        detail.object.contentType.startsWith("text/") ||
        detail.object.contentType.includes("json") ||
        detail.object.contentType.includes("xml")
      ) {
        setPreviewText(await blob.text());
      }
    }
  }

  function handleNextPage() {
    if (!data?.nextStart) return;
    setCursorHistory((prev) => [...prev, startAfter]);
    setStartAfter(data.nextStart);
    void load(data.nextStart);
  }

  function handlePrevPage() {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1] ?? "";
    setCursorHistory((prev) => prev.slice(0, -1));
    setStartAfter(prevCursor);
    void load(prevCursor);
  }

  function toggleSelectAll() {
    if (selectedKeys.length === visibleObjects.length) {
      setSelectedKeys([]);
    } else {
      setSelectedKeys(visibleObjects.map((o) => o.key));
    }
  }

  function toggleSelectKey(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  async function handleBatchDelete() {
    if (selectedKeys.length === 0) return;
    const res = await batchDeleteFn({ data: { bucket: name, keys: selectedKeys } });
    setBatchDeleteOpen(false);
    if (res.ok) {
      toast.success(`Deleted ${res.deleted.length} object(s)`);
      setSelectedKeys([]);
      void load(startAfter);
    } else {
      toast.error("Failed to delete objects.");
    }
  }

  async function handleMoveSubmit(e: React.FormEvent) {
    e.preventDefault();
    const dest = moveDestKey.trim();
    if (!dest) {
      toast.error("Destination key is required");
      return;
    }
    const res = await moveObjectFn({
      data: { bucket: name, sourceKey: moveSourceKey, destKey: dest },
    });
    if (!res.ok) {
      toast.error(res.error);
    } else {
      toast.success("Object moved/renamed successfully");
      setMoveOpen(false);
      setPreview(null);
      void load(startAfter);
    }
  }

  const crumbs = prefix.split("/").filter(Boolean);
  const query = filter.trim().toLowerCase();
  const folders = (data?.folders ?? []).filter((item) =>
    leafName(item, prefix).toLowerCase().includes(query),
  );
  const visibleObjects = (data?.objects ?? []).filter((item) =>
    leafName(item.key, prefix).toLowerCase().includes(query),
  );

  return (
    <Authed>
      <Shell>
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            depth.current += 1;
            setDrag(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDrag(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            depth.current = 0;
            setDrag(false);
            if (event.dataTransfer.files.length) void sendFiles(event.dataTransfer.files);
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">
                <Link to="/buckets" className="hover:text-fg">
                  Buckets
                </Link>
              </p>
              <h1 className="mt-1 truncate font-mono text-2xl font-semibold">{name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                <button
                  type="button"
                  className="hover:text-fg"
                  onClick={() => navigate({ search: { prefix: "" } })}
                >
                  root
                </button>
                {crumbs.map((crumb, index) => {
                  const next = `${crumbs.slice(0, index + 1).join("/")}/`;
                  return (
                    <span key={next} className="flex items-center gap-2">
                      <span>/</span>
                      <button
                        type="button"
                        className="hover:text-fg"
                        onClick={() => navigate({ search: { prefix: next } })}
                      >
                        {crumb}
                      </button>
                    </span>
                  );
                })}
                {data ? (
                  <Pill tone={data.bucket.isPublic ? "accent" : "neutral"}>
                    {data.bucket.isPublic ? "Public" : "Private"}
                  </Pill>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setFolderOpen(true)}>
                <FolderPlus className="h-4 w-4" />
                New folder
              </Button>
              <Button type="button" onClick={() => fileRef.current?.click()}>
                Upload
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void sendFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          {data?.bucket.isPublic ? (
            <p className="mt-3 text-sm text-muted">
              Public page:{" "}
              <a className="text-primary" href={withBase(`/p/${encodeURIComponent(name)}`)}>
                /p/{name}
              </a>
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="min-w-[16rem] flex-1">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter this folder"
              />
            </div>
            {selectedKeys.length > 0 ? (
              <Button type="button" variant="danger" onClick={() => setBatchDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />
                Delete selected ({selectedKeys.length})
              </Button>
            ) : null}
          </div>
          {drag ? (
            <div className="mt-4 rounded-lg border border-primary bg-raised px-4 py-8 text-center text-sm">
              Drop files to upload into this folder
            </div>
          ) : null}
          <form className="mt-4 flex gap-2" onSubmit={event => {event.preventDefault(); void navigate({search:{prefix:prefixDraft}});}}>
            <label className="flex-1">Object key prefix<input className="ml-2 rounded border border-border bg-bg p-2" value={prefixDraft} onChange={event=>setPrefixDraft(event.target.value)} maxLength={1024} /></label>
            <button type="submit">Browse prefix</button>
          </form>
          {jobs.length > 0 && (
            <button
              className="mt-3 text-sm underline"
              onClick={() => uploadController.current?.abort()}
            >
              Cancel uploads
            </button>
          )}
          {jobs.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-2">
              {jobs.map((job) => (
                <li key={job.name} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="truncate">{job.name}</span>
                    <span className="text-muted">{Math.round(job.ratio * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${Math.round(job.ratio * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="mt-6 text-sm text-danger">{error}</p> : null}
          {!error && !data ? <p className="mt-6 text-sm text-muted">Loading objects…</p> : null}
          {data && folders.length === 0 && visibleObjects.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                title="This folder is empty"
                body="Drop files here, or upload from the button above. Folders are just prefixes."
              />
            </div>
          ) : null}
          {data && (folders.length > 0 || visibleObjects.length > 0) ? (
            <div className="mt-4 overflow-hidden rounded-lg border border-border">
              {visibleObjects.length > 0 ? (
                <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-xs font-medium text-muted">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center gap-2 hover:text-fg"
                    aria-label="Select all"
                  >
                    {selectedKeys.length > 0 && selectedKeys.length === visibleObjects.length ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    <span>Select all</span>
                  </button>
                  <span className="ml-auto">{visibleObjects.length} objects</span>
                </div>
              ) : null}
              <ul>
                {folders.map((folder) => (
                  <li key={folder} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      className="flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-surface"
                      onClick={() => navigate({ search: { prefix: folder } })}
                    >
                      <Folder className="h-4 w-4 text-primary" />
                      <span className="truncate text-sm">{leafName(folder, prefix)}</span>
                    </button>
                  </li>
                ))}
                {visibleObjects.map((object) => (
                  <li
                    key={object.id}
                    className="flex items-center gap-2 border-b border-border px-3 last:border-b-0 hover:bg-surface"
                  >
                    <button
                      type="button"
                      aria-label="Select"
                      className="text-muted hover:text-fg"
                      onClick={() => toggleSelectKey(object.key)}
                    >
                      {selectedKeys.includes(object.key) ? (
                        <CheckSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left"
                      onClick={() => void openPreview(object.key)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {leafName(object.key, prefix)}
                        </span>
                        <span className="text-xs text-muted">
                          {formatBytes(object.size)} · {formatWhen(object.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename / move ${leafName(object.key, prefix)}`}
                      title="Rename or move"
                      className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
                      onClick={() => {
                        setMoveSourceKey(object.key);
                        setMoveDestKey(object.key);
                        setMoveOpen(true);
                      }}
                    >
                      <Move className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Download ${leafName(object.key, prefix)}`}
                      className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
                      onClick={() => void downloadKey(name, object.key, data.bucket.isPublic)}
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${leafName(object.key, prefix)}`}
                      className="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-danger"
                      onClick={() => {
                        void removeObjectFn({ data: { bucket: name, key: object.key } }).then(
                          (result) => {
                            if (!result.ok) toast.error(result.error);
                            else void load(startAfter);
                          },
                        );
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Pagination Controls */}
          {data && (data.truncated || cursorHistory.length > 0) ? (
            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
              <Button
                type="button"
                variant="outline"
                disabled={cursorHistory.length === 0}
                onClick={handlePrevPage}
              >
                Previous page
              </Button>
              <span className="text-xs text-muted">Page {cursorHistory.length + 1}</span>
              <Button
                type="button"
                variant="outline"
                disabled={!data.truncated}
                onClick={handleNextPage}
              >
                Next page
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </div>

        {folderOpen ? (
          <Modal title="New folder" onClose={() => setFolderOpen(false)}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const clean = folderName.trim().replace(/\/+$/, "");
                if (!clean || clean.includes("/")) {
                  toast.error("Use a single folder name.");
                  return;
                }
                const key = `${prefix}${clean}/`;
                void uploadFile({
                  bucket: name,
                  key,
                  file: new Blob([]),
                  contentType: "application/x-directory",
                }).then((result) => {
                  if (!result.ok) toast.error(result.error);
                  else {
                    setFolderOpen(false);
                    setFolderName("");
                    void load(startAfter);
                  }
                });
              }}
            >
              <Field label="Name">
                <Input
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  autoFocus
                />
              </Field>
              <Button type="submit">Create folder</Button>
            </form>
          </Modal>
        ) : null}

        {/* Batch Delete Confirmation Modal */}
        {batchDeleteOpen ? (
          <Modal
            title={`Delete ${selectedKeys.length} objects`}
            onClose={() => setBatchDeleteOpen(false)}
          >
            <p className="text-sm text-muted">
              Are you sure you want to permanently delete these {selectedKeys.length} objects from{" "}
              <span className="font-mono text-fg">{name}</span>? This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setBatchDeleteOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="danger" onClick={() => void handleBatchDelete()}>
                Delete {selectedKeys.length} objects
              </Button>
            </div>
          </Modal>
        ) : null}

        {/* Move / Rename Modal */}
        {moveOpen ? (
          <Modal title="Move or rename object" onClose={() => setMoveOpen(false)}>
            <form onSubmit={handleMoveSubmit} className="flex flex-col gap-4">
              <Field label="Current key">
                <Input value={moveSourceKey} disabled />
              </Field>
              <Field label="New key name or path">
                <Input
                  value={moveDestKey}
                  onChange={(e) => setMoveDestKey(e.target.value)}
                  autoFocus
                />
              </Field>
              <div className="mt-2 flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setMoveOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit">Move / Rename</Button>
              </div>
            </form>
          </Modal>
        ) : null}

        {preview ? (
          <Modal
            title={leafName(preview.key, prefix) || preview.key}
            onClose={() => {
              setPreview(null);
              if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
              setPreviewUrl("");
            }}
          >
            <p className="font-mono text-xs text-muted">{preview.key}</p>
            <p className="mt-1 text-xs text-muted">
              {formatBytes(preview.size)} · {preview.contentType || guessType(preview.key)} ·{" "}
              {preview.etag.slice(0, 12)}
            </p>
            <div className="mt-4">
              <PreviewBody object={preview} url={previewUrl} text={previewText} />
            </div>
            {preview.tags.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {preview.tags.map((tag) => (
                  <li key={tag.key} className="rounded-md bg-raised px-2 py-1 text-xs">
                    {tag.key}: {tag.value}
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                const tags = [
                  ...preview.tags.filter((tag) => tag.key !== tagKey),
                  { key: tagKey.trim(), value: tagValue },
                ];
                void setTagsFn({ data: { bucket: name, key: preview.key, tags } }).then(
                  (result) => {
                    if (!result.ok) toast.error(result.error);
                    else {
                      setTagKey("");
                      setTagValue("");
                      void openPreview(preview.key);
                    }
                  },
                );
              }}
            >
              <Input
                value={tagKey}
                onChange={(event) => setTagKey(event.target.value)}
                placeholder="Tag"
              />
              <Input
                value={tagValue}
                onChange={(event) => setTagValue(event.target.value)}
                placeholder="Value"
              />
              <Button type="submit" variant="outline">
                Tag
              </Button>
            </form>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => void downloadKey(name, preview.key, Boolean(data?.bucket.isPublic))}
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setMoveSourceKey(preview.key);
                  setMoveDestKey(preview.key);
                  setMoveOpen(true);
                }}
              >
                <Move className="h-4 w-4" />
                Rename / Move
              </Button>
            </div>
            <div className="mt-4 rounded-md border border-border bg-surface p-3">
              <p className="text-xs font-medium">Create share link</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={shareDuration}
                  onChange={(e) => setShareDuration(Number(e.target.value))}
                  className="h-9 rounded-md border border-border bg-bg px-2 text-xs"
                >
                  <option value={3600}>1 hour</option>
                  <option value={86400}>24 hours</option>
                  <option value={604800}>7 days</option>
                  <option value={2592000}>30 days</option>
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void createLinkFn({
                      data: { bucket: name, key: preview.key, seconds: shareDuration },
                    }).then((result) => {
                      if (!result.ok) toast.error(result.error);
                      else {
                        void navigator.clipboard.writeText(
                          absoluteUrl(`/api/share/${result.token}`),
                        );
                        toast.success("Share link copied to clipboard");
                      }
                    });
                  }}
                >
                  Copy share link
                </Button>
              </div>
            </div>
          </Modal>
        ) : null}
      </Shell>
    </Authed>
  );
}

async function downloadKey(bucket: string, key: string, isPublic: boolean) {
  if (isPublic) {
    const anchor = document.createElement("a");
    anchor.href = withBase(`/api/public/${encodeURIComponent(bucket)}/${encodeKeyPath(key)}`);
    anchor.download = leafName(key, "");
    anchor.click();
    return;
  }
  const detail = await objectDetailFn({ data: { bucket, key } });
  if (!detail.ok) {
    toast.error(detail.error);
    return;
  }
  const blob = await downloadObject(detail.object.id, detail.object.partCount);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = leafName(key, "");
  anchor.click();
  URL.revokeObjectURL(url);
}

function PreviewBody({ object, url, text }: { object: Detail; url: string; text: string }) {
  if (!url && object.size > 0) return <p className="text-sm text-muted">Preparing preview…</p>;
  const type = object.contentType || guessType(object.key);
  if (object.size === 0) return <p className="text-sm text-muted">Empty object.</p>;
  if (type.startsWith("image/"))
    return <img src={url} alt="" className="max-h-96 w-full rounded-md object-contain" />;
  if (type.startsWith("video/")) return <video src={url} controls className="w-full rounded-md" />;
  if (type.startsWith("audio/")) return <audio src={url} controls className="w-full" />;
  if (type === "application/pdf")
    return (
      <iframe
        sandbox=""
        title={object.key}
        src={url}
        className="h-96 w-full rounded-md border border-border"
      />
    );
  if (text)
    return (
      <pre className="max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-xs">{text}</pre>
    );
  return (
    <p className="text-sm text-muted">No inline preview for this file. Download it instead.</p>
  );
}
