import { createFileRoute } from "@tanstack/react-router";
import { randomBytes } from "node:crypto";
import { authenticateAgentRequest, canAgentAccessBucket } from "@/lib/storage/agents.server";
import { createBucket } from "@/lib/storage/queries.server";

function parseTtlSeconds(ttlStr?: string | number): number {
  if (typeof ttlStr === "number" && ttlStr > 0) return Math.min(ttlStr, 30 * 86400);
  if (!ttlStr || typeof ttlStr !== "string") return 7200; // default 2 hours

  const trimmed = ttlStr.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(s|m|h|d|w)?$/);
  if (!match) return 7200;

  const val = parseInt(match[1]!, 10);
  const unit = match[2] || "s";
  let multiplier = 1;
  if (unit === "m") multiplier = 60;
  else if (unit === "h") multiplier = 3600;
  else if (unit === "d") multiplier = 86400;
  else if (unit === "w") multiplier = 7 * 86400;

  return Math.min(val * multiplier, 30 * 86400); // capped at 30 days
}

export const Route = createFileRoute("/api/agent/v1/scratch-buckets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: { name?: string; ttl?: string | number } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }

        const rawName = body.name?.trim() || `scratch-${randomBytes(4).toString("hex")}`;
        const ttlSeconds = parseTtlSeconds(body.ttl);

        if (!canAgentAccessBucket(auth.bucketScope, rawName, "write", auth.permissions)) {
          return Response.json(
            { ok: false, error: `Agent token is not authorized for bucket '${rawName}'.` },
            { status: 403 },
          );
        }

        const result = await createBucket(auth.ownerId, rawName, "private", {
          isScratch: true,
          ttlSeconds,
        });

        if (!result.ok) {
          return Response.json({ ok: false, error: result.error }, { status: 400 });
        }

        return Response.json({
          ok: true,
          bucket: {
            name: result.name,
            isScratch: true,
            expiresAt: result.expiresAt,
            ttlSeconds,
          },
        });
      },
    },
  },
});
