/**
 * tools/manage.mjs — MCP tools: add_disk, scale_components, uninstall_release,
 *                    helm_list, set_namespace, port_forward, run_kubectl
 */

import { z } from "zod";
import { chart, DEFAULT_NAMESPACE } from "../config.mjs";
import {
  runCommand, appendSetArg, formatResult, formatCommandForLog,
  redactCommandForLog, assertNamespaceAllowed,
  tokenizeCommand, parseNamespaceFlags, containsKubeconfigOverride,
} from "../exec.mjs";
import { tryCatchTool } from "../errors.mjs";

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

  // ── set_namespace ─────────────────────────────────────────────────────────
  server.tool("set_namespace",
    "Set the default kubectl namespace for the current context. WARNING: This permanently modifies the kubeconfig file on disk and affects all users and tools sharing the same kubeconfig.",
    { namespace: z.string().describe("Namespace to set as default") },
    (args) => tryCatchTool(() => {
      assertNamespaceAllowed(args.namespace);
      const cmd = ["kubectl", "config", "set-context", "--current", `--namespace=${args.namespace}`];
      return { content: [{ type: "text", text: `>> ${formatCommandForLog(cmd)}\n\n${formatResult(runCommand(cmd))}` }] };
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
}
