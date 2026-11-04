import { createFileRoute } from "@tanstack/react-router";
import { auth, bootstrapReady } from "@/lib/auth/server";
import { assertSameSiteRequest, CrossSiteRequestError } from "@/lib/auth/isolation.server";
import { checkRateLimit } from "@/lib/rate-limiter";
import { transportAddress } from "@/lib/s3/body";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          assertSameSiteRequest(request);
        } catch (err) {
          if (err instanceof CrossSiteRequestError) {
            return new Response(err.message, { status: 403 });
          }
          throw err;
        }
        await bootstrapReady;
        if (new URL(request.url).pathname.endsWith("/node-config"))
          return Response.json({ registrationEnabled: process.env.ALLOW_SIGN_UP === "true" });
        return auth.handler(request);
      },
      POST: async ({ request }) => {
        try {
          assertSameSiteRequest(request);
        } catch (err) {
          if (err instanceof CrossSiteRequestError) {
            return new Response(err.message, { status: 403 });
          }
          throw err;
        }
        const limit = checkRateLimit(`auth:${transportAddress(request)}`, 30, 2);
        if (!limit.allowed) {
          return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(limit.retryAfter) },
          });
        }
        await bootstrapReady;
        return auth.handler(request);
      },
    },
  },
});
