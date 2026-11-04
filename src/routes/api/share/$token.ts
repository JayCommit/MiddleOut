import { objectResponseHeaders } from "@/lib/storage/response-headers";
import { checkRateLimit } from "@/lib/rate-limiter";
import { transportAddress } from "@/lib/s3/body";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/share/$token")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const limit = checkRateLimit(`share:${transportAddress(request)}`, 60, 10);
        if (!limit.allowed) {
          return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(limit.retryAfter) },
          });
        }
        const { readShare } = await import("@/lib/storage/queries.server");
        const object = await readShare(params.token);
        if (!object) return new Response("Link expired or not found", { status: 404 });
        const filename = object.key.split("/").filter(Boolean).pop() ?? "download";
        return new Response(new Uint8Array(object.bytes), {
          headers: objectResponseHeaders(
            new Headers({
              "content-type": object.contentType || "application/octet-stream",
              "content-length": String(object.bytes.length),
              etag: `"${object.etag}"`,
            }),
            filename,
            true,
          ),
        });
      },
    },
  },
});
