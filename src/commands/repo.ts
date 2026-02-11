import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { ensureGitAvailable, git } from "../git/git.js";
import { ensureRepoLooksInitialized, loadConfigOrThrow } from "./_shared.js";

const execAsync = promisify(exec);

interface RepoOptions {
  remote?: string;
}

function convertGitUrlToWebUrl(url: string): string {
  const trimmed = url.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\.git$/, "");
  }

  if (trimmed.startsWith("git@")) {
    const match = trimmed.match(/^git@([^:]+):(.+)\.git$/);
    if (match) {
      const [, host, path] = match;
      return `https://${host}/${path}`;
    }
  }

  if (trimmed.startsWith("ssh://")) {
    const match = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)\.git$/);
    if (match) {
      const [, host, path] = match;
      return `https://${host}/${path}`;
    }
  }

  return trimmed.replace(/\.git$/, "");
}

async function getRemoteUrl(
  repoPath: string,
  remoteName: string
): Promise<string | null> {
  const result = await git(repoPath, ["remote", "get-url", remoteName]);
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }
  return result.stdout.trim();
}

async function openBrowser(url: string): Promise<void> {
  let command: string;
  if (process.platform === "darwin") {
    command = `open "${url}"`;
  } else if (process.platform === "win32") {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  await execAsync(command);
}

export async function runRepo(opts: RepoOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);
  await ensureGitAvailable();

  const remoteName = opts.remote || "origin";
  const remoteUrl = await getRemoteUrl(config.repoPath, remoteName);

  if (!remoteUrl) {
    throw new Error(
      `No remote named "${remoteName}" is configured. Add a remote with: git remote add ${remoteName} <url>`
    );
  }

  const webUrl = convertGitUrlToWebUrl(remoteUrl);

  console.log(chalk.blue(`Opening ${webUrl} in your browser...`));

  await openBrowser(webUrl);
}
