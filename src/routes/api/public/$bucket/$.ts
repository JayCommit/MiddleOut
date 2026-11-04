import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/$bucket/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
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
        if (download) headers.set("content-disposition", `attachment; filename="${leaf(object.key)}"`);
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

function leaf(key: string) {
  const parts = key.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? "download").replace(/"/g, "");
}
