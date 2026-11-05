import * as readline from "node:readline";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "storage_list_buckets",
    description: "List all accessible buckets in MiddleOut, including Google Drive mounts, ephemeral scratch buckets, object counts, and account quota.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "storage_list_files",
    description: "Browse files and directories within a specified MiddleOut bucket under an optional prefix.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "The bucket name to browse" },
        prefix: { type: "string", description: "Optional directory prefix (e.g. 'logs/' or 'artifacts/')" },
      },
      required: ["bucket"],
    },
  },
  {
    name: "storage_read_file",
    description: "Read the contents of a file from MiddleOut storage. Auto-detects text vs binary data.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "Bucket name" },
        key: { type: "string", description: "Object key / path" },
      },
      required: ["bucket", "key"],
    },
  },
  {
    name: "storage_write_file",
    description: "Write text, markdown, code, or data directly to a MiddleOut bucket.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "Target bucket name" },
        key: { type: "string", description: "Destination file key / path" },
        content: { type: "string", description: "Text or Base64 content to write" },
        content_type: { type: "string", description: "Optional MIME type (defaults to auto-detection)" },
        is_base64: { type: "boolean", description: "Set to true if content is base64-encoded binary" },
      },
      required: ["bucket", "key", "content"],
    },
  },
  {
    name: "storage_upload_artifact",
    description: "Quick scratchpad artifact upload for agent dumps, test runs, or shared files. Automatically saves to a scratch bucket and returns an instant shareable URL.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename (e.g. 'benchmark-summary.json' or 'agent-log.md')" },
        content: { type: "string", description: "File content" },
        ttl_hours: { type: "number", description: "TTL in hours before auto-purge (defaults to 24)" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "storage_get_share_link",
    description: "Generate a public or presigned share link for an object with a custom expiration duration.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "Bucket name" },
        key: { type: "string", description: "Object key" },
        expires_in: { type: "number", description: "Link expiration time in seconds (e.g. 3600 for 1 hour)" },
      },
      required: ["bucket", "key"],
    },
  },
];

export interface McpServerConfig {
  endpoint: string;
  agentKey: string;
  fetchFn?: typeof fetch;
}

/**
 * MCP Server Implementation executing tools via MiddleOut Agent REST API.
 */
export class MiddleOutMcpServer {
  private endpoint: string;
  private agentKey: string;
  private fetchFn: typeof fetch;

  constructor(config: McpServerConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.agentKey = config.agentKey;
    this.fetchFn = config.fetchFn || fetch;
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.endpoint}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.agentKey}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    return this.fetchFn(url, { ...options, headers });
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "storage_list_buckets": {
        const res = await this.request("/api/agent/v1/buckets");
        if (!res.ok) throw new Error(`Failed to list buckets: ${res.status} ${await res.text()}`);
        return res.json();
      }

      case "storage_list_files": {
        const bucket = String(args.bucket || "");
        const prefix = String(args.prefix || "");
        const res = await this.request(`/api/agent/v1/search?bucket=${encodeURIComponent(bucket)}&q=${encodeURIComponent(prefix)}`);
        if (!res.ok) throw new Error(`Failed to list files: ${res.status} ${await res.text()}`);
        return res.json();
      }

      case "storage_read_file": {
        const bucket = String(args.bucket || "");
        const key = String(args.key || "");
        const res = await this.request(`/api/agent/v1/objects/${encodeURIComponent(bucket)}/${encodeURI(key)}?format=json`);
        if (!res.ok) throw new Error(`Failed to read file: ${res.status} ${await res.text()}`);
        return res.json();
      }

      case "storage_write_file": {
        const bucket = String(args.bucket || "");
        const key = String(args.key || "");
        const content = String(args.content || "");
        const contentType = args.content_type ? String(args.content_type) : undefined;
        const isBase64 = Boolean(args.is_base64);

        const res = await this.request("/api/agent/v1/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key, content, contentType, isBase64 }),
        });
        if (!res.ok) throw new Error(`Failed to write file: ${res.status} ${await res.text()}`);
        return res.json();
      }

      case "storage_upload_artifact": {
        const name = String(args.name || "artifact.txt");
        const content = String(args.content || "");
        const ttlHours = typeof args.ttl_hours === "number" ? args.ttl_hours : 24;

        // Use or create default scratch bucket
        const scratchRes = await this.request("/api/agent/v1/scratch-buckets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "agent-artifacts", ttl: `${ttlHours}h` }),
        });

        let targetBucket = "agent-artifacts";
        if (scratchRes.ok) {
          const scratchData = (await scratchRes.json()) as { bucket?: { name?: string } };
          if (scratchData.bucket?.name) targetBucket = scratchData.bucket.name;
        }

        const uploadRes = await this.request("/api/agent/v1/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bucket: targetBucket,
            key: name,
            content,
            ttlHours,
          }),
        });

        if (!uploadRes.ok) throw new Error(`Failed to upload artifact: ${uploadRes.status} ${await uploadRes.text()}`);
        return uploadRes.json();
      }

      case "storage_get_share_link": {
        const bucket = String(args.bucket || "");
        const key = String(args.key || "");
        const expiresIn = typeof args.expires_in === "number" ? args.expires_in : 3600;

        const res = await this.request("/api/agent/v1/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key, expiresIn }),
        });

        if (!res.ok) throw new Error(`Failed to generate share link: ${res.status} ${await res.text()}`);
        return res.json();
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Handle standard JSON-RPC 2.0 message according to MCP specification.
   */
  async handleMessage(message: { id?: string | number; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
    const { id, method, params } = message;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "middleout-mcp",
            version: "0.2.0",
          },
        },
      };
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    if (method === "tools/call") {
      const toolName = String(params?.name || "");
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await this.executeTool(toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err: unknown) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          },
        };
      }
    }

    if (id !== undefined) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    }

    return null;
  }

  /**
   * Run stdio JSON-RPC loop.
   */
  startStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const message = JSON.parse(trimmed) as { id?: string | number; method?: string; params?: Record<string, unknown> };
        const response = await this.handleMessage(message);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch (err: unknown) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: " + (err instanceof Error ? err.message : String(err)) },
          }) + "\n",
        );
      }
    });
  }
}
