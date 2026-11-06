import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttp } from "../mcp/http.server.ts";
import { MiddleOutMcpServer } from "../mcp/server.ts";
import * as q from "./queries.server.ts";

// Real SDK client and transport; the REST adapter uses real storage and validates encoded URLs.
test("remote MCP initializes, lists tools, and writes/reads reserved object keys", async () => {
  const endpoint = "http://localhost:8080";
  const owner = "mcp-http-owner";
  await q.createBucket(owner, "mcp-http-bucket", "private");
  const restFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/upload")) {
      const body = JSON.parse(String(init!.body));
      return Response.json(
        await q.putBytes(owner, body.bucket, body.key, Buffer.from(body.content), "text/plain", {}),
      );
    }
    const segments = url.pathname.split("/").slice(5).map(decodeURIComponent);
    const read = await q.readObjectFor(owner, segments[0], segments.slice(1).join("/"));
    if ("error" in read) return Response.json(read, { status: 404 });
    return Response.json({ ok: true, key: read.object.key, content: read.object.bytes.toString() });
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/api/agent/v1/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-token" } },
    fetch: async (input, init) =>
      handleMcpHttp(new Request(input, init), {
        endpoint,
        agentKey: "test-token",
        fetchFn: restFetch,
      }),
  });
  const client = new Client({ name: "review-regression-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    for (const key of ["docs/report#1.txt", "docs/query?x=1.txt", "docs/percent%23 ü.txt"]) {
      const written = await client.callTool({
        name: "storage_write_file",
        arguments: { bucket: "mcp-http-bucket", key, content: "round trip" },
      });
      assert.notEqual(written.isError, true);
      const read = await client.callTool({
        name: "storage_read_file",
        arguments: { bucket: "mcp-http-bucket", key },
      });
      assert.notEqual(read.isError, true);
      const content = read.content as { text: string }[];
      assert.deepEqual(JSON.parse(content[0].text), { ok: true, key, content: "round trip" });
    }
    const badOrigin = await handleMcpHttp(
      new Request(`${endpoint}/api/agent/v1/mcp`, {
        method: "POST",
        headers: { origin: "https://untrusted.example" },
      }),
      { endpoint, agentKey: "test-token" },
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(
      (
        await handleMcpHttp(new Request(`${endpoint}/api/agent/v1/mcp`), {
          endpoint,
          agentKey: "test-token",
        })
      ).status,
      405,
    );
  } finally {
    await client.close();
  }
});

test("artifacts get unique buckets and their own TTL; creation errors prevent uploads", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = new MiddleOutMcpServer({
    endpoint: "http://localhost",
    agentKey: "test",
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init!.body));
      requests.push({ path, body });
      return path.endsWith("scratch-buckets")
        ? Response.json({ bucket: { name: body.name } })
        : Response.json({ ok: true });
    },
  });
  await server.executeTool("storage_upload_artifact", {
    name: "one.txt",
    content: "one",
    ttl_hours: 0.5,
  });
  await server.executeTool("storage_upload_artifact", {
    name: "two.txt",
    content: "two",
    ttl_hours: 24,
  });
  assert.notEqual(requests[0].body.name, requests[2].body.name);
  assert.equal(requests[0].body.ttl, 1800);
  assert.equal(requests[2].body.ttl, 86400);
  assert.equal(requests[1].body.bucket, requests[0].body.name);
  let called = 0;
  const failing = new MiddleOutMcpServer({
    endpoint: "http://localhost",
    agentKey: "test",
    fetchFn: async () => {
      called++;
      return new Response("scope denied", { status: 403 });
    },
  });
  await assert.rejects(
    failing.executeTool("storage_upload_artifact", { name: "blocked", content: "data" }),
    /Failed to create scratch bucket: 403/,
  );
  assert.equal(called, 1);
  await assert.rejects(
    server.executeTool("storage_upload_artifact", { name: "invalid", ttl_hours: Infinity }),
    /ttl_hours/,
  );
});

test("MCP file listing uses folder prefixes and forwards pagination cursors", async () => {
  let url: URL | undefined;
  const server = new MiddleOutMcpServer({
    endpoint: "http://localhost",
    agentKey: "test",
    fetchFn: async (input) => {
      url = new URL(String(input));
      return Response.json({ ok: true });
    },
  });
  await server.executeTool("storage_list_files", {
    bucket: "test-bucket",
    prefix: "Docs/",
    cursor: "Docs/last#1.txt",
  });
  assert.equal(url!.pathname, "/api/agent/v1/files");
  assert.equal(url!.searchParams.get("prefix"), "Docs/");
  assert.equal(url!.searchParams.get("cursor"), "Docs/last#1.txt");
});
