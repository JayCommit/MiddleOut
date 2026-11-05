import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { putBytes, createLink } from "@/lib/storage/queries.server";
import { guessType } from "@/lib/storage/pure";

export const Route = createFileRoute("/api/agent/v1/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let bucket = "";
        let key = "";
        let bytes: Buffer | null = null;
        let contentType = "application/octet-stream";
        let ttlHours = 24;

        const contentTypeHeader = request.headers.get("content-type") || "";

        if (contentTypeHeader.includes("multipart/form-data")) {
          const form = await request.formData();
          bucket = String(form.get("bucket") || "").trim();
          key = String(form.get("key") || "").trim();
          const file = form.get("file");
          if (file instanceof File) {
            if (!key) key = file.name;
            contentType = file.type || guessType(key);
            const arrayBuffer = await file.arrayBuffer();
            bytes = Buffer.from(arrayBuffer);
          } else if (typeof file === "string") {
            bytes = Buffer.from(file);
          }
          if (form.has("ttlHours")) {
            ttlHours = Number(form.get("ttlHours")) || 24;
          }
        } else {
          // JSON payload
          let body: {
            bucket?: string;
            key?: string;
            content?: string;
            contentType?: string;
            isBase64?: boolean;
            ttlHours?: number;
          } = {};
          try {
            body = (await request.json()) as typeof body;
          } catch {
            return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
          }

          bucket = String(body.bucket || "").trim();
          key = String(body.key || "").trim();
          contentType = body.contentType || guessType(key);
          if (typeof body.ttlHours === "number") {
            ttlHours = body.ttlHours;
          }

          if (typeof body.content === "string") {
            bytes = body.isBase64
              ? Buffer.from(body.content, "base64")
              : Buffer.from(body.content, "utf8");
          }
        }

        if (!bucket || !key || !bytes) {
          return Response.json(
            { ok: false, error: "Missing required fields: bucket, key, and content/file." },
            { status: 400 },
          );
        }

        if (!canAgentAccessBucket(auth.bucketScope, bucket, "write", auth.permissions)) {
          return Response.json(
            { ok: false, error: `Agent token is not authorized to write to bucket '${bucket}'.` },
            { status: 403 },
          );
        }

        const putResult = await putBytes(
          auth.ownerId,
          bucket,
          key,
          bytes,
          contentType,
          {},
          "private",
        );

        if (!putResult.ok) {
          return Response.json({ ok: false, error: putResult.error }, { status: 400 });
        }

        // Generate instant share link
        let shareUrl: string | null = null;
        try {
          const shareDuration = Math.max(300, Math.min(ttlHours * 3600, 30 * 86400));
          const link = await createLink(auth.ownerId, bucket, key, shareDuration);
          if (link.ok && link.token) {
            shareUrl = `/api/share/${link.token}`;
          }
        } catch {
          // If share generation fails (e.g. gdrive without DB obj), ignore
        }

        return Response.json({
          ok: true,
          bucket,
          key,
          size: bytes.length,
          etag: putResult.etag,
          contentType,
          shareUrl,
        });
      },
    },
  },
});
