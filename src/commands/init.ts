import chalk from "chalk";
import fs from "node:fs/promises";
import path from "node:path";

import { createDefaultConfig } from "../config/defaults.js";
import { ensureVibetoolsHome, loadConfig, saveConfig } from "../config/io.js";
import { getDefaultRepoPath } from "../config/paths.js";
import { ensureGitAvailable, git, gitOrThrow } from "../git/git.js";
import {
  repoAgentsCommandsDir,
  repoAgentsSkillsDir,
  repoMetadataPath,
  repoTemplatesAgentsMdDir,
} from "../repo/layout.js";
import { VibetoolsError } from "../util/errors.js";

interface InitOptions {
  repo?: string;
  remote?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeRepoMetadata(repoPath: string): Promise<void> {
  const metaPath = repoMetadataPath(repoPath);
  if (await pathExists(metaPath)) {
    return;
  }
  await fs.writeFile(
    metaPath,
    `${JSON.stringify({ createdAt: new Date().toISOString(), version: 1 }, null, 2)}\n`,
    "utf8"
  );
}

async function writeDefaultTemplates(repoPath: string): Promise<void> {
  const templateDefault = path.join(
    repoTemplatesAgentsMdDir(repoPath),
    "default.md"
  );
  if (await pathExists(templateDefault)) {
    return;
  }
  await fs.writeFile(
    templateDefault,
    "# AGENTS.md template\n\nAdd your default agent instructions here.\n",
    "utf8"
  );
}

async function writeReadme(repoPath: string): Promise<void> {
  const readme = path.join(repoPath, "README.md");
  if (await pathExists(readme)) {
    return;
  }
  await fs.writeFile(
    readme,
    `# vibetools repo\n\nThis repo is managed by \`vibetools\`.\n\n- \`.agents/skills/\`: skills (agent-agnostic)\n- \`.agents/commands/\`: slash commands (agent-agnostic)\n- \`templates/AGENTS.md/\`: templates only\n`,
    "utf8"
  );
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  const gitDir = path.join(repoPath, ".git");
  if (await pathExists(gitDir)) {
    return;
  }
  await gitOrThrow(repoPath, ["init"], "Failed to git init repo.");
}

async function writeGitignore(repoPath: string): Promise<void> {
  const gitignore = path.join(repoPath, ".gitignore");
  if (await pathExists(gitignore)) {
    return;
  }
  await fs.writeFile(gitignore, ".DS_Store\nThumbs.db\n", "utf8");
}

async function setOriginRemote(
  repoPath: string,
  remote: string
): Promise<void> {
  const remoteUrl = remote.trim();
  if (!remoteUrl) {
    throw new VibetoolsError("Remote URL cannot be empty.", { exitCode: 1 });
  }
  await git(repoPath, ["remote", "remove", "origin"]);
  await gitOrThrow(
    repoPath,
    ["remote", "add", "origin", remoteUrl],
    "Failed to add origin remote."
  );
}

export async function runInit(opts: InitOptions): Promise<void> {
  await ensureGitAvailable();
  await ensureVibetoolsHome();

  const repoPath = path.resolve(opts.repo ?? getDefaultRepoPath());

  const { config, configPath } = await loadConfig();
  const nextConfig = config ?? createDefaultConfig();
  nextConfig.repoPath = repoPath;
  await saveConfig(nextConfig, configPath);

  await fs.mkdir(repoAgentsSkillsDir(repoPath), { recursive: true });
  await fs.mkdir(repoAgentsCommandsDir(repoPath), { recursive: true });
  await fs.mkdir(repoTemplatesAgentsMdDir(repoPath), { recursive: true });

  await Promise.all([
    writeRepoMetadata(repoPath),
    writeDefaultTemplates(repoPath),
    writeReadme(repoPath),
  ]);
  await ensureGitRepo(repoPath);
  await writeGitignore(repoPath);

  if (opts.remote) {
    await setOriginRemote(repoPath, opts.remote);
  }

  console.log(chalk.green(`Initialized vibetools repo at ${repoPath}`));
}
