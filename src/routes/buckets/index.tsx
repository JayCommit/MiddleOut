import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell } from "@/components/shell";
import { Authed } from "@/components/authed";
import { Button, EmptyState, Field, Input, Modal, PageHeader, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { createBucketFn, deleteBucketFn, fetchOverview, setBucketAccessFn } from "@/lib/storage/api";
import { formatBytes, formatWhen } from "@/lib/storage/pure";

export const Route = createFileRoute("/buckets/")({ component: BucketsPage });

type Overview = Awaited<ReturnType<typeof fetchOverview>>;

function BucketsPage() {
  const { user, isPending } = useCurrentUserState();
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
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
        description="Names are unique on this node. New buckets are private unless you mark them public."
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
          <EmptyState title="No buckets yet" body="Create one to upload files. Private is the default." />
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-surface text-xs text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Access</th>
                <th className="px-4 py-3 font-medium">Objects</th>
                <th className="px-4 py-3 font-medium">Size</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((bucket) => (
                <tr key={bucket.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <Link to="/buckets/$name" params={{ name: bucket.name }} search={{ prefix: "" }} className="font-mono">
                      {bucket.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={bucket.isPublic ? "accent" : "neutral"}>{bucket.isPublic ? "Public" : "Private"}</Pill>
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
                          void setBucketAccessFn({ data: { name: bucket.name, isPublic: !bucket.isPublic } })
                            .then((result) => {
                              if (!result.ok) toast.error(result.error);
                              else void load();
                            })
                            .catch(() => toast.error("Could not update access."));
                        }}
                      >
                        {bucket.isPublic ? "Make private" : "Make public"}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setPendingDelete(bucket.name)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
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
              void createBucketFn({ data: { name, isPublic } })
                .then((result) => {
                  if (!result.ok) toast.error(result.error);
                  else {
                    toast.success(`Created ${result.name}`);
                    setOpen(false);
                    setName("");
                    setIsPublic(false);
                    void load();
                  }
                })
                .catch(() => toast.error("Could not create the bucket."))
                .finally(() => setBusy(false));
            }}
          >
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="assets" autoFocus required />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
              Public read. Anyone can list and download.
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create bucket"}
            </Button>
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
