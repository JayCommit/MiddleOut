import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { createLink } from "@/lib/storage/queries.server";

export const Route = createFileRoute("/api/agent/v1/share")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: { bucket?: string; key?: string; expiresIn?: number } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        const bucket = String(body.bucket || "").trim();
        const key = String(body.key || "").trim();
        const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : 3600;

        if (!bucket || !key) {
          return Response.json({ ok: false, error: "Bucket and key are required." }, { status: 400 });
        }

        if (!canAgentAccessBucket(auth.bucketScope, bucket, "read", auth.permissions)) {
          return Response.json(
            { ok: false, error: `Agent token is not authorized for bucket '${bucket}'.` },
            { status: 403 },
          );
        }

        const link = await createLink(auth.ownerId, bucket, key, expiresIn);
        if (!link.ok) {
          return Response.json({ ok: false, error: link.error }, { status: 400 });
        }

        return Response.json({
          ok: true,
          bucket,
          key,
          url: `/api/share/${link.token}`,
          token: link.token,
          expiresAt: link.expiresAt,
        });
      },
    },
  },
});
