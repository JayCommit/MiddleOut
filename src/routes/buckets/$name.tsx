import { Link, createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckSquare,
  Clock,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  Info,
  Lock,
  Move,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LifecyclePanel } from "@/components/lifecycle-panel";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, EmptyState, Field, Input, Modal, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  batchDeleteFn,
  browseFn,
  createLinkFn,
  getBucketAclFn,
  getBucketCorsFn,
  moveObjectFn,
  objectDetailFn,
  removeObjectFn,
  setBucketAclFn,
  setBucketCorsFn,
  setObjectAclFn,
  setTagsFn,
} from "@/lib/storage/api";
import { absoluteUrl, s3Endpoint, withBase } from "@/lib/storage/paths";
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

  // AWS S3 Console Tabs
  const [activeTab, setActiveTab] = useState<
    "objects" | "properties" | "permissions" | "lifecycle"
  >("objects");

  // ACL & Permissions State
  const [editAclOpen, setEditAclOpen] = useState(false);
  const [selectedAcl, setSelectedAcl] = useState<string>("private");
  const [aclAcknowledge, setAclAcknowledge] = useState(false);
  const [savingAcl, setSavingAcl] = useState(false);
  const [blockPublicAccessOpen, setBlockPublicAccessOpen] = useState(false);

  // CORS State
  const [corsOpen, setCorsOpen] = useState(false);
  const [corsDraft, setCorsDraft] = useState("");
  const [savingCors, setSavingCors] = useState(false);

  // Object ACL State
  const [objAclDraft, setObjAclDraft] = useState<string>("private");
  const [savingObjAcl, setSavingObjAcl] = useState(false);

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
    if (result.bucket?.acl) {
      setSelectedAcl(result.bucket.acl);
    }
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
          if (result.bucket?.acl) {
            setSelectedAcl(result.bucket.acl);
          }
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
    setObjAclDraft(detail.object.acl || "private");
    setPreviewText("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    if (detail.object.size === 0) return;
    const type = (detail.object.contentType || guessType(detail.object.key))
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const isSafeMedia =
      SAFE_IMAGE_TYPES.has(type) || type.startsWith("video/") || type.startsWith("audio/");
    if ((data?.bucket.isPublic || detail.object.acl === "public-read") && isSafeMedia) {
      setPreviewUrl(withBase(`/api/public/${encodeURIComponent(name)}/${encodeKeyPath(key)}`));
      return;
    }
    const blob = await downloadObject(detail.object.id, detail.object.partCount, type);
    if (isSafeMedia) {
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    }
    if (
      detail.object.size < 100_000 &&
      (type.startsWith("text/") || type.includes("json") || type.includes("xml"))
    ) {
      setPreviewText(await blob.text());
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

  async function handleSaveAcl() {
    if ((selectedAcl === "public-read" || selectedAcl === "public-read-write") && !aclAcknowledge && !data?.bucket.isPublic) {
      toast.error("Please acknowledge the public access warning.");
      return;
    }
    setSavingAcl(true);
    try {
      const res = await setBucketAclFn({ data: { name, acl: selectedAcl } });
      if (res.ok) {
        toast.success(`Bucket ACL updated to "${selectedAcl}"`);
        setEditAclOpen(false);
        void load(startAfter);
      } else {
        toast.error(res.error || "Failed to update ACL");
      }
    } catch {
      toast.error("Failed to update ACL");
    } finally {
      setSavingAcl(false);
    }
  }

  async function handleToggleBlockPublicAccess() {
    const isCurrentlyPublic = Boolean(data?.bucket.isPublic);
    const targetAcl = isCurrentlyPublic ? "private" : "public-read";
    setSavingAcl(true);
    try {
      const res = await setBucketAclFn({ data: { name, acl: targetAcl } });
      if (res.ok) {
        toast.success(
          isCurrentlyPublic
            ? "Block all public access is now ON (Bucket is private)"
            : "Block public access is now OFF (Bucket is public-read)",
        );
        setBlockPublicAccessOpen(false);
        void load(startAfter);
      } else {
        toast.error(res.error || "Failed to update access settings");
      }
    } catch {
      toast.error("Failed to update access settings");
    } finally {
      setSavingAcl(false);
    }
  }

  async function handleSaveObjectAcl() {
    if (!preview) return;
    setSavingObjAcl(true);
    try {
      const res = await setObjectAclFn({
        data: { bucket: name, key: preview.key, acl: objAclDraft },
      });
      if (res.ok) {
        toast.success(`Object ACL updated to "${objAclDraft}"`);
        setPreview({ ...preview, acl: objAclDraft });
        void load(startAfter);
      } else {
        toast.error(res.error || "Failed to update object ACL");
      }
    } catch {
      toast.error("Failed to update object ACL");
    } finally {
      setSavingObjAcl(false);
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

  const isPublic = Boolean(data?.bucket.isPublic);
  const bucketAcl = data?.bucket.acl || (isPublic ? "public-read" : "private");

  return (
    <Authed>
      <Shell>
        {/* Amazon S3 Console Navigation & Header */}
        <div className="flex flex-col gap-4">
          <nav className="flex items-center gap-2 text-xs text-muted">
            <Link to="/buckets" className="hover:text-fg font-medium">
              Amazon S3
            </Link>
            <span>&gt;</span>
            <Link to="/buckets" className="hover:text-fg font-medium">
              Buckets
            </Link>
            <span>&gt;</span>
            <span className="font-mono text-fg font-semibold">{name}</span>
          </nav>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="truncate font-mono text-2xl font-bold tracking-tight">{name}</h1>
                <Pill tone={isPublic ? "accent" : "neutral"}>
                  {bucketAcl === "public-read-write"
                    ? "Public (Read & Write)"
                    : isPublic
                      ? "Public (Read only)"
                      : "Bucket and objects not public"}
                </Pill>
                {data?.bucket.provider === "gdrive" && (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/30">
                    <Cloud className="h-3 w-3" />
                    Google Drive{" "}
                    {data.bucket.providerConfig?.mountMode === "ro" ? "(Read-Only)" : "(Mounted)"}
                  </span>
                )}
                {data?.bucket.isScratch && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/30">
                    Ephemeral Scratch{" "}
                    {data.bucket.expiresAt ? `(Expires ${formatWhen(data.bucket.expiresAt)})` : ""}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="flex items-center gap-1 font-mono">
                  <Globe className="h-3.5 w-3.5" />
                  {data?.bucket.region || "us-east-1"}
                </span>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(`s3://${name}`);
                    toast.success(`Copied: s3://${name}`);
                  }}
                  className="flex items-center gap-1 font-mono hover:text-fg"
                  title="Copy S3 URI"
                >
                  <Copy className="h-3 w-3" />
                  s3://{name}
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(`arn:aws:s3:::${name}`);
                    toast.success(`Copied: arn:aws:s3:::${name}`);
                  }}
                  className="flex items-center gap-1 font-mono hover:text-fg"
                  title="Copy ARN"
                >
                  <Copy className="h-3 w-3" />
                  arn:aws:s3:::{name}
                </button>
                {isPublic && (
                  <>
                    <span>·</span>
                    <a
                      href={withBase(`/p/${encodeURIComponent(name)}`)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline font-medium"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Public webpage
                    </a>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(s3Endpoint());
                  toast.success("S3 Endpoint copied");
                }}
              >
                Copy endpoint
              </Button>
              {activeTab === "objects" && (
                <>
                  <Button type="button" variant="outline" onClick={() => setFolderOpen(true)}>
                    <FolderPlus className="h-4 w-4" />
                    Create folder
                  </Button>
                  <Button type="button" onClick={() => fileRef.current?.click()}>
                    <Upload className="h-4 w-4" />
                    Upload
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* S3 Tabs */}
          <div className="mt-2 flex overflow-x-auto border-b border-border">
            <button
              type="button"
              onClick={() => setActiveTab("objects")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "objects"
                  ? "border-primary text-fg font-semibold"
                  : "border-transparent text-muted hover:text-fg hover:border-border"
              }`}
            >
              <FileText className="h-4 w-4" />
              Objects
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("properties")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "properties"
                  ? "border-primary text-fg font-semibold"
                  : "border-transparent text-muted hover:text-fg hover:border-border"
              }`}
            >
              <Sliders className="h-4 w-4" />
              Properties
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("permissions")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "permissions"
                  ? "border-primary text-fg font-semibold"
                  : "border-transparent text-muted hover:text-fg hover:border-border"
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              Permissions (ACL)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("lifecycle")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === "lifecycle" ? "border-primary text-fg" : "border-transparent text-muted hover:text-fg hover:border-border"}`}
            >
              <Clock className="h-4 w-4" />
              Lifecycle
            </button>
          </div>
        </div>

        {activeTab === "lifecycle" && data && (
          <LifecyclePanel
            key={name}
            bucket={name}
            provider={data.bucket.provider}
            onCleanup={() => {
              void load();
            }}
          />
        )}

        {/* TAB 1: OBJECTS */}
        {activeTab === "objects" && (
          <div
            className="mt-4"
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

            {/* Folder Navigation Breadcrumbs */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-fg">Prefix:</span>
                <button
                  type="button"
                  className="font-mono hover:text-fg"
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
                        className="font-mono hover:text-fg"
                        onClick={() => navigate({ search: { prefix: next } })}
                      >
                        {crumb}
                      </button>
                    </span>
                  );
                })}
              </div>

              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void navigate({ search: { prefix: prefixDraft } });
                }}
              >
                <div className="relative flex items-center">
                  <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={prefixDraft}
                    onChange={(e) => setPrefixDraft(e.target.value)}
                    placeholder="Enter prefix..."
                    className="h-8 rounded-md border border-border bg-bg pl-8 pr-3 font-mono text-xs"
                  />
                </div>
                <Button type="submit" variant="outline" className="h-8 text-xs px-2.5">
                  Go
                </Button>
              </form>
            </div>

            {/* Toolbar: Filter & Selection Actions */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-[14rem] flex-1">
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter objects in this folder…"
                />
              </div>

              {selectedKeys.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">{selectedKeys.length} selected</span>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => setBatchDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete ({selectedKeys.length})
                  </Button>
                </div>
              )}
            </div>

            {/* Drag and Drop Zone */}
            {drag ? (
              <div className="mt-4 rounded-lg border-2 border-dashed border-primary bg-raised p-8 text-center text-sm font-medium">
                Drop files here to upload into{" "}
                <span className="font-mono text-primary">/{prefix}</span>
              </div>
            ) : null}

            {/* Upload Jobs Progress */}
            {jobs.length > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold">Uploading {jobs.length} file(s)…</p>
                  <button
                    className="text-xs text-danger hover:underline"
                    onClick={() => uploadController.current?.abort()}
                  >
                    Cancel uploads
                  </button>
                </div>
                <ul className="mt-3 flex flex-col gap-2">
                  {jobs.map((job) => (
                    <li key={job.name} className="text-xs">
                      <div className="flex justify-between gap-3">
                        <span className="truncate font-mono">{job.name}</span>
                        <span className="text-muted">{Math.round(job.ratio * 100)}%</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                        <div
                          className="h-full bg-primary transition-all duration-150"
                          style={{ width: `${Math.round(job.ratio * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {error ? <p className="mt-6 text-sm text-danger">{error}</p> : null}
            {!error && !data ? <p className="mt-6 text-sm text-muted">Loading objects…</p> : null}

            {/* Empty State */}
            {data && folders.length === 0 && visibleObjects.length === 0 ? (
              <div className="mt-6">
                <EmptyState
                  title="This folder is empty"
                  body="Drag and drop files here, or click the Upload button to add objects."
                />
              </div>
            ) : null}

            {/* S3 Objects Table */}
            {data && (folders.length > 0 || visibleObjects.length > 0) ? (
              <div className="mt-4 overflow-hidden rounded-lg border border-border">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[45rem] text-left text-sm">
                    <thead className="border-b border-border bg-surface text-xs text-muted">
                      <tr>
                        <th className="w-10 px-4 py-3">
                          {visibleObjects.length > 0 && (
                            <button
                              type="button"
                              onClick={toggleSelectAll}
                              className="flex items-center text-muted hover:text-fg"
                              aria-label="Select all"
                            >
                              {selectedKeys.length > 0 &&
                              selectedKeys.length === visibleObjects.length ? (
                                <CheckSquare className="h-4 w-4 text-primary" />
                              ) : (
                                <Square className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </th>
                        <th className="px-4 py-3 font-medium">Name</th>
                        <th className="px-4 py-3 font-medium">Type</th>
                        <th className="px-4 py-3 font-medium">Last modified</th>
                        <th className="px-4 py-3 font-medium">Size</th>
                        <th className="px-4 py-3 font-medium">Storage class</th>
                        <th className="px-4 py-3 font-medium">Access</th>
                        <th className="px-4 py-3 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {/* Folders */}
                      {folders.map((folder) => (
                        <tr key={folder} className="hover:bg-surface/50 transition-colors">
                          <td className="px-4 py-3"></td>
                          <td className="px-4 py-3" colSpan={4}>
                            <button
                              type="button"
                              className="flex items-center gap-2.5 font-medium hover:text-primary transition-colors"
                              onClick={() => navigate({ search: { prefix: folder } })}
                            >
                              <Folder className="h-4 w-4 text-amber-500 fill-amber-500/20" />
                              <span className="font-mono text-sm">{leafName(folder, prefix)}</span>
                            </button>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted">Folder</td>
                          <td className="px-4 py-3 text-xs text-muted">—</td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 px-2 text-xs"
                              onClick={() => navigate({ search: { prefix: folder } })}
                            >
                              Open folder
                            </Button>
                          </td>
                        </tr>
                      ))}

                      {/* Objects */}
                      {visibleObjects.map((object) => {
                        const isObjPublic =
                          object.acl === "public-read" || Boolean(data?.bucket.isPublic);
                        return (
                          <tr
                            key={object.id}
                            className={`hover:bg-surface/50 transition-colors ${
                              selectedKeys.includes(object.key) ? "bg-raised/40" : ""
                            }`}
                          >
                            <td className="px-4 py-3">
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
                            </td>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                className="flex items-center gap-2 text-left font-mono font-medium hover:text-primary transition-colors"
                                onClick={() => void openPreview(object.key)}
                              >
                                <File className="h-4 w-4 text-muted" />
                                <span>{leafName(object.key, prefix)}</span>
                              </button>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted">
                              {guessType(object.key).split(";")[0] || object.contentType}
                            </td>
                            <td className="px-4 py-3 text-xs text-muted">
                              {formatWhen(object.updatedAt)}
                            </td>
                            <td className="px-4 py-3 text-xs text-muted font-mono">
                              {formatBytes(object.size)}
                            </td>
                            <td className="px-4 py-3 text-xs text-muted">Standard</td>
                            <td className="px-4 py-3">
                              <Pill tone={isObjPublic ? "accent" : "neutral"}>
                                {isObjPublic ? "Public" : "Private"}
                              </Pill>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  aria-label="Download"
                                  title="Download object"
                                  className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
                                  onClick={() =>
                                    void downloadKey(name, object.key, isObjPublic)
                                  }
                                >
                                  <Download className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  aria-label="Rename or move"
                                  title="Rename or move"
                                  className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
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
                                  aria-label="Delete"
                                  title="Delete object"
                                  className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-danger"
                                  onClick={() => {
                                    void removeObjectFn({
                                      data: { bucket: name, key: object.key },
                                    }).then((result) => {
                                      if (!result.ok) toast.error(result.error);
                                      else {
                                        toast.success("Object deleted");
                                        void load(startAfter);
                                      }
                                    });
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
        )}

        {/* TAB 2: PROPERTIES */}
        {activeTab === "properties" && (
          <div className="mt-4 grid max-w-4xl gap-6">
            {/* Bucket Overview */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-base font-semibold">Bucket overview</h2>
              <p className="mt-1 text-xs text-muted">
                General properties and location configuration for this S3 bucket.
              </p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2 text-sm">
                <div className="rounded-md border border-border/50 bg-bg/50 p-3">
                  <dt className="text-xs font-medium text-muted">AWS Region</dt>
                  <dd className="mt-1 font-mono text-sm font-medium">
                    {data?.bucket.region || "us-east-1"}
                  </dd>
                </div>
                <div className="rounded-md border border-border/50 bg-bg/50 p-3">
                  <dt className="text-xs font-medium text-muted">Amazon Resource Name (ARN)</dt>
                  <dd className="mt-1 flex items-center justify-between font-mono text-xs">
                    <span className="truncate">arn:aws:s3:::{name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(`arn:aws:s3:::${name}`);
                        toast.success("ARN copied");
                      }}
                      className="ml-2 text-muted hover:text-fg"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </dd>
                </div>
                <div className="rounded-md border border-border/50 bg-bg/50 p-3">
                  <dt className="text-xs font-medium text-muted">Creation date</dt>
                  <dd className="mt-1 text-sm">{formatWhen(data?.bucket.createdAt || "")}</dd>
                </div>
                <div className="rounded-md border border-border/50 bg-bg/50 p-3">
                  <dt className="text-xs font-medium text-muted">Total objects & size</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {data?.bucket.objectCount ?? 0} object(s) ·{" "}
                    {formatBytes(data?.bucket.totalBytes ?? 0)}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Default Encryption */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Default encryption</h2>
                  <p className="mt-1 text-xs text-muted">
                    Server-side encryption is automatically applied to all new objects stored in this bucket.
                  </p>
                </div>
                <Pill tone="accent">Enabled</Pill>
              </div>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="flex items-center justify-between py-1 border-b border-border/50">
                  <span className="text-muted">Encryption type</span>
                  <span className="font-medium">Server-side encryption with Amazon S3 managed keys (SSE-S3)</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-muted">Key algorithm</span>
                  <span className="font-mono text-xs">AES-256</span>
                </div>
              </div>
            </section>

            {/* Bucket Versioning */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Bucket Versioning</h2>
                  <p className="mt-1 text-xs text-muted">
                    Keep multiple variants of an object in the same bucket.
                  </p>
                </div>
                <Pill tone="neutral">Disabled</Pill>
              </div>
            </section>

            {/* Server Access Logging & Audit */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Server access logging & audit</h2>
                  <p className="mt-1 text-xs text-muted">
                    Tracks requests that are made to this bucket. All access operations are recorded to the node audit log.
                  </p>
                </div>
                <Link to="/activity" className="text-xs text-primary hover:underline">
                  View audit activity
                </Link>
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: PERMISSIONS (ACL) */}
        {activeTab === "permissions" && (
          <div className="mt-4 grid max-w-4xl gap-6">
            {/* Block Public Access (bucket settings) */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold">Block public access (bucket settings)</h2>
                    <Pill tone={isPublic ? "accent" : "neutral"}>
                      {isPublic ? "Off (Public permitted)" : "On (All public blocked)"}
                    </Pill>
                  </div>
                  <p className="mt-2 text-xs text-muted max-w-2xl leading-relaxed">
                    Block public access settings provide controls across an entire AWS S3 bucket to help prevent accidental public exposure. Turning this off allows public access to this bucket and its objects via bucket ACLs or public object links.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setBlockPublicAccessOpen(true)}
                >
                  Edit Block public access
                </Button>
              </div>

              <div className="mt-4 rounded-md border border-border/50 bg-bg p-4 text-xs">
                <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                  <span className="font-medium text-fg">Block all public access</span>
                  <span className={isPublic ? "text-amber-500 font-semibold" : "text-green-500 font-semibold"}>
                    {isPublic ? "Off" : "On"}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted">Block public access to buckets and objects granted through new ACLs</span>
                  <span>{isPublic ? "Off" : "On"}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-muted">Ignore public ACLs granted to buckets and objects</span>
                  <span>{isPublic ? "Off" : "On"}</span>
                </div>
              </div>
            </section>

            {/* Access Control List (ACL) */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold">Access control list (ACL)</h2>
                    <Pill tone={isPublic ? "accent" : "neutral"}>{bucketAcl}</Pill>
                  </div>
                  <p className="mt-2 text-xs text-muted max-w-2xl leading-relaxed">
                    Access control lists (ACLs) define which AWS accounts or predefined groups are granted access and the type of access (Objects: List, Write; Bucket ACL: Read, Write).
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSelectedAcl(bucketAcl);
                    setAclAcknowledge(false);
                    setEditAclOpen(true);
                  }}
                >
                  Edit ACL
                </Button>
              </div>

              {/* AWS S3 ACL Grantees Table */}
              <div className="mt-5 overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[36rem] text-left text-xs">
                  <thead className="border-b border-border bg-bg text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">Grantee</th>
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium text-center">Objects: List</th>
                      <th className="px-4 py-3 font-medium text-center">Objects: Write</th>
                      <th className="px-4 py-3 font-medium text-center">Bucket ACL: Read</th>
                      <th className="px-4 py-3 font-medium text-center">Bucket ACL: Write</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {/* Bucket Owner */}
                    <tr>
                      <td className="px-4 py-3 font-medium text-fg">
                        Bucket owner (your account)
                      </td>
                      <td className="px-4 py-3 text-muted">CanonicalUser</td>
                      <td className="px-4 py-3 text-center text-green-500 font-bold">✓</td>
                      <td className="px-4 py-3 text-center text-green-500 font-bold">✓</td>
                      <td className="px-4 py-3 text-center text-green-500 font-bold">✓</td>
                      <td className="px-4 py-3 text-center text-green-500 font-bold">✓</td>
                    </tr>
                    {/* Everyone (public access) */}
                    <tr className={isPublic ? "bg-amber-500/5" : ""}>
                      <td className="px-4 py-3 font-medium text-fg flex items-center gap-1.5">
                        {isPublic ? (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        ) : (
                          <Lock className="h-3.5 w-3.5 text-muted" />
                        )}
                        Everyone (public access)
                      </td>
                      <td className="px-4 py-3 text-muted">Group (AllUsers)</td>
                      <td className="px-4 py-3 text-center">
                        {bucketAcl === "public-read" || bucketAcl === "public-read-write" ? (
                          <span className="text-amber-500 font-bold">✓</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {bucketAcl === "public-read-write" ? (
                          <span className="text-amber-500 font-bold">✓</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-muted">—</td>
                      <td className="px-4 py-3 text-center text-muted">—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Bucket Policy Card */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-base font-semibold">Bucket policy</h2>
              <p className="mt-1 text-xs text-muted">
                The bucket policy provides access to the objects stored in the bucket.
              </p>
              <div className="mt-3 flex items-center justify-between rounded-md border border-border/50 bg-bg p-3 text-xs font-mono">
                <span>arn:aws:s3:::{name}</span>
                <span className="text-muted">
                  {data?.bucket.policy ? "Policy configured" : "No bucket policy"}
                </span>
              </div>
            </section>

            {/* Cross-origin resource sharing (CORS) Card */}
            <section className="rounded-lg border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Cross-origin resource sharing (CORS)</h2>
                  <p className="mt-1 text-xs text-muted">
                    The CORS configuration defines how client web applications in other domains interact with this bucket.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCorsDraft(data?.bucket.corsRules || "[]");
                    setCorsOpen(true);
                  }}
                >
                  Edit CORS
                </Button>
              </div>
              <pre className="mt-4 max-h-48 overflow-auto rounded-md border border-border/50 bg-bg p-3 font-mono text-xs">
                {data?.bucket.corsRules && data.bucket.corsRules !== "[]"
                  ? data.bucket.corsRules
                  : "// No CORS configuration defined. Standard S3 sandbox active."}
              </pre>
            </section>
          </div>
        )}

        {/* MODAL: Edit Bucket ACL */}
        {editAclOpen && (
          <Modal title="Edit access control list (ACL)" onClose={() => setEditAclOpen(false)}>
            <p className="text-xs text-muted">
              Select an AWS S3 canned access control policy for{" "}
              <span className="font-mono text-fg">{name}</span>:
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-all ${
                  selectedAcl === "private"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="cannedAcl"
                  value="private"
                  checked={selectedAcl === "private"}
                  onChange={() => setSelectedAcl("private")}
                  className="mt-0.5"
                />
                <div className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">private (Recommended)</span>
                    <Pill tone="neutral">Private</Pill>
                  </div>
                  <p className="mt-1 text-muted">
                    Bucket owner gets FULL_CONTROL. No one else has access rights. Public access is blocked.
                  </p>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-all ${
                  selectedAcl === "public-read"
                    ? "border-amber-500 bg-amber-500/5"
                    : "border-border hover:bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="cannedAcl"
                  value="public-read"
                  checked={selectedAcl === "public-read"}
                  onChange={() => setSelectedAcl("public-read")}
                  className="mt-0.5"
                />
                <div className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">public-read</span>
                    <Pill tone="accent">Public Read</Pill>
                  </div>
                  <p className="mt-1 text-muted">
                    Bucket owner gets FULL_CONTROL. Everyone (AllUsers group) gets READ access to list and download objects.
                  </p>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-all ${
                  selectedAcl === "public-read-write"
                    ? "border-amber-500 bg-amber-500/5"
                    : "border-border hover:bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name="cannedAcl"
                  value="public-read-write"
                  checked={selectedAcl === "public-read-write"}
                  onChange={() => setSelectedAcl("public-read-write")}
                  className="mt-0.5"
                />
                <div className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">public-read-write</span>
                    <Pill tone="accent">Full Public</Pill>
                  </div>
                  <p className="mt-1 text-muted">
                    Bucket owner gets FULL_CONTROL. Everyone gets READ and WRITE access to list, download, and upload objects.
                  </p>
                </div>
              </label>
            </div>

            {(selectedAcl === "public-read" || selectedAcl === "public-read-write") &&
              !isPublic && (
                <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                    <div>
                      <p className="font-medium">Public access warning</p>
                      <p className="mt-1 text-muted">
                        Granting public access allows anyone on the internet to access this bucket.
                      </p>
                      <label className="mt-2.5 flex items-center gap-2 cursor-pointer font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={aclAcknowledge}
                          onChange={(e) => setAclAcknowledge(e.target.checked)}
                        />
                        I acknowledge that this bucket will become publicly accessible.
                      </label>
                    </div>
                  </div>
                </div>
              )}

            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditAclOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={savingAcl || ((selectedAcl === "public-read" || selectedAcl === "public-read-write") && !aclAcknowledge && !isPublic)}
                onClick={() => void handleSaveAcl()}
              >
                {savingAcl ? "Saving ACL…" : "Save changes"}
              </Button>
            </div>
          </Modal>
        )}

        {/* MODAL: Edit Block Public Access */}
        {blockPublicAccessOpen && (
          <Modal
            title="Edit Block public access (bucket settings)"
            onClose={() => setBlockPublicAccessOpen(false)}
          >
            <p className="text-xs text-muted leading-relaxed">
              {isPublic
                ? "Turning on Block public access will immediately switch this bucket's ACL to private, preventing anonymous visitors from reading or listing objects."
                : "Turning off Block public access will allow this bucket to serve objects to anonymous public requests via public-read ACL."}
            </p>

            <div className="mt-4 rounded-md border border-border bg-bg p-3 text-xs">
              <p className="font-medium text-fg">Current status: {isPublic ? "Public" : "Private"}</p>
              <p className="mt-1 text-muted">
                Target status:{" "}
                {isPublic ? "Block all public access (ON)" : "Allow public read access (OFF)"}
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setBlockPublicAccessOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={isPublic ? "primary" : "outline"}
                disabled={savingAcl}
                onClick={() => void handleToggleBlockPublicAccess()}
              >
                {savingAcl
                  ? "Saving…"
                  : isPublic
                    ? "Turn On Block Public Access"
                    : "Turn Off Block Public Access"}
              </Button>
            </div>
          </Modal>
        )}

        {/* MODAL: Edit CORS */}
        {corsOpen && (
          <Modal title="Edit CORS configuration" onClose={() => setCorsOpen(false)}>
            <p className="text-xs text-muted">
              Enter valid JSON CORS configuration rules:
            </p>
            <textarea
              value={corsDraft}
              onChange={(e) => setCorsDraft(e.target.value)}
              rows={8}
              className="mt-3 w-full rounded-md border border-border bg-bg p-3 font-mono text-xs"
              placeholder="[]"
            />
            <div className="mt-4 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setCorsOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={savingCors}
                onClick={async () => {
                  setSavingCors(true);
                  try {
                    const res = await setBucketCorsFn({ data: { name, corsRules: corsDraft } });
                    if (res.ok) {
                      toast.success("CORS configuration saved");
                      setCorsOpen(false);
                      void load(startAfter);
                    } else {
                      toast.error(res.error || "Failed to save CORS");
                    }
                  } catch {
                    toast.error("Failed to save CORS");
                  } finally {
                    setSavingCors(false);
                  }
                }}
              >
                {savingCors ? "Saving…" : "Save CORS rules"}
              </Button>
            </div>
          </Modal>
        )}

        {/* MODAL: New Folder */}
        {folderOpen ? (
          <Modal title="Create folder" onClose={() => setFolderOpen(false)}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const clean = folderName.trim().replace(/\/+$/, "");
                if (!clean || clean.includes("/")) {
                  toast.error("Use a single folder name without slashes.");
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
              <Field label="Folder name">
                <Input
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="e.g. logs"
                  autoFocus
                />
              </Field>
              <Button type="submit">Create folder</Button>
            </form>
          </Modal>
        ) : null}

        {/* MODAL: Batch Delete Confirmation */}
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

        {/* MODAL: Move / Rename */}
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

        {/* MODAL: AWS S3 Object Details & Preview */}
        {preview ? (
          <Modal
            title={leafName(preview.key, prefix) || preview.key}
            onClose={() => {
              setPreview(null);
              if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
              setPreviewUrl("");
            }}
          >
            {/* S3 URI and ARN identifiers */}
            <div className="space-y-2 rounded-md border border-border bg-surface p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted">S3 URI:</span>
                <div className="flex items-center gap-1 font-mono">
                  <span>s3://{name}/{preview.key}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(`s3://${name}/${preview.key}`);
                      toast.success("S3 URI copied");
                    }}
                    className="ml-1 text-muted hover:text-fg"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">ARN:</span>
                <div className="flex items-center gap-1 font-mono">
                  <span className="truncate max-w-[18rem]">arn:aws:s3:::{name}/{preview.key}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(`arn:aws:s3:::${name}/${preview.key}`);
                      toast.success("ARN copied");
                    }}
                    className="ml-1 text-muted hover:text-fg"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Public URL:</span>
                <div className="flex items-center gap-1 font-mono">
                  <span className="truncate max-w-[18rem]">
                    {withBase(
                      `/api/public/${encodeURIComponent(name)}/${encodeKeyPath(preview.key)}`,
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        absoluteUrl(
                          `/api/public/${encodeURIComponent(name)}/${encodeKeyPath(preview.key)}`,
                        ),
                      );
                      toast.success("Public URL copied");
                    }}
                    className="ml-1 text-muted hover:text-fg"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* Properties summary */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-4">
              <div>
                Size: <span className="text-fg font-mono">{formatBytes(preview.size)}</span>
              </div>
              <div>
                Type:{" "}
                <span className="text-fg font-mono">
                  {preview.contentType || guessType(preview.key)}
                </span>
              </div>
              <div>
                ETag: <span className="text-fg font-mono">{preview.etag.slice(0, 10)}…</span>
              </div>
              <div>
                Class: <span className="text-fg">Standard</span>
              </div>
            </div>

            {/* Media/Text Preview */}
            <div className="mt-4">
              <PreviewBody object={preview} url={previewUrl} text={previewText} />
            </div>

            {/* Object ACL Setting */}
            <div className="mt-4 rounded-md border border-border bg-surface p-3">
              <p className="text-xs font-semibold">Object access control (ACL)</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted">Access level:</span>
                  <select
                    value={objAclDraft}
                    onChange={(e) => setObjAclDraft(e.target.value)}
                    className="h-8 rounded-md border border-border bg-bg px-2 text-xs"
                  >
                    <option value="private">private (Owner only)</option>
                    <option value="public-read">public-read (Everyone can read)</option>
                  </select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={savingObjAcl || objAclDraft === preview.acl}
                  onClick={() => void handleSaveObjectAcl()}
                >
                  {savingObjAcl ? "Saving…" : "Update Object ACL"}
                </Button>
              </div>
            </div>

            {/* Tags */}
            {preview.tags.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {preview.tags.map((tag) => (
                  <li key={tag.key} className="rounded-md bg-raised px-2 py-0.5 text-xs font-mono">
                    {tag.key}: {tag.value}
                  </li>
                ))}
              </ul>
            ) : null}

            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
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
                placeholder="Tag key"
              />
              <Input
                value={tagValue}
                onChange={(event) => setTagValue(event.target.value)}
                placeholder="Tag value"
              />
              <Button type="submit" variant="outline">
                Add tag
              </Button>
            </form>

            {/* Actions */}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void downloadKey(
                    name,
                    preview.key,
                    preview.acl === "public-read" || Boolean(data?.bucket.isPublic),
                  )
                }
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

            {/* Share Link Generator */}
            <div className="mt-4 rounded-md border border-border bg-surface p-3">
              <p className="text-xs font-semibold">Create presigned share link</p>
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
  const blob = await downloadObject(
    detail.object.id,
    detail.object.partCount,
    detail.object.contentType,
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = leafName(key, "");
  anchor.click();
  URL.revokeObjectURL(url);
}

const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

function PreviewBody({ object, url, text }: { object: Detail; url: string; text: string }) {
  const type = (object.contentType || guessType(object.key)).split(";", 1)[0].trim().toLowerCase();
  if (object.size === 0) return <p className="text-sm text-muted">Empty object.</p>;
  if (SAFE_IMAGE_TYPES.has(type)) {
    if (!url) return <p className="text-sm text-muted">Preparing preview…</p>;
    return <img src={url} alt="" className="max-h-96 w-full rounded-md object-contain" />;
  }
  if (type.startsWith("video/")) {
    if (!url) return <p className="text-sm text-muted">Preparing preview…</p>;
    return <video src={url} controls className="w-full rounded-md" />;
  }
  if (type.startsWith("audio/")) {
    if (!url) return <p className="text-sm text-muted">Preparing preview…</p>;
    return <audio src={url} controls className="w-full" />;
  }
  if (text)
    return (
      <pre className="max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-xs">{text}</pre>
    );
  return (
    <p className="text-sm text-muted">No inline preview for this file. Download it instead.</p>
  );
}
