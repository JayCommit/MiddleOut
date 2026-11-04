import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, EmptyState, Field, Input, Modal, PageHeader } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { createKeyFn, listKeysFn, revokeKeyFn } from "@/lib/storage/api";
import { formatWhen } from "@/lib/storage/pure";

export const Route = createFileRoute("/keys")({ component: KeysPage });

type KeyRow = Awaited<ReturnType<typeof listKeysFn>>[number];

function KeysPage() {
  const { user } = useCurrentUserState();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ accessKeyId: string; secretKey: string } | null>(null);

  async function load() {
    setKeys(await listKeysFn());
  }

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    listKeysFn()
      .then((rows) => {
        if (!cancelled) setKeys(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Could not load keys.");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <Authed>
    <Shell>
      <PageHeader
        title="Access keys"
        description="Use these with the S3 endpoint. The secret is shown once and then stays on the server so signatures can be checked."
        action={
          <Button type="button" onClick={() => setOpen(true)}>
            Create key
          </Button>
        }
      />
      {!keys ? <p className="mt-8 text-sm text-muted">Loading keys…</p> : null}
      {keys && keys.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No access keys" body="Create one before you connect the AWS CLI, rclone, or boto3." />
        </div>
      ) : null}
      {keys && keys.length > 0 ? (
        <ul className="mt-6 overflow-hidden rounded-lg border border-border">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{key.accessKeyId}</p>
                <p className="text-xs text-muted">
                  {key.label || "Untitled"} · secret ends {key.last4} · {formatWhen(key.createdAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  void revokeKeyFn({ data: { id: key.id } }).then((result) => {
                    if (!result.ok) toast.error(result.error);
                    else void load();
                  });
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Modal title="Create access key" onClose={() => setOpen(false)}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createKeyFn({ data: { label } }).then((result) => {
                if (!result.ok) toast.error(result.error);
                else {
                  setCreated({ accessKeyId: result.accessKeyId, secretKey: result.secretKey });
                  setOpen(false);
                  setLabel("");
                  void load();
                }
              });
            }}
          >
            <Field label="Label">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="laptop" />
            </Field>
            <Button type="submit">Create</Button>
          </form>
        </Modal>
      ) : null}
      {created ? (
        <Modal title="Copy this secret" onClose={() => setCreated(null)}>
          <p className="text-sm text-muted">This is the only time the secret is shown in the console.</p>
          <p className="mt-4 break-all font-mono text-xs">Access key: {created.accessKeyId}</p>
          <p className="mt-2 break-all font-mono text-xs">Secret: {created.secretKey}</p>
          <Button
            type="button"
            className="mt-4"
            onClick={() => {
              void navigator.clipboard.writeText(
                `AWS_ACCESS_KEY_ID=${created.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${created.secretKey}\n`,
              );
              toast.success("Copied");
            }}
          >
            Copy both
          </Button>
        </Modal>
      ) : null}
    </Shell>
    </Authed>
  );
}
