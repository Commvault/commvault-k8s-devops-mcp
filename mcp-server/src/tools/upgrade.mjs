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
}
