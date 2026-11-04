import { createFileRoute } from "@tanstack/react-router";

async function dispatch({ request }: { request: Request }) {
  const { handleS3 } = await import("@/lib/s3/engine.server");
  return handleS3(request);
}

export const Route = createFileRoute("/api/s3/$")({
  server: {
    handlers: {
      GET: dispatch,
      PUT: dispatch,
      POST: dispatch,
      DELETE: dispatch,
      HEAD: dispatch,
      OPTIONS: dispatch,
    },
  },
});
