import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.DATA_DIR = ":memory:";
process.env.DATABASE_URL = "";
process.env.BETTER_AUTH_URL = "http://localhost:8080";
process.env.BETTER_AUTH_SECRET = "disposable-agent-smoke-secret-at-least-32-characters";
const { default: app } = await import("../dist/server/server.js");
const origin = process.env.BETTER_AUTH_URL;
const request = (path, init) => app.fetch(new Request(new URL(path, origin), init));
assert.equal((await request("/api/health")).status, 200);
await request("/api/auth/get-session");
const { createAgentToken } = await import("../src/lib/storage/agents.server.ts");
const q = await import("../src/lib/storage/queries.server.ts");
const owner = "agent-http-smoke-owner";
await q.createBucket(owner, "agent-smoke-bucket", "private");
const token = await createAgentToken(owner, { name: "smoke", bucketScope: "agent-*" });
const readOnly = await createAgentToken(owner, {
  name: "reader",
  permissions: "read",
  bucketScope: "agent-smoke-bucket",
});
const headers = { authorization: `Bearer ${token.token}` };
for (const path of ["/api/agent/v1/openapi.json", "/.well-known/llms.txt"]) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  if (path.endsWith(".json")) assert.equal((await response.json()).openapi, "3.1.0");
  else assert.match(await response.text(), /Streamable HTTP/);
}
assert.equal((await request("/api/agent/v1/mcp", { method: "POST", body: "{}" })).status, 401);
assert.equal((await request("/api/agent/v1/mcp", { headers })).status, 405);
// Loop internal bridge HTTP calls back through the actual production route handler.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => app.fetch(new Request(input, init));
const client = new Client({ name: "production-route-smoke", version: "1.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/agent/v1/mcp", origin), {
      requestInit: { headers },
      fetch: globalThis.fetch,
    }),
  );
  assert.equal((await client.listTools()).tools.length, 6);
  for (const key of ["docs/report#1.txt", "docs/query?x=1.txt", "docs/percent%23 ü.txt"]) {
    const write = await client.callTool({
      name: "storage_write_file",
      arguments: { bucket: "agent-smoke-bucket", key, content: "production round trip" },
    });
    assert.notEqual(write.isError, true, JSON.stringify(write));
    const read = await client.callTool({
      name: "storage_read_file",
      arguments: { bucket: "agent-smoke-bucket", key },
    });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.equal(JSON.parse(read.content[0].text).content, "production round trip");
  }
  const files = await request("/api/agent/v1/files?bucket=agent-smoke-bucket&prefix=docs/", {
    headers,
  });
  assert.equal((await files.json()).objects.length, 3);
  const search = await request("/api/agent/v1/search?q=report", { headers });
  assert.equal((await search.json()).results[0].key, "docs/report#1.txt");
  const denied = await request("/api/agent/v1/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${readOnly.token}`, "content-type": "application/json" },
    body: JSON.stringify({ bucket: "agent-smoke-bucket", key: "denied", content: "blocked" }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await request("/api/agent/v1/files?bucket=other-bucket", { headers })).status, 403);
  const artifact = await client.callTool({
    name: "storage_upload_artifact",
    arguments: { name: "artifact.txt", content: "temporary", ttl_hours: 0.5 },
  });
  assert.notEqual(artifact.isError, true, JSON.stringify(artifact));
  assert.match(JSON.parse(artifact.content[0].text).bucket, /^agent-artifacts-/);
  console.log(
    "PASS: production discovery, agent authorization, MCP initialize/list/call, reserved-key round trips, folder listing, nested search, and artifact upload.",
  );
} finally {
  await client.close();
  globalThis.fetch = originalFetch;
  await (await globalThis.__pgliteInstance__)?.close();
}
