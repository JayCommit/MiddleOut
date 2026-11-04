import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/metrics")({
  server: {
    handlers: {
      GET: () =>
        new Response("# HELP middleout_up Middle Out is serving.\n# TYPE middleout_up gauge\nmiddleout_up 1\n", {
          headers: { "content-type": "text/plain; version=0.0.4" },
        }),
    },
  },
});
