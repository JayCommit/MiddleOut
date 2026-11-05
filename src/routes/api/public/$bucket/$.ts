import { objectResponseHeaders } from "@/lib/storage/response-headers";
import { checkRateLimit } from "@/lib/rate-limiter";
import { transportAddress } from "@/lib/s3/body";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/$bucket/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const limit = checkRateLimit(`public:${transportAddress(request)}`, 180, 30);
        if (!limit.allowed) {
          return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(limit.retryAfter) },
          });
        }
        const { readPublicObject } = await import("@/lib/storage/queries.server");
        const key = decodeKey(params._splat ?? "");
        const object = await readPublicObject(params.bucket, key);
        if (!object) return new Response("Not found", { status: 404 });
        const url = new URL(request.url);
        const download = url.searchParams.has("download");
        const headers = new Headers({
          "content-type": object.contentType || "application/octet-stream",
          "content-length": String(object.bytes.length),
          etag: `"${object.etag}"`,
          "cache-control": "public, max-age=60",
        });
        for (const [name, value] of Object.entries(object.headers)) headers.set(name, value);
        objectResponseHeaders(headers, object.key, download);
        return new Response(new Uint8Array(object.bytes), { headers });
      },
    },
  },
});

function decodeKey(splat: string) {
  return splat
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}
