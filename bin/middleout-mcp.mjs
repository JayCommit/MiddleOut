#!/usr/bin/env node

/**
 * MiddleOut Native Model Context Protocol (MCP) Server CLI.
 *
 * Can be run directly via:
 *   npx @middleout/mcp-server
 * or
 *   middleout-mcp
 * or
 *   node bin/middleout-mcp.mjs
 *
 * Environment variables:
 *   MIDDLEOUT_ENDPOINT: URL of the MiddleOut server (defaults to http://localhost:8080)
 *   MIDDLEOUT_AGENT_KEY: Scoped Agent Token (starts with mo_agent_live_...)
 */

import { MiddleOutMcpServer } from "../src/lib/mcp/server.ts";

const endpoint = process.env.MIDDLEOUT_ENDPOINT || "http://localhost:8080";
const agentKey = process.env.MIDDLEOUT_AGENT_KEY || "";

if (!agentKey) {
  process.stderr.write(
    "[middleout-mcp] Warning: MIDDLEOUT_AGENT_KEY environment variable is not set.\n" +
      "Set MIDDLEOUT_AGENT_KEY to a valid agent token generated in MiddleOut Console under 'AI & Agents'.\n",
  );
}

const server = new MiddleOutMcpServer({
  endpoint,
  agentKey,
});

server.startStdio();
