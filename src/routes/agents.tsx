import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Authed } from "@/components/authed";
import { Shell } from "@/components/shell";
import { Button, EmptyState, Field, Input, Modal, PageHeader, Pill } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  createAgentTokenFn,
  listAgentTokensFn,
  revokeAgentTokenFn,
  fetchOverview,
  deleteBucketFn,
} from "@/lib/storage/api";
import { formatBytes, formatWhen } from "@/lib/storage/pure";
import { Check, Copy, Terminal, Bot, Clock } from "lucide-react";

export const Route = createFileRoute("/agents")({ component: AgentsPage });

type TokenRow = Awaited<ReturnType<typeof listAgentTokensFn>>[number];
type Overview = Awaited<ReturnType<typeof fetchOverview>>;

function CopySnippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success(`Copied ${label}`);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative rounded-md border border-border bg-raised/50 p-3 font-mono text-xs">
      <div className="mb-2 flex items-center justify-between text-muted">
        <span>{label}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 text-fg hover:text-accent transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto text-fg whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

function AgentsPage() {
  const { user } = useCurrentUserState();
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [overviewData, setOverviewData] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<"read" | "write" | "read-write" | "admin">("read-write");
  const [bucketScope, setBucketScope] = useState("*");
  const [ttlDays, setTtlDays] = useState(30);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const endpoint = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";

  async function load() {
    try {
      const [tokenList, ov] = await Promise.all([listAgentTokensFn(), fetchOverview()]);
      setTokens(tokenList);
      setOverviewData(ov);
    } catch {
      toast.error("Failed to load agent configuration.");
    }
  }

  useEffect(() => {
    if (!user?.id) return;
    void load();
  }, [user?.id]);

  const scratchBuckets = (overviewData?.buckets || []).filter((b) => b.isScratch);

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        middleout: {
          command: "npx",
          args: ["-y", "@middleout/mcp-server"],
          env: {
            MIDDLEOUT_ENDPOINT: endpoint,
            MIDDLEOUT_AGENT_KEY: createdToken || "mo_agent_live_YOUR_TOKEN_HERE",
          },
        },
      },
    },
    null,
    2,
  );

  const antigravityConfig = JSON.stringify(
    {
      mcpServers: {
        middleout: {
          command: "middleout-mcp",
          env: {
            MIDDLEOUT_ENDPOINT: endpoint,
            MIDDLEOUT_AGENT_KEY: createdToken || "mo_agent_live_YOUR_TOKEN_HERE",
          },
        },
      },
    },
    null,
    2,
  );

  const curlUploadExample = `curl -X POST "${endpoint}/api/agent/v1/upload" \\
  -H "Authorization: Bearer ${createdToken || "mo_agent_live_YOUR_TOKEN_HERE"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bucket": "my-bucket",
    "key": "report.md",
    "content": "# Run 12 Results\\nAll tests passed successfully."
  }'`;

  return (
    <Authed>
      <Shell>
        <PageHeader
          title="AI & Agents"
          description="Native Model Context Protocol (MCP) server, scoped agent tokens, and ephemeral scratch buckets for autonomous AI workflows."
          action={
            <Button type="button" onClick={() => setOpen(true)}>
              Issue agent token
            </Button>
          }
        />

        {/* Quick Config Snippets */}
        <div className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold">Connect AI Agents & Tools (MCP)</h2>
          </div>
          <p className="text-xs text-muted">
            Configure Claude Desktop, Antigravity, Cursor, or AutoGen using the native MiddleOut MCP server or REST API.
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            <CopySnippet label="Claude Desktop (claude_desktop_config.json)" text={claudeDesktopConfig} />
            <CopySnippet label="Antigravity / Cursor MCP Config" text={antigravityConfig} />
          </div>

          <CopySnippet label="Agent REST API (cURL)" text={curlUploadExample} />
        </div>

        {/* Active Agent Tokens */}
        <div className="mt-8">
          <h2 className="text-base font-semibold">Agent Access Tokens</h2>
          <p className="text-xs text-muted">Tokens authenticate bots with Bearer mo_agent_... without AWS SigV4 signing.</p>

          {!tokens ? (
            <p className="mt-4 text-sm text-muted">Loading tokens…</p>
          ) : tokens.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No agent tokens" body="Generate an agent token to connect an MCP client or autonomous bot." />
            </div>
          ) : (
            <ul className="mt-4 overflow-hidden rounded-lg border border-border">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 last:border-b-0 hover:bg-surface/80"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-muted" />
                      <span className="font-semibold text-sm">{token.name}</span>
                      <Pill tone="accent">{token.permissions}</Pill>
                      <Pill tone="neutral">Scope: {token.bucketScope}</Pill>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
                      <span>{token.maskedToken}</span>
                      <span>·</span>
                      <span>Created {formatWhen(token.createdAt)}</span>
                      {token.expiresAt && (
                        <>
                          <span>·</span>
                          <span className="text-amber-400">Expires {formatWhen(token.expiresAt)}</span>
                        </>
                      )}
                      {token.lastUsedAt && (
                        <>
                          <span>·</span>
                          <span className="text-accent">Last used {formatWhen(token.lastUsedAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void revokeAgentTokenFn({ data: { tokenId: token.id } })
                        .then(() => {
                          toast.success("Token revoked");
                          void load();
                        })
                        .catch(() => toast.error("Could not revoke token"));
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Ephemeral Scratch Buckets */}
        <div className="mt-8">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-400" />
            <h2 className="text-base font-semibold">Active Ephemeral Scratch Buckets</h2>
          </div>
          <p className="text-xs text-muted">Temporary agent buckets that automatically purge themselves when their TTL expires.</p>

          {scratchBuckets.length === 0 ? (
            <p className="mt-3 text-xs text-muted">No active ephemeral scratch buckets right now.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Bucket</th>
                    <th className="px-4 py-2 font-medium">Objects</th>
                    <th className="px-4 py-2 font-medium">Size</th>
                    <th className="px-4 py-2 font-medium">Auto-Expires</th>
                    <th className="px-4 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scratchBuckets.map((b) => (
                    <tr key={b.id} className="border-t border-border hover:bg-surface/50">
                      <td className="px-4 py-2 font-mono text-accent">{b.name}</td>
                      <td className="px-4 py-2 text-muted">{b.objectCount}</td>
                      <td className="px-4 py-2 text-muted">{formatBytes(b.bytes)}</td>
                      <td className="px-4 py-2 text-amber-400 text-xs">
                        {b.expiresAt ? formatWhen(b.expiresAt) : "No TTL"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            void deleteBucketFn({ data: { name: b.name, force: true } })
                              .then(() => {
                                toast.success("Scratch bucket deleted");
                                void load();
                              })
                              .catch(() => toast.error("Could not delete scratch bucket"));
                          }}
                        >
                          Purge now
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Create Token Modal */}
        {open && (
          <Modal title="Issue Agent Access Token" onClose={() => setOpen(false)}>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                void createAgentTokenFn({
                  data: {
                    name,
                    permissions,
                    bucketScope,
                    ttlDays: ttlDays > 0 ? ttlDays : undefined,
                  },
                })
                  .then((res) => {
                    setCreatedToken(res.token);
                    toast.success("Agent token created!");
                    setOpen(false);
                    setName("");
                    void load();
                  })
                  .catch(() => toast.error("Failed to create agent token"))
                  .finally(() => setBusy(false));
              }}
            >
              <Field label="Token Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Claude Desktop, Benchmark Runner"
                  required
                  autoFocus
                />
              </Field>

              <Field label="Permissions">
                <select
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg"
                  value={permissions}
                  onChange={(e) => setPermissions(e.target.value as typeof permissions)}
                >
                  <option value="read-write">Read & Write (Recommended for bots)</option>
                  <option value="read">Read-only</option>
                  <option value="write">Write-only (Upload dropboxes)</option>
                  <option value="admin">Full Admin (Manage buckets & keys)</option>
                </select>
              </Field>

              <Field label="Bucket Scope">
                <Input
                  value={bucketScope}
                  onChange={(e) => setBucketScope(e.target.value)}
                  placeholder="* or scratch-* or bucket-name"
                />
                <span className="mt-1 block text-xs text-muted">
                  Use * for all buckets, or prefix patterns like scratch-* to isolate this bot.
                </span>
              </Field>

              <Field label="Token Expiration (TTL)">
                <select
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg"
                  value={ttlDays}
                  onChange={(e) => setTtlDays(Number(e.target.value))}
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days (Recommended)</option>
                  <option value={90}>90 days</option>
                  <option value={0}>Never expire</option>
                </select>
              </Field>

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Generating…" : "Create token"}
                </Button>
              </div>
            </form>
          </Modal>
        )}

        {/* Display Newly Created Token Modal */}
        {createdToken && (
          <Modal title="Agent Token Generated" onClose={() => setCreatedToken(null)}>
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted">
                Save this token now. For security, it will not be shown again.
              </p>
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs break-all text-amber-200">
                {createdToken}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(createdToken);
                    toast.success("Token copied to clipboard");
                  }}
                >
                  Copy token
                </Button>
                <Button type="button" variant="outline" onClick={() => setCreatedToken(null)}>
                  Done
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </Shell>
    </Authed>
  );
}
