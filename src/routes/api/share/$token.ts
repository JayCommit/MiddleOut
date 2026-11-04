import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/share/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { readShare } = await import("@/lib/storage/queries.server");
        const object = await readShare(params.token);
        if (!object) return new Response("Link expired or not found", { status: 404 });
        const filename = object.key.split("/").filter(Boolean).pop() ?? "download";
        return new Response(new Uint8Array(object.bytes), {
          headers: {
            "content-type": object.contentType || "application/octet-stream",
            "content-length": String(object.bytes.length),
            etag: `"${object.etag}"`,
            "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
          },
        });
      },
    },
  },
});
