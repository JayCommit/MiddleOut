import { createFileRoute } from "@tanstack/react-router";
import { checkRateLimit } from "@/lib/rate-limiter";
import { transportAddress } from "@/lib/s3/body";

export const Route = createFileRoute("/api/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = process.env.METRICS_TOKEN;
        if (!token || token.length < 32) return new Response("Metrics disabled", { status: 404 });
        const limit = checkRateLimit(`metrics:${transportAddress(request)}`, 30, 5);
        if (!limit.allowed) {
          return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(limit.retryAfter) },
          });
        }
        const { createHash, timingSafeEqual } = await import("node:crypto");
        const rawAuth = request.headers.get("authorization") || "";
        const expectedRaw = `Bearer ${token}`;
        const supplied = createHash("sha256").update(rawAuth).digest();
        const expected = createHash("sha256").update(expectedRaw).digest();
        if (!timingSafeEqual(supplied, expected) || rawAuth.length !== expectedRaw.length)
          return new Response("Unauthorized", { status: 401 });
        try {
          const { getSystemMetrics } = await import("@/lib/storage/queries.server");
          const m = await getSystemMetrics();
          const mem =
            typeof process !== "undefined" ? process.memoryUsage() : { rss: 0, heapUsed: 0 };
          const uptime = typeof process !== "undefined" ? Math.floor(process.uptime()) : 0;

          const lines = [
            "# HELP middleout_up Middle Out is serving.",
            "# TYPE middleout_up gauge",
            "middleout_up 1",
            "",
            "# HELP middleout_buckets_total Total number of buckets across the node.",
            "# TYPE middleout_buckets_total gauge",
            `middleout_buckets_total ${m.totalBuckets}`,
            "",
            "# HELP middleout_objects_total Total number of stored objects.",
            "# TYPE middleout_objects_total gauge",
            `middleout_objects_total ${m.totalObjects}`,
            "",
            "# HELP middleout_storage_bytes Total storage bytes used across all objects.",
            "# TYPE middleout_storage_bytes gauge",
            `middleout_storage_bytes ${m.totalBytes}`,
            "",
            "# HELP middleout_access_keys_total Total active access keys.",
            "# TYPE middleout_access_keys_total gauge",
            `middleout_access_keys_total ${m.totalKeys}`,
            "",
            "# HELP process_uptime_seconds Node process uptime in seconds.",
            "# TYPE process_uptime_seconds gauge",
            `process_uptime_seconds ${uptime}`,
            "",
            "# HELP process_resident_memory_bytes Resident memory size in bytes.",
            "# TYPE process_resident_memory_bytes gauge",
            `process_resident_memory_bytes ${mem.rss}`,
            "",
          ];

          return new Response(lines.join("\n"), {
            headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
          });
        } catch {
          return new Response(
            "# HELP middleout_up Middle Out is serving.\n# TYPE middleout_up gauge\nmiddleout_up 0\n",
            {
              status: 503,
              headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
            },
          );
        }
      },
    },
  },
});
