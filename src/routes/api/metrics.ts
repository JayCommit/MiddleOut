import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/metrics")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { getSystemMetrics } = await import("@/lib/storage/queries.server");
          const m = await getSystemMetrics();
          const mem = typeof process !== "undefined" ? process.memoryUsage() : { rss: 0, heapUsed: 0 };
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
