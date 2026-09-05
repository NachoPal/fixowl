import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import type { ArtifactUploader } from "./deps.ts";

/** Recursively collects the absolute paths of every regular file under `dir`. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Real progressive-upload edge, using the official `@actions/artifact` client so
 * fixowl speaks the current (v4+) artifact-backend protocol rather than
 * reimplementing its Azure-blob upload by hand. Uses only the Actions runtime's
 * own `ACTIONS_RUNTIME_TOKEN`/`ACTIONS_RESULTS_URL` (present for any running job);
 * it never touches the runtime PAT and runs on the host, outside any container.
 */
export class GitHubArtifactUploader implements ArtifactUploader {
  private readonly client = new DefaultArtifactClient();

  async uploadDirectory(params: { name: string; dir: string }): Promise<boolean> {
    let files: string[];
    try {
      files = await listFilesRecursive(params.dir);
    } catch {
      // Missing directory (an issue that produced no evidence): nothing to upload.
      return false;
    }
    if (files.length === 0) return false;
    const { id } = await this.client.uploadArtifact(params.name, files, params.dir);
    return id !== undefined;
  }
}
