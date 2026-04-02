/**
 * tools/upgrade.mjs — MCP tool: upgrade_component
 */

import { z } from "zod";
import { chart, CHART_MAP, REPO_MAP, DEFAULT_NAMESPACE, CV_IMAGE_REGISTRY, CV_IMAGE_NAMESPACE } from "../config.mjs";
import { runCommand, appendSetArg, formatResult, redactCommandForLog, assertNamespaceAllowed } from "../exec.mjs";
import { computeImageLocation, getExistingImageLocation } from "../image.mjs";
import { tryCatchTool } from "../errors.mjs";

export function registerUpgradeTools(server) {

  server.tool(
    "upgrade_component",
    "Upgrade a Commvault component to a new image tag. Uses --reuse-values to preserve existing config. Use component=all to upgrade every release in the namespace.",
    {
      component:       z.enum([...Object.keys(CHART_MAP), "all"]).describe("Component to upgrade, or 'all'"),
      tag:             z.string().describe("New image tag, e.g. 11.42.1"),
      releaseName:     z.string().optional().describe("Helm release name (single-component upgrades only)"),
      namespace:       z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      registry:        z.string().optional().describe("Container image registry"),
      imageNamespace:  z.string().optional().describe("Image namespace/sub-path"),
      imageRepository: z.string().optional().describe("Image repo name override"),
    },
    (args) => tryCatchTool(() => {
      const { component, tag, namespace, imageRepository } = args;
      const registry       = args.registry      || CV_IMAGE_REGISTRY  || undefined;
      const imageNamespace = args.imageNamespace || CV_IMAGE_NAMESPACE || undefined;
      assertNamespaceAllowed(namespace);
      const results = [];

      const upgradeOne = (name, chartDir, compKey) => {
        const cmd = [
          "helm", "upgrade", name, chart(chartDir),
          "--namespace", namespace, "--reuse-values",
        ];
        appendSetArg(cmd, "global.image.tag", tag);
        appendSetArg(cmd, "global.image.registry", registry);
        appendSetArg(cmd, "global.image.namespace", imageNamespace);
        const existing = getExistingImageLocation(name, namespace);
        appendSetArg(cmd, "image.location", computeImageLocation(registry, imageNamespace, tag, existing, REPO_MAP[compKey] || chartDir, imageRepository));
        results.push(`>> ${redactCommandForLog(cmd)}`);
        results.push(formatResult(runCommand(cmd)));
      };

      if (component === "all") {
        const listRes = runCommand(["helm", "list", "--namespace", namespace, "--output", "json"]);
        let releases = [];
        try { releases = JSON.parse(listRes.stdout); } catch { /* ignore */ }

        if (!releases.length) return { content: [{ type: "text", text: `No Helm releases found in namespace ${namespace}` }] };

        const knownChartDirs = new Set(Object.values(CHART_MAP).map(v => v.dir));
        const dirToComp = Object.fromEntries(Object.entries(CHART_MAP).map(([k, v]) => [v.dir, k]));

        for (const rel of releases) {
          const baseName = rel.chart.replace(/-\d+\.\d+\.\d+.*$/, "");
          if (!knownChartDirs.has(baseName)) continue;
          upgradeOne(rel.name, baseName, dirToComp[baseName]);
        }
        results.push(`\nAll Commvault components upgraded to ${tag}`);
      } else {
        const { dir, defaultName } = CHART_MAP[component];
        upgradeOne(args.releaseName || defaultName, dir, component);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );

  // ── rollback_deployment ───────────────────────────────────────────────────
  server.tool(
    "rollback_deployment",
    "Rollback a Helm release to a previous revision. Shows release history and optionally the diff between versions.",
    {
      releaseName: z.string().describe("Helm release name to rollback (e.g., commserve, accessnode1)"),
      namespace:   z.string().default(DEFAULT_NAMESPACE).describe("Kubernetes namespace"),
      revision:    z.number().optional().describe("Specific revision number to rollback to (defaults to previous revision)"),
      showDiff:    z.boolean().default(true).describe("Show configuration diff before rollback"),
      dryRun:      z.boolean().default(false).describe("Simulate rollback without applying changes"),
    },
    (args) => tryCatchTool(() => {
      const { releaseName, namespace, revision, showDiff, dryRun } = args;
      assertNamespaceAllowed(namespace);
      const results = [];

      // 1. Get release history
      results.push("=== Release History ===");
      const historyCmd = ["helm", "history", releaseName, "--namespace", namespace, "--output", "json"];
      let history = [];
      try {
        const historyResult = runCommand(historyCmd);
        history = JSON.parse(historyResult.stdout);
        
        if (history.length === 0) {
          return { content: [{ type: "text", text: `No history found for release '${releaseName}' in namespace '${namespace}'` }] };
        }
        
        results.push(`\nFound ${history.length} revision(s):\n`);
        history.forEach(rev => {
          const marker = rev.revision === history[history.length - 1].revision ? "→ CURRENT" : "";
          results.push(`  Rev ${rev.revision}: ${rev.status} - Updated ${rev.updated} ${marker}`);
          results.push(`    Chart: ${rev.chart}, App Version: ${rev.app_version}`);
          if (rev.description) results.push(`    ${rev.description}`);
          results.push("");
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Error getting history: ${e.message}` }] };
      }

      // Determine target revision
      const currentRevision = history[history.length - 1].revision;
      const targetRevision = revision || (currentRevision > 1 ? currentRevision - 1 : null);
      
      if (!targetRevision) {
        return { content: [{ type: "text", text: `Cannot rollback: only one revision exists` }] };
      }
      
      if (targetRevision >= currentRevision) {
        return { content: [{ type: "text", text: `Cannot rollback to revision ${targetRevision}: it must be older than current revision ${currentRevision}` }] };
      }

      results.push(`\nTarget: Rollback from revision ${currentRevision} to revision ${targetRevision}`);

      // 2. Show diff if requested
      if (showDiff) {
        results.push("\n=== Configuration Diff ===");
        try {
          const currentValues = runCommand(["helm", "get", "values", releaseName, "--namespace", namespace, "--revision", String(currentRevision)]);
          const targetValues = runCommand(["helm", "get", "values", releaseName, "--namespace", namespace, "--revision", String(targetRevision)]);
          
          results.push(`\nCurrent Values (Rev ${currentRevision}):`);
          results.push(currentValues.stdout || "(empty)");
          results.push(`\nTarget Values (Rev ${targetRevision}):`);
          results.push(targetValues.stdout || "(empty)");
          
          if (currentValues.stdout.trim() === targetValues.stdout.trim()) {
            results.push("\n[WARN] No configuration differences detected between revisions");
          }
        } catch (e) {
          results.push(`\n[WARN] Could not retrieve diff: ${e.message}`);
        }
      }

      // 3. Perform rollback
      results.push("\n=== Rollback Operation ===");
      const rollbackCmd = ["helm", "rollback", releaseName, String(targetRevision), "--namespace", namespace];
      if (dryRun) rollbackCmd.push("--dry-run");

      results.push(`\nCommand: ${formatResult({ stdout: rollbackCmd.join(" "), stderr: "", exitCode: 0 }).split("\n")[0]}`);
      
      if (dryRun) {
        results.push("\n[DRY-RUN] No changes will be applied");
      }

      try {
        const rollbackResult = runCommand(rollbackCmd, 180000); // 3 minute timeout
        results.push("\n" + formatResult(rollbackResult));
        
        if (!dryRun) {
          results.push(`\n[OK] Successfully rolled back ${releaseName} to revision ${targetRevision}`);
          results.push(`\nCheck status: kubectl get pods -n ${namespace} -l release=${releaseName}`);
        }
      } catch (e) {
        results.push(`\n[FAIL] Rollback failed: ${e.message}`);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    })
  );
}
