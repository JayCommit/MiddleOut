import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { overview } from "@/lib/storage/queries.server";

import { searchBucket } from "@/lib/storage/search.server";

export const Route = createFileRoute("/api/agent/v1/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        const targetBucket = url.searchParams.get("bucket")?.trim();

        const ov = await overview(auth.ownerId);
        const bucketsToSearch = ov.buckets.filter((b) => {
          if (targetBucket && b.name !== targetBucket) return false;
          return canAgentAccessBucket(auth.bucketScope, b.name, "read", auth.permissions);
        });

        const results: {
          bucket: string;
          key: string;
          size: number;
          etag: string;
          updatedAt: string;
        }[] = [];

        for (const b of bucketsToSearch) {
          try {
            results.push(...(await searchBucket(auth.ownerId, b.name, q)));
          } catch {
            return Response.json(
              { ok: false, error: `Unable to search bucket '${b.name}'.` },
              { status: 502 },
            );
          }
        }

        return Response.json({
          ok: true,
          query: q,
          count: results.length,
          results,
        });
      },
    },
  },
});
