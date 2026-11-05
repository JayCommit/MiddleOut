import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell } from "@/components/shell";
import { Authed } from "@/components/authed";
import { Button, EmptyState, Field, Input, Modal, PageHeader, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { createBucketFn, deleteBucketFn, fetchOverview, setBucketAclFn } from "@/lib/storage/api";
import { formatBytes, formatWhen, type CannedAcl } from "@/lib/storage/pure";

export const Route = createFileRoute("/buckets/")({ component: BucketsPage });

type Overview = Awaited<ReturnType<typeof fetchOverview>>;

function BucketsPage() {
  const { user, isPending } = useCurrentUserState();
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedAcl, setSelectedAcl] = useState<CannedAcl>("private");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function load() {
    const next = await fetchOverview();
    setData(next);
  }

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    fetchOverview()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Could not load buckets.");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <Authed>
    <Shell>
      <PageHeader
        title="Buckets"
        description="Buckets are containers for data stored in MiddleOut (Amazon S3 compatible). Names are globally unique on this node."
        action={
          <Button type="button" onClick={() => setOpen(true)}>
            Create bucket
          </Button>
        }
      />
      {isPending || !data ? (
        <p className="mt-8 text-sm text-muted">Loading buckets…</p>
      ) : data.buckets.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No buckets yet" body="Create an S3 bucket to store and organize objects." />
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">AWS Region</th>
                <th className="px-4 py-3 font-medium">Access</th>
                <th className="px-4 py-3 font-medium">Objects</th>
                <th className="px-4 py-3 font-medium">Size</th>
                <th className="px-4 py-3 font-medium">Creation date</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((bucket) => {
                const isPub = bucket.acl === "public-read" || bucket.acl === "public-read-write" || bucket.isPublic;
                return (
                  <tr key={bucket.id} className="border-t border-border hover:bg-surface/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          to="/buckets/$name"
                          params={{ name: bucket.name }}
                          search={{ prefix: "" }}
                          className="font-mono font-medium text-accent hover:underline"
                        >
                          {bucket.name}
                        </Link>
                        <button
                          type="button"
                          className="text-xs text-muted hover:text-fg"
                          title="Copy S3 URI"
                          onClick={() => {
                            void navigator.clipboard.writeText(`s3://${bucket.name}`);
                            toast.success(`Copied s3://${bucket.name}`);
                          }}
                        >
                          📋
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">us-east-1 (local)</td>
                    <td className="px-4 py-3">
                      <Pill tone={isPub ? "accent" : "neutral"}>
                        {isPub ? "Public" : "Bucket and objects not public"}
                      </Pill>
                    </td>
                    <td className="px-4 py-3 text-muted">{bucket.objectCount}</td>
                    <td className="px-4 py-3 text-muted">{formatBytes(bucket.bytes)}</td>
                    <td className="px-4 py-3 text-muted">{formatWhen(bucket.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            const nextAcl: CannedAcl = isPub ? "private" : "public-read";
                            void setBucketAclFn({ data: { name: bucket.name, acl: nextAcl } })
                              .then((result) => {
                                if (!result.ok) toast.error(result.error);
                                else {
                                  toast.success(`Set ACL to ${nextAcl}`);
                                  void load();
                                }
                              })
                              .catch(() => toast.error("Could not update access."));
                          }}
                        >
                          {isPub ? "Make private" : "Make public"}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setPendingDelete(bucket.name)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open ? (
        <Modal title="Create bucket" onClose={() => setOpen(false)}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void createBucketFn({ data: { name, acl: selectedAcl, isPublic: selectedAcl !== "private" } })
                .then((result) => {
                  if (!result.ok) toast.error(result.error);
                  else {
                    toast.success(`Created s3://${result.name}`);
                    setOpen(false);
                    setName("");
                    setSelectedAcl("private");
                    void load();
                  }
                })
                .catch(() => toast.error("Could not create the bucket."))
                .finally(() => setBusy(false));
            }}
          >
            <Field label="Bucket name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ""))}
                placeholder="my-s3-bucket"
                autoFocus
                required
              />
              <span className="mt-1 block text-xs text-muted">Bucket names must be globally unique and between 3 and 63 characters long.</span>
            </Field>

            <Field label="AWS Region">
              <input
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-muted cursor-not-allowed"
                value="US East (N. Virginia) us-east-1"
                disabled
              />
            </Field>

            <Field label="Access Control List (ACL)">
              <select
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg"
                value={selectedAcl}
                onChange={(e) => setSelectedAcl(e.target.value as CannedAcl)}
              >
                <option value="private">private — Only the bucket owner has full control (Recommended)</option>
                <option value="public-read">public-read — Everyone has READ access to the bucket</option>
                <option value="public-read-write">public-read-write — Everyone has READ and WRITE access</option>
                <option value="authenticated-read">authenticated-read — Any authenticated user has READ access</option>
              </select>
              <span className="mt-1 block text-xs text-muted">Control bucket access using Amazon S3 canned ACLs.</span>
            </Field>

            {selectedAcl !== "private" && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                ⚠️ Turning off private access means anyone on the internet will have access to read or list this bucket.
              </div>
            )}

            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create bucket"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {pendingDelete ? (
        <Modal title="Delete bucket" onClose={() => setPendingDelete(null)}>
          <p className="text-sm text-muted">
            This deletes <span className="font-mono text-fg">{pendingDelete}</span> and every object inside it.
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const target = pendingDelete;
                void deleteBucketFn({ data: { name: target, force: true } })
                  .then((result) => {
                    if (!result.ok) toast.error(result.error);
                    else {
                      toast.success("Bucket deleted");
                      setPendingDelete(null);
                      void load();
                    }
                  })
                  .catch(() => toast.error("Could not delete the bucket."));
              }}
            >
              Delete
            </Button>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </Shell>
    </Authed>
  );
}
