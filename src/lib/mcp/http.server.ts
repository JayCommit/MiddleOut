import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MiddleOutMcpServer, MCP_TOOLS, type McpServerConfig } from "./server.ts";

/** Stateless Streamable HTTP: authentication is checked anew for every request. */
export async function handleMcpHttp(request: Request, config: McpServerConfig): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(config.endpoint).origin) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const tools = new MiddleOutMcpServer(config);
  const server = new Server(
    { name: "middleout-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await tools.executeTool(params.name, params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    // JSON response mode resolves only after the request's tool handler completes.
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
