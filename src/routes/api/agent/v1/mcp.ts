import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgentRequest } from "@/lib/storage/agents.server";
import { MiddleOutMcpServer } from "@/lib/mcp/server";

export const Route = createFileRoute("/api/agent/v1/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: { id?: string | number; method?: string; params?: Record<string, unknown> } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            { status: 400 },
          );
        }

        const server = new MiddleOutMcpServer({
          endpoint: new URL(request.url).origin,
          agentKey: request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "",
        });

        const response = await server.handleMessage(body);
        return Response.json(response ?? { jsonrpc: "2.0", id: body.id, result: {} });
      },
      GET: async ({ request }) => {
        // SSE transport capability
        const auth = await authenticateAgentRequest(request);
        if (!auth) {
          return new Response("Unauthorized", { status: 401 });
        }

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `event: endpoint\ndata: ${JSON.stringify({ endpoint: "/api/agent/v1/mcp" })}\n\n`,
              ),
            );
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
