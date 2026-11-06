import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentBearer } from "@/lib/storage/agents.server";
import { handleMcpHttp } from "@/lib/mcp/http.server";

async function handle(request: Request) {
  const header = request.headers.get("authorization");
  if (!(await authenticateAgentBearer(header))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return handleMcpHttp(request, {
    endpoint: process.env.BETTER_AUTH_URL || "http://localhost:8080",
    agentKey: header!.replace(/^Bearer\s+/i, ""),
  });
}

export const Route = createFileRoute("/api/agent/v1/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
  },
});
