/**
 * server.mjs — MCP server factory.
 * Assembles all tool domains onto a single McpServer instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { registerDeployTools }  from "./tools/deploy.mjs";
import { registerUpgradeTools } from "./tools/upgrade.mjs";
import { registerObserveTools } from "./tools/observe.mjs";
import { registerManageTools }  from "./tools/manage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMcpServer() {
  const server = new McpServer({ name: "commvault-k8s", version: "1.0.0" });

  // ── SKILL resource ──────────────────────────────────────────────────────────
  server.resource("skill-context", "commvault://skill", async (uri) => {
    const skillPath = path.resolve(__dirname, "..", "..", "SKILL.md");
    const text = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf-8") : "Skill context not available.";
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  });

  registerDeployTools(server);
  registerUpgradeTools(server);
  registerObserveTools(server);
  registerManageTools(server);

  return server;
}
