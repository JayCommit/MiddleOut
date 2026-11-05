import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { overview } from "@/lib/storage/queries.server";

export const Route = createFileRoute("/api/agent/v1/buckets")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const data = await overview(auth.ownerId);
        const filtered = data.buckets.filter((b) =>
          canAgentAccessBucket(auth.bucketScope, b.name, "read", auth.permissions),
        );

        return Response.json({
          ok: true,
          buckets: filtered.map((b) => ({
            name: b.name,
            provider: b.provider,
            acl: b.acl,
            isPublic: b.isPublic,
            isScratch: b.isScratch,
            expiresAt: b.expiresAt,
            objectCount: b.objectCount,
            bytes: b.bytes,
            createdAt: b.createdAt,
          })),
          quota: data.quota,
        });
      },
    },
  },
});
