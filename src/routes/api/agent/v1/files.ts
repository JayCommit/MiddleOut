import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { browse } from "@/lib/storage/queries.server";

export const Route = createFileRoute("/api/agent/v1/files")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        const url = new URL(request.url);
        const bucket = url.searchParams.get("bucket") || "";
        if (!canAgentAccessBucket(auth.bucketScope, bucket, "read", auth.permissions)) {
          return Response.json({ ok: false, error: "Access denied" }, { status: 403 });
        }
        const result = await browse(
          auth.ownerId,
          bucket,
          url.searchParams.get("prefix") || "",
          url.searchParams.get("cursor") || "",
        );
        return Response.json(result, { status: result.ok ? 200 : 400 });
      },
    },
  },
});
