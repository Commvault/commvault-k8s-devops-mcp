#!/usr/bin/env node
/**
 * index.mjs — application entry point.
 *
 * Selects transport (stdio or HTTP) based on MCP_TRANSPORT env var
 * and starts the server.
 */

import path from "path";
import { fileURLToPath } from "url";
import { MCP_TRANSPORT } from "./src/config.mjs";
import { createMcpServer } from "./src/server.mjs";
import { ensureHelmRepo, validateKubectlContext } from "./src/exec.mjs";
import { logger } from "./src/logger.mjs";

const __filename = fileURLToPath(import.meta.url);

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  // Validate kubectl context on startup
  const kubectlCheck = validateKubectlContext();
  if (!kubectlCheck.hasContext) {
    logger.error("kubectl context validation failed", { error: kubectlCheck.error });
    logger.error("MCP server requires a valid kubectl context to function.");
    logger.error("Fix the issue and restart the server.");
    if (MCP_TRANSPORT !== "stdio") {
      // In HTTP mode, log but continue (tools will return errors)
      logger.warn("Server starting anyway - MCP tools will return errors until kubectl is configured");
    } else {
      // In stdio mode, exit immediately
      process.exit(1);
    }
  } else if (kubectlCheck.error) {
    logger.warn("kubectl context issue", { context: kubectlCheck.context, error: kubectlCheck.error });
  }
  
  if (MCP_TRANSPORT === "stdio") {
    // ── stdio transport (local dev / Claude Desktop / Cursor) ─────────────────
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server    = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    setImmediate(() => ensureHelmRepo());
    logger.info("MCP server running (stdio)");
  } else {
    // ── HTTP transport (Docker / Kubernetes) ──────────────────────────────────
    const { startHttpServer } = await import("./src/http.mjs");
    startHttpServer(() => setImmediate(() => ensureHelmRepo()));
  }
}

// Exports for testing
export { createMcpServer } from "./src/server.mjs";
export { runCommand, formatResult, ensureHelmRepo, __setExecImpl } from "./src/exec.mjs";
export { assertNamespaceAllowed } from "./src/exec.mjs";
export { HELM_REPO_NAME, HELM_REPO_URL, DEFAULT_NAMESPACE, PROTECTED_NAMESPACES } from "./src/config.mjs";
