import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  authenticateAgentBearer,
  canAgentAccessBucket,
} from "./agents.server.ts";
import {
  createBucket,
  overview,
  cleanupExpired,
  putBytes,
  readObjectFor,
} from "./queries.server.ts";
import { MiddleOutMcpServer, MCP_TOOLS } from "../mcp/server.ts";

test("AI Agents: token lifecycle and scoping enforcement", async () => {
  const ownerId = "agent-owner-1";

  // Create scoped token
  const tokenRecord = await createAgentToken(ownerId, {
    name: "Claude Code Worker",
    permissions: "read-write",
    bucketScope: "scratch-*,dataset-*",
    ttlDays: 7,
  });

  assert.ok(tokenRecord.token.startsWith("mo_agent_live_"));
  assert.equal(tokenRecord.name, "Claude Code Worker");
  assert.equal(tokenRecord.permissions, "read-write");
  assert.equal(tokenRecord.bucketScope, "scratch-*,dataset-*");

  // List tokens
  const list = await listAgentTokens(ownerId);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "Claude Code Worker");
  assert.match(list[0]?.maskedToken || "", /mo_agent_live_/);

  // Authenticate bearer
  const authSuccess = await authenticateAgentBearer(`Bearer ${tokenRecord.token}`);
  assert.ok(authSuccess);
  assert.equal(authSuccess.ownerId, ownerId);
  assert.equal(authSuccess.name, "Claude Code Worker");

  // Malformed or invalid bearer
  const authFail = await authenticateAgentBearer("Bearer mo_agent_invalid_token");
  assert.equal(authFail, null);

  // Bucket scope checks
  assert.equal(canAgentAccessBucket("scratch-*,dataset-*", "scratch-run-123", "read", "read-write"), true);
  assert.equal(canAgentAccessBucket("scratch-*,dataset-*", "dataset-images", "write", "read-write"), true);
  assert.equal(canAgentAccessBucket("scratch-*,dataset-*", "private-prod-db", "read", "read-write"), false);

  // Permission level checks
  assert.equal(canAgentAccessBucket("*", "any-bucket", "write", "read"), false); // read cannot write
  assert.equal(canAgentAccessBucket("*", "any-bucket", "read", "write"), false); // write cannot read
  assert.equal(canAgentAccessBucket("*", "any-bucket", "admin", "read-write"), false); // read-write cannot admin
  assert.equal(canAgentAccessBucket("*", "any-bucket", "admin", "admin"), true); // admin can admin

  // Revoke token
  await revokeAgentToken(ownerId, tokenRecord.id);
  const authAfterRevoke = await authenticateAgentBearer(`Bearer ${tokenRecord.token}`);
  assert.equal(authAfterRevoke, null);
});

test("AI Agents: ephemeral scratch buckets with auto-expiry TTL", async () => {
  const ownerId = "scratch-owner-1";
  const bucketName = `scratch-temp-${Date.now()}`;

  // Create scratch bucket with 1 second TTL for testing expiry
  const bucketRes = await createBucket(ownerId, bucketName, "private", {
    isScratch: true,
    ttlSeconds: 1,
  });

  assert.equal(bucketRes.ok, true);
  assert.equal(bucketRes.isScratch, true);
  assert.ok(bucketRes.expiresAt);

  // Upload an object into the scratch bucket
  await putBytes(
    ownerId,
    bucketName,
    "artifact.json",
    Buffer.from('{"status":"ok"}'),
    "application/json",
    {},
  );

  const readBefore = await readObjectFor(ownerId, bucketName, "artifact.json");
  assert.equal("error" in readBefore, false);

  // Wait 1.1s for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // Run cleanup routine
  await cleanupExpired(0);

  // Verify scratch bucket was purged automatically
  const readAfter = await readObjectFor(ownerId, bucketName, "artifact.json");
  assert.equal("error" in readAfter, true);
  assert.equal(readAfter.error, "NoSuchBucket");
});

test("MCP Server: tools list and JSON-RPC protocol compliance", async () => {
  assert.equal(MCP_TOOLS.length, 6);
  const toolNames = MCP_TOOLS.map((t) => t.name);
  assert.ok(toolNames.includes("storage_list_buckets"));
  assert.ok(toolNames.includes("storage_list_files"));
  assert.ok(toolNames.includes("storage_read_file"));
  assert.ok(toolNames.includes("storage_write_file"));
  assert.ok(toolNames.includes("storage_upload_artifact"));
  assert.ok(toolNames.includes("storage_get_share_link"));

  // Mock fetch to simulate MiddleOut API responses
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    if (urlStr.includes("/api/agent/v1/buckets")) {
      return Response.json({
        ok: true,
        buckets: [{ name: "agent-bucket", objectCount: 3, bytes: 1024, isScratch: false }],
        quota: 67108864,
      });
    }

    if (urlStr.includes("/api/agent/v1/upload")) {
      return Response.json({
        ok: true,
        bucket: "agent-bucket",
        key: "test.txt",
        size: 12,
        etag: "etag123",
        shareUrl: "http://localhost:8080/api/share/token123",
      });
    }

    if (urlStr.includes("/api/agent/v1/objects/")) {
      return Response.json({
        ok: true,
        bucket: "agent-bucket",
        key: "test.txt",
        size: 12,
        isText: true,
        content: "Hello agent!",
      });
    }

    return Response.json({ ok: true });
  };

  const mcp = new MiddleOutMcpServer({
    endpoint: "http://localhost:8080",
    agentKey: "mo_agent_live_test_key",
    fetchFn: mockFetch,
  });

  // Test initialize
  const initRes = await mcp.handleMessage({ id: 1, method: "initialize" });
  assert.equal(initRes?.id, 1);
  const initResult = initRes?.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(initResult?.protocolVersion, "2024-11-05");
  assert.equal(initResult?.serverInfo?.name, "middleout-mcp");

  // Test tools/list
  const toolsRes = await mcp.handleMessage({ id: 2, method: "tools/list" });
  assert.equal(toolsRes?.id, 2);
  const toolsResult = toolsRes?.result as { tools: Array<{ name: string }> };
  assert.equal(toolsResult?.tools?.length, 6);

  // Test tools/call: storage_list_buckets
  const callBuckets = await mcp.handleMessage({
    id: 3,
    method: "tools/call",
    params: { name: "storage_list_buckets", arguments: {} },
  });
  assert.equal(callBuckets?.id, 3);
  const callBucketsResult = callBuckets?.result as { content: Array<{ type: string; text: string }> };
  assert.match(callBucketsResult?.content[0]?.text || "", /agent-bucket/);

  // Test tools/call: storage_write_file
  const callWrite = await mcp.handleMessage({
    id: 4,
    method: "tools/call",
    params: {
      name: "storage_write_file",
      arguments: { bucket: "agent-bucket", key: "test.txt", content: "Hello agent!" },
    },
  });
  assert.equal(callWrite?.id, 4);
  const callWriteResult = callWrite?.result as { content: Array<{ type: string; text: string }> };
  assert.match(callWriteResult?.content[0]?.text || "", /etag123/);

  // Test tools/call: storage_read_file
  const callRead = await mcp.handleMessage({
    id: 5,
    method: "tools/call",
    params: {
      name: "storage_read_file",
      arguments: { bucket: "agent-bucket", key: "test.txt" },
    },
  });
  assert.equal(callRead?.id, 5);
  const callReadResult = callRead?.result as { content: Array<{ type: string; text: string }> };
  assert.match(callReadResult?.content[0]?.text || "", /Hello agent!/);
});
