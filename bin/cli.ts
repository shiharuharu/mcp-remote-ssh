#!/usr/bin/env node
/**
 * cli.ts — MCP stdio entry point
 *
 * Minimal entry point that starts the mcp-remote-ssh MCP server.
 * All manager instantiation and tool registration happens inside
 * transport.startServer().
 */

import { startServer } from "../src/gateway/transport.js";

startServer().catch((err) => {
  console.error("mcp-remote-ssh: fatal startup error", err);
  process.exit(1);
});
