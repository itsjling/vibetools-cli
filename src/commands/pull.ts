import chalk from "chalk";
import prompts from "prompts";

import {
  ensureGitAvailable,
  getGitStatusPorcelain,
  gitOrThrow,
} from "../git/git.js";
import { ensureRepoLooksInitialized, loadConfigOrThrow } from "./_shared.js";
import { runInstall } from "./install.js";

interface PullOptions {
  rebase?: boolean;
  dryRun?: boolean;
}

export async function runPull(opts: PullOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);
  await ensureGitAvailable();

  const porcelain = await getGitStatusPorcelain(config.repoPath);
  if (porcelain.length > 0) {
    const res = await prompts<{ ok: boolean }>({
      initial: false,
      message: "Repo has uncommitted changes. Continue with git pull?",
      name: "ok",
      type: "confirm",
    });
    if (!res.ok) {
      return;
    }
  }

  const useRebase = opts.rebase !== false;
  const args = ["pull", ...(useRebase ? ["--rebase"] : ["--no-rebase"])];
  await gitOrThrow(config.repoPath, args, "git pull failed.");
  console.log(chalk.green("Pulled latest changes."));
  await runInstall({ dryRun: opts.dryRun });
}
