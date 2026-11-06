import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agent/v1/openapi.json")({
  server: {
    handlers: {
      GET: async () => {
        const spec = {
          openapi: "3.1.0",
          info: {
            title: "MiddleOut AI Agent & Object Storage API",
            description:
              "Lightweight, agent-first JSON storage endpoints and scratchpad artifact storage for autonomous AI workflows.",
            version: "0.2.0",
          },
          servers: [{ url: "/api/agent/v1" }],
          components: {
            securitySchemes: {
              AgentBearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "mo_agent_*",
                description:
                  "Bearer authentication using a scoped MiddleOut agent token (starts with mo_agent_live_)",
              },
            },
          },
          security: [{ AgentBearerAuth: [] }],
          paths: {
            "/files": {
              get: {
                summary: "Browse files and folders with pagination",
                operationId: "listFiles",
                parameters: [
                  { name: "bucket", in: "query", required: true, schema: { type: "string" } },
                  { name: "prefix", in: "query", schema: { type: "string" } },
                  {
                    name: "cursor",
                    in: "query",
                    description: "nextStart returned by the previous page",
                    schema: { type: "string" },
                  },
                ],
                responses: { "200": { description: "Objects, folders, truncated, and nextStart" } },
              },
            },
            "/scratch-buckets": {
              post: {
                summary: "Create Ephemeral Scratch Bucket",
                description:
                  "Creates an auto-expiring temporary scratch bucket for benchmarking, test runs, or agent task artifacts.",
                operationId: "createScratchBucket",
                requestBody: {
                  required: false,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          name: {
                            type: "string",
                            description:
                              "Optional bucket name. If omitted, a unique scratch name is generated.",
                          },
                          ttl: {
                            type: "string",
                            description:
                              "TTL before bucket and files are purged. E.g. '30m', '2h', '1d', '7d'. Defaults to '2h'.",
                          },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Scratch bucket created successfully.",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            ok: { type: "boolean" },
                            bucket: {
                              type: "object",
                              properties: {
                                name: { type: "string" },
                                isScratch: { type: "boolean" },
                                expiresAt: { type: "string", format: "date-time" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/buckets": {
              get: {
                summary: "List Accessible Buckets",
                description:
                  "Lists all storage buckets the authenticated agent is authorized to access.",
                operationId: "listBuckets",
                responses: {
                  "200": {
                    description: "List of buckets and quotas.",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            ok: { type: "boolean" },
                            buckets: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  name: { type: "string" },
                                  provider: { type: "string" },
                                  isScratch: { type: "boolean" },
                                  expiresAt: { type: "string", nullable: true },
                                  objectCount: { type: "integer" },
                                  bytes: { type: "integer" },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/upload": {
              post: {
                summary: "Upload Object or Artifact",
                description:
                  "Uploads a text, code, or binary artifact directly. Accepts multipart/form-data or JSON payload.",
                operationId: "uploadObject",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["bucket", "key", "content"],
                        properties: {
                          bucket: { type: "string" },
                          key: { type: "string" },
                          content: {
                            type: "string",
                            description: "File content (UTF-8 text or Base64 encoded string)",
                          },
                          contentType: {
                            type: "string",
                            description: "MIME type, e.g. text/plain, application/json, image/png",
                          },
                          isBase64: { type: "boolean", default: false },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Object uploaded successfully.",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            ok: { type: "boolean" },
                            bucket: { type: "string" },
                            key: { type: "string" },
                            size: { type: "integer" },
                            etag: { type: "string" },
                            shareUrl: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/objects/{bucket}/{key}": {
              get: {
                summary: "Read Stored Object",
                description:
                  "Downloads an object. Returns raw binary/stream by default, or JSON metadata if requested.",
                operationId: "readObject",
                parameters: [
                  { name: "bucket", in: "path", required: true, schema: { type: "string" } },
                  { name: "key", in: "path", required: true, schema: { type: "string" } },
                  {
                    name: "format",
                    in: "query",
                    schema: { type: "string", enum: ["raw", "json"] },
                  },
                ],
                responses: {
                  "200": { description: "Object contents" },
                  "404": { description: "Object or bucket not found" },
                },
              },
              delete: {
                summary: "Delete Stored Object",
                description: "Deletes an object from the specified bucket.",
                operationId: "deleteObject",
                parameters: [
                  { name: "bucket", in: "path", required: true, schema: { type: "string" } },
                  { name: "key", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                  "200": { description: "Object deleted" },
                },
              },
            },
            "/search": {
              get: {
                summary: "Search Objects Across Buckets",
                description: "Finds files matching prefix, substring, or file extension.",
                operationId: "searchObjects",
                parameters: [
                  { name: "q", in: "query", required: true, schema: { type: "string" } },
                  { name: "bucket", in: "query", schema: { type: "string" } },
                ],
                responses: {
                  "200": {
                    description: "List of matching files.",
                  },
                },
              },
            },
            "/share": {
              post: {
                summary: "Generate Instant Share Link",
                description: "Generates an unauthenticated public link for sharing artifacts.",
                operationId: "getShareLink",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["bucket", "key"],
                        properties: {
                          bucket: { type: "string" },
                          key: { type: "string" },
                          expiresIn: {
                            type: "integer",
                            description: "Link validity duration in seconds (e.g. 3600 for 1h)",
                          },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Share link generated.",
                  },
                },
              },
            },
          },
        };

        return Response.json(spec, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
