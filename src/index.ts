#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoworkClient, CoworkError } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const configuredUrl = process.env.COWORK_API_URL;
  const agentToken = process.env.COWORK_AGENT_TOKEN;
  if (!configuredUrl || !agentToken?.trim()) {
    throw new CoworkError("Set COWORK_API_URL and COWORK_AGENT_TOKEN before starting cowork-mcp.");
  }
  const url = URL.parse(configuredUrl);
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || !(url.protocol === "https:" || (local && url.protocol === "http:"))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CoworkError("COWORK_API_URL must be an HTTPS gateway origin. Loopback HTTP is allowed for local testing.");
  }

  const server = createServer(new CoworkClient(url, agentToken));
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof CoworkError ? error.message : "Could not start cowork-mcp.");
  process.exitCode = 1;
});
