/**
 * tools/manage.mjs — MCP tools: add_disk, scale_components, uninstall_release,
 *                    helm_list, get_current_namespace, set_namespace, port_forward, run_kubectl
 */

import { z } from "zod";
import { chart, DEFAULT_NAMESPACE, MCP_TRANSPORT } from "../config.mjs";
import {
  runCommand, appendSetArg, formatResult, formatCommandForLog,
  redactCommandForLog, assertNamespaceAllowed, validateNamespaceExists,
  tokenizeCommand, parseNamespaceFlags, containsKubeconfigOverride,
} from "../exec.mjs";
import { tryCatchTool } from "../errors.mjs";
import { getSessionContext, setSessionContext } from "../http.mjs";

export function registerManageTools(server) {

  // ── add_disk ─────────────────────────────────────────────────────────────
  server.tool("add_disk",
    "Add a DDB/storage disk volume to a Commvault component. Chart is auto-detected from helm list. Appends at the next available volume index — existing volumes are never overwritten.",
    {
      releaseName: z.string().describe("Exact Helm release name, e.g. ma1"),
      mountPath:   z.string().describe("Mount path in the container, e.g. /var/ddb2"),
      size:        z.string().default("50Gi").describe("Volume size, e.g. 100Gi"),
      volumeName:  z.string().optional().describe("Volume name (derived from mountPath if omitted)"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      storageClass: z.string().optional().describe("Storage class"),
    },
    (args) => tryCatchTool(() => {
      const { releaseName, mountPath, size, namespace, storageClass } = args;
      assertNamespaceAllowed(namespace);

      const volName = args.volumeName || mountPath.replace(/^\/+/, "").replace(/[/\\]/g, "-");

      // Auto-detect chart from helm list
      const listRes = runCommand(["helm", "list", "--namespace", namespace, "--output", "json"]);
      let chartDir = null;
      try {
        const releases = JSON.parse(listRes.stdout);
        const rel = releases.find(r => r.name === releaseName);
        if (rel) chartDir = rel.chart.replace(/-\d+\.\d+\.\d+.*$/, "");
      } catch { /* ignore */ }

      if (!chartDir) {
        return { content: [{ type: "text", text: `Error: Release "${releaseName}" not found in namespace "${namespace}". Run helm_list to see available releases.` }] };
      }

      // Detect current volume count to append at next index
      let nextIndex = 0;
      const valuesRes = runCommand(["helm", "get", "values", releaseName, "--namespace", namespace, "--output", "json"]);
      try {
        const vals = JSON.parse(valuesRes.stdout);
        if (Array.isArray(vals.volumes)) nextIndex = vals.volumes.length;
      } catch { /* ignore */ }

      const cmd = ["helm", "upgrade", releaseName, chart(chartDir), "--namespace", namespace, "--reuse-values"];
      appendSetArg(cmd, `volumes[${nextIndex}].name`, volName);
      appendSetArg(cmd, `volumes[${nextIndex}].mountPath`, mountPath);
      appendSetArg(cmd, `volumes[${nextIndex}].subPath`, volName);
      appendSetArg(cmd, `volumes[${nextIndex}].size`, size);
      appendSetArg(cmd, `volumes[${nextIndex}].storageClass`, storageClass);

      const res = runCommand(cmd);
      return { content: [{ type: "text", text: `Command: ${redactCommandForLog(cmd)}\n\n${formatResult(res)}\n\nVolume added at index ${nextIndex}, mounted at ${mountPath}` }] };
    })
  );

  // ── scale_components ──────────────────────────────────────────────────────
  server.tool("scale_components",
    "Scale deployments and statefulsets up (replicas=1) or down (replicas=0).",
    {
      direction:   z.enum(["up", "down"]).describe("Scale direction"),
      namePattern: z.string().optional().describe("Only scale resources matching this pattern — omit to scale all"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
    },
    (args) => tryCatchTool(() => {
      const { direction, namePattern, namespace } = args;
      assertNamespaceAllowed(namespace);
      const replicas = direction === "up" ? 1 : 0;
      const results = [];

      if (!namePattern) {
        for (const kind of ["deploy", "statefulset"]) {
          const cmd = ["kubectl", "scale", kind, `--replicas=${replicas}`, "--all", "--namespace", namespace];
          results.push(`>> ${formatCommandForLog(cmd)}`);
          results.push(formatResult(runCommand(cmd)));
        }
      } else {
        const listRes = runCommand(["kubectl", "get", "deployments,statefulsets", "--namespace", namespace, "-o", "name"]);
        const items   = listRes.stdout.split("\n").filter(l => l.toLowerCase().includes(namePattern.toLowerCase()));
        for (const item of items) {
          const cmd = ["kubectl", "scale", item.trim(), `--replicas=${replicas}`, "--namespace", namespace];
          results.push(`>> ${formatCommandForLog(cmd)}`);
          results.push(formatResult(runCommand(cmd)));
        }
        if (!items.length) results.push(`No resources matched pattern "${namePattern}"`);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );

  // ── uninstall_release ─────────────────────────────────────────────────────
  server.tool("uninstall_release",
    "Helm uninstall a release.",
    {
      releaseName: z.string().describe("Helm release name"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const cmd = ["helm", "uninstall", args.releaseName, "--namespace", args.namespace];
      return { content: [{ type: "text", text: `>> ${formatCommandForLog(cmd)}\n\n${formatResult(runCommand(cmd))}` }] };
    })
  );

  // ── helm_list ─────────────────────────────────────────────────────────────
  server.tool("helm_list",
    "List Helm releases in a namespace.",
    { namespace: z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace") },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      return { content: [{ type: "text", text: formatResult(runCommand(["helm", "list", "--namespace", args.namespace])) }] };
    })
  );

  // ── get_current_namespace ──────────────────────────────────────────────────
  server.tool("get_current_namespace",
    "Get the current default namespace for this session (in HTTP mode) or kubectl context (in stdio mode).",
    { },
    (_args, extra) => tryCatchTool(() => {
      // In HTTP mode, return the session namespace
      if (MCP_TRANSPORT === "http" && extra?.sessionId) {
        const context = getSessionContext(extra.sessionId);
        const namespace = context?.namespace || DEFAULT_NAMESPACE;
        return { content: [{ type: "text", text: `Current namespace: ${namespace} (session-scoped)` }] };
      }
      
      // In stdio mode, get from kubectl context
      const res = runCommand(["kubectl", "config", "view", "--minify", "--output", "jsonpath={.contexts[0].context.namespace}"], 5000);
      const namespace = res.stdout.trim() || DEFAULT_NAMESPACE;
      return { content: [{ type: "text", text: `Current namespace: ${namespace} (kubectl context)` }] };
    })
  );

  // ── set_namespace ───────────────────────────────────────────────────────
  server.tool("set_namespace",
    "Set the default namespace. In HTTP mode this is session-scoped (affects only this session). In stdio mode this modifies the global kubectl context.",
    { namespace: z.string().describe("Namespace to set as default") },
    (args, extra) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      
      // Validate namespace exists before setting it
      try {
        validateNamespaceExists(args.namespace);
      } catch (err) {
        return { content: [{ type: "text", text: err.message }] };
      }
      
      // In HTTP mode, set session context instead of global kubectl config
      if (MCP_TRANSPORT === "http" && extra?.sessionId) {
        setSessionContext(extra.sessionId, { namespace: args.namespace });
        return { content: [{ type: "text", text: `Session namespace set to: ${args.namespace}\n\nThis change affects only your current session. Other users and sessions are not affected.` }] };
      }
      
      // In stdio mode, update kubectl context
      // First, check if there's a current context
      const currentContextRes = runCommand(["kubectl", "config", "current-context"], 5000);
      
      if (currentContextRes.exitCode !== 0 || !currentContextRes.stdout.trim()) {
        return { 
          content: [{ 
            type: "text", 
            text: `Error: No kubectl context is currently set.\n\n` +
                  `To fix this:\n` +
                  `1. List available contexts: kubectl config get-contexts\n` +
                  `2. Set a context: kubectl config use-context <context-name>\n` +
                  `3. Then try setting the namespace again`
          }] 
        };
      }
      
      const contextName = currentContextRes.stdout.trim();
      
      // Now set the namespace for this context
      const cmd = ["kubectl", "config", "set-context", contextName, `--namespace=${args.namespace}`];
      const res = runCommand(cmd);
      
      if (res.exitCode === 0) {
        return { content: [{ type: "text", text: `>> ${formatCommandForLog(cmd)}\n\n${formatResult(res)}\n\nNamespace set to "${args.namespace}" for context "${contextName}".\nWARNING: This change affects the global kubectl context for all users.` }] };
      } else {
        return { content: [{ type: "text", text: `Error setting namespace:\n${formatResult(res)}` }] };
      }
    })
  );

  // ── port_forward ──────────────────────────────────────────────────────────
  server.tool("port_forward",
    "Returns the kubectl port-forward command to run in a terminal (interactive, cannot be run via MCP).",
    {
      podName:    z.string().describe("Pod name"),
      targetPort: z.number().describe("Pod port to forward, e.g. 443"),
      namespace:  z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
    },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const cmd = `kubectl port-forward ${args.podName} --namespace ${args.namespace} :${args.targetPort}`;
      return { content: [{ type: "text", text: `Run this command in a terminal:\n\n${cmd}` }] };
    })
  );

  // ── run_kubectl ───────────────────────────────────────────────────────────
  server.tool("run_kubectl",
    "Run an arbitrary kubectl or helm command. Blocked: --all-namespaces, --kubeconfig override, and protected namespaces.",
    { command: z.string().describe("Full command string, e.g. kubectl get nodes") },
    (args) => tryCatchTool(() => {
      const trimmed = args.command.trim();
      let tokens;
      try { tokens = tokenizeCommand(trimmed); } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }

      if (!tokens.length || (tokens[0] !== "kubectl" && tokens[0] !== "helm")) {
        return { content: [{ type: "text", text: `Error: Only kubectl and helm commands are allowed.` }] };
      }
      if (containsKubeconfigOverride(tokens.slice(1))) {
        return { content: [{ type: "text", text: `Error: --kubeconfig override is not allowed.` }] };
      }
      const { namespaces, allNamespaces } = parseNamespaceFlags(tokens.slice(1));
      if (allNamespaces) return { content: [{ type: "text", text: `Error: --all-namespaces/-A is not allowed.` }] };
      for (const ns of namespaces) assertNamespaceAllowed(ns);

      return { content: [{ type: "text", text: `>> ${formatCommandForLog(tokens)}\n\n${formatResult(runCommand(tokens))}` }] };
    })
  );

  // ── test_connectivity ─────────────────────────────────────────────────────
  server.tool("test_connectivity",
    "Test network connectivity between Commvault pods using cvping. Checks if source pod can reach target host:port. Uses /opt/commvault/Base/cvping inside the pod.",
    {
      sourcePod:  z.string().describe("Source pod name to run cvping from (e.g., accessnode1-xxx or ma1-xxx)"),
      targetHost: z.string().describe("Target hostname or IP (e.g., commserve.commvault.svc.cluster.local or 10.0.1.5)"),
      targetPort: z.number().describe("Target port number (e.g., 8400 for CommServer)"),
      namespace:  z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      container:  z.string().optional().describe("Container name if pod has multiple containers"),
    },
    (args) => tryCatchTool(() => {
      const { sourcePod, targetHost, targetPort, namespace, container } = args;
      assertNamespaceAllowed(namespace);
      validateNamespaceExists(namespace);

      // Build kubectl exec command
      const execCmd = ["kubectl", "exec", sourcePod, "--namespace", namespace];
      if (container) execCmd.push("--container", container);
      execCmd.push("--", "/opt/commvault/Base/cvping", targetHost, String(targetPort));

      const result = runCommand(execCmd, 30000); // 30 second timeout
      
      let status = "UNKNOWN";
      let message = result.stdout || result.stderr || "";
      
      // Parse cvping output for common patterns
      if (message.toLowerCase().includes("successfully connected") || message.toLowerCase().includes("connection successful")) {
        status = "[OK] SUCCESS";
      } else if (message.toLowerCase().includes("connection refused") || message.toLowerCase().includes("could not connect")) {
        status = "[FAIL] Connection refused";
      } else if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("timed out")) {
        status = "[FAIL] Timeout";
      } else if (message.toLowerCase().includes("host not found") || message.toLowerCase().includes("name resolution")) {
        status = "[FAIL] DNS resolution failed";
      } else if (result.exitCode === 0) {
        status = "[OK] SUCCESS";
      } else {
        status = "[FAIL] Failed";
      }

      const output = [
        `Connectivity Test: ${sourcePod} → ${targetHost}:${targetPort}`,
        `Namespace: ${namespace}`,
        `Status: ${status}`,
        `Exit Code: ${result.exitCode}`,
        ``,
        `Command: ${formatCommandForLog(execCmd)}`,
        ``,
        `Output:`,
        message
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    })
  );
}
