import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/.well-known/llms.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `# Middle Out

Self-hosted S3-compatible object storage with scoped agent access.

- OpenAPI: /api/agent/v1/openapi.json
- MCP (Streamable HTTP): /api/agent/v1/mcp
- Authentication: Authorization: Bearer <agent token>
- Search: GET /api/agent/v1/search?q=<query>&bucket=<optional bucket>
- Folder listing: GET /api/agent/v1/files?bucket=<bucket>&prefix=<prefix>&cursor=<nextStart>
- Scratch buckets: POST /api/agent/v1/scratch-buckets
- Upload: POST /api/agent/v1/upload

Create agent tokens in the console under AI & Agents. Permissions and bucket scopes apply to every request.
`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        ),
    },
  },
});
