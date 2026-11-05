import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { readObjectFor, removeObject } from "@/lib/storage/queries.server";
import { objectResponseHeaders } from "@/lib/storage/response-headers";

export const Route = createFileRoute("/api/agent/v1/objects/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const splat = params._splat || "";
        const parts = splat.split("/").filter(Boolean);
        if (parts.length < 2) {
          return Response.json(
            { ok: false, error: "Invalid path. Expected /objects/:bucket/:key" },
            { status: 400 },
          );
        }

        const bucket = parts[0]!;
        const key = parts.slice(1).join("/");

        if (!canAgentAccessBucket(auth.bucketScope, bucket, "read", auth.permissions)) {
          return Response.json(
            { ok: false, error: `Agent token is not authorized for bucket '${bucket}'.` },
            { status: 403 },
          );
        }

        const result = await readObjectFor(auth.ownerId, bucket, key);
        if ("error" in result) {
          const status = result.error === "NoSuchKey" || result.error === "NoSuchBucket" ? 404 : 403;
          return Response.json({ ok: false, error: result.error }, { status });
        }

        const url = new URL(request.url);
        const formatJson =
          url.searchParams.get("format") === "json" ||
          request.headers.get("accept")?.includes("application/json");

        if (formatJson) {
          const isText =
            result.object.contentType.startsWith("text/") ||
            result.object.contentType.includes("json") ||
            result.object.contentType.includes("xml") ||
            result.object.contentType.includes("markdown");

          return Response.json({
            ok: true,
            bucket,
            key: result.object.key,
            size: result.object.size,
            contentType: result.object.contentType,
            etag: result.object.etag,
            updatedAt: result.object.updatedAt,
            isText,
            content: isText
              ? result.object.bytes.toString("utf8")
              : result.object.bytes.toString("base64"),
          });
        }

        const filename = key.split("/").pop() || "download";
        return new Response(new Uint8Array(result.object.bytes), {
          headers: objectResponseHeaders(
            new Headers({
              "content-type": result.object.contentType || "application/octet-stream",
              "content-length": String(result.object.bytes.length),
              etag: `"${result.object.etag}"`,
            }),
            filename,
            false,
          ),
        });
      },
      DELETE: async ({ params, request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const splat = params._splat || "";
        const parts = splat.split("/").filter(Boolean);
        if (parts.length < 2) {
          return Response.json(
            { ok: false, error: "Invalid path. Expected /objects/:bucket/:key" },
            { status: 400 },
          );
        }

        const bucket = parts[0]!;
        const key = parts.slice(1).join("/");

        if (!canAgentAccessBucket(auth.bucketScope, bucket, "write", auth.permissions)) {
          return Response.json(
            { ok: false, error: `Agent token is not authorized to delete from bucket '${bucket}'.` },
            { status: 403 },
          );
        }

        const result = await removeObject(auth.ownerId, bucket, key);
        if (!result.ok) {
          return Response.json({ ok: false, error: result.error }, { status: 400 });
        }

        return Response.json({ ok: true, bucket, key, deleted: true });
      },
    },
  },
});
