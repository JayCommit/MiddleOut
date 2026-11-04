import { createFileRoute } from "@tanstack/react-router";
import { auth, bootstrapReady } from "@/lib/auth/server";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await bootstrapReady;
        if (new URL(request.url).pathname.endsWith("/node-config"))
          return Response.json({ registrationEnabled: process.env.ALLOW_SIGN_UP === "true" });
        return auth.handler(request);
      },
      POST: async ({ request }) => {
        await bootstrapReady;
        return auth.handler(request);
      },
    },
  },
});
