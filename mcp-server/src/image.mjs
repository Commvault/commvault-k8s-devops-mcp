/**
 * image.mjs — image location computation helpers.
 *
 * Commvault Helm charts support two ways to pin an image:
 *   1. global.image.tag + global.image.registry + global.image.namespace
 *   2. image.location = "<registry>/<namespace>/<repo>:<tag>"
 *
 * When a release already has image.location set, --reuse-values preserves it
 * and it takes priority. These helpers build the correct override value.
 */

import { runCommand } from "./exec.mjs";

export function imageLocationSet(registry, imageNamespace, repo, tag) {
  if (!registry || !imageNamespace || !repo || !tag) return "";
  return `${registry.replace(/\/+$/, "")}/${imageNamespace}/${repo}:${tag}`;
}

export function replaceTagInLocation(existingLocation, newTag) {
  if (!existingLocation || !newTag) return "";
  const lastColon = existingLocation.lastIndexOf(":");
  if (lastColon === -1) return "";
  return `${existingLocation.substring(0, lastColon)}:${newTag}`;
}

export function parseRepoFromLocation(location, defaultRepo) {
  if (!location) return defaultRepo;
  const withoutTag = location.substring(0, location.lastIndexOf(":") === -1 ? undefined : location.lastIndexOf(":"));
  const segments   = withoutTag.split("/");
  return segments[segments.length - 1] || defaultRepo;
}

export function getExistingImageLocation(releaseName, namespace) {
  const res = runCommand([
    "helm", "get", "values", releaseName,
    "--namespace", namespace, "--output", "json",
  ]);
  if (res.exitCode !== 0) return null;
  try {
    const values = JSON.parse(res.stdout || "{}");
    if (typeof values?.image?.location === "string") return values.image.location.trim();
  } catch { /* ignore */ }
  return null;
}

/**
 * Compute the image.location override for a deploy/upgrade command.
 *
 * Decision table:
 *  registry + imageNamespace + tag  → build full image.location from scratch
 *  tag only + existing location     → swap tag in existing path
 *  tag only + no existing location  → "" (global.image.tag handles it)
 */
export function computeImageLocation(registry, imageNamespace, tag, existingLocation, defaultRepo, imageRepository) {
  if (registry && imageNamespace) {
    const repo = imageRepository || parseRepoFromLocation(existingLocation, defaultRepo);
    return imageLocationSet(registry, imageNamespace, repo, tag);
  }
  if (existingLocation) return replaceTagInLocation(existingLocation, tag);
  return "";
}

/**
 * Split a combined "registry/imageNamespace" repo string into its parts.
 * e.g., "git.foo.com:5005/eng-public/image-library"
 *        → { registry: "git.foo.com:5005/eng-public", imageNamespace: "image-library" }
 */
export function splitRepo(repo) {
  if (!repo) return { registry: undefined, imageNamespace: undefined };
  const lastSlash = repo.lastIndexOf("/");
  if (lastSlash === -1) return { registry: repo, imageNamespace: undefined };
  return { registry: repo.substring(0, lastSlash), imageNamespace: repo.substring(lastSlash + 1) };
}
