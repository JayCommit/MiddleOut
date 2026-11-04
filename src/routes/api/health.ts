import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { ping } = await import("@/lib/storage/queries.server");
          await ping();
          return Response.json({ ok: true, service: "middleout" });
        } catch {
          return Response.json({ ok: false, service: "middleout" }, { status: 503 });
        }
      },
    },
  },
});
