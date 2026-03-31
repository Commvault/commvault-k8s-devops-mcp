/**
 * logger.mjs — structured JSON logger.
 * All application log output goes through this module.
 * Output target is stderr (keeps it separate from MCP stdio transport stdout).
 */

const LEVEL_MAP = { debug: 10, info: 20, warn: 30, error: 40 };
// In stdio mode VS Code's MCP panel marks all stderr output as [warning]
// regardless of content, so we raise the floor to warn to suppress info/debug
// noise. Errors and genuine warnings still surface. Override with LOG_LEVEL.
const IS_STDIO   = (process.env.MCP_TRANSPORT || "http").toLowerCase() === "stdio";
const MIN_LEVEL  = LEVEL_MAP[process.env.LOG_LEVEL?.toLowerCase()] ??
                   (IS_STDIO ? LEVEL_MAP.warn : LEVEL_MAP.info);

function write(level, msg, extra = {}) {
  if (LEVEL_MAP[level] < MIN_LEVEL) return;
  const entry = {
    ts:    new Date().toISOString(),
    level,
    svc:   "commvault-mcp",
    msg,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg, extra) => write("debug", msg, extra),
  info:  (msg, extra) => write("info",  msg, extra),
  warn:  (msg, extra) => write("warn",  msg, extra),
  error: (msg, extra) => write("error", msg, extra),
};
