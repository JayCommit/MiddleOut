import { createFileRoute } from "@tanstack/react-router";
import { auth, bootstrapReady } from "@/lib/auth/server";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => { await bootstrapReady; return auth.handler(request); },
      POST: async ({ request }) => { await bootstrapReady; return auth.handler(request); },
    },
  },
});
