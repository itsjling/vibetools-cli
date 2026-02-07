import chalk from "chalk";

import {
  ensureGitAvailable,
  getGitStatusPorcelain,
  git,
  gitOrThrow,
  hasOriginRemote,
} from "../git/git.js";
import { formatTimestampForCommit } from "../util/time.js";
import { ensureRepoLooksInitialized, loadConfigOrThrow } from "./_shared.js";
import { runCollect } from "./collect.js";

interface PushOptions {
  message?: string;
  dryRun?: boolean;
}

const EMPTY_LENGTH = 0;
const EXIT_SUCCESS = 0;

async function commitIfNeeded(args: {
  repoPath: string;
  messageOverride?: string;
}): Promise<void> {
  const porcelain = await getGitStatusPorcelain(args.repoPath);
  if (porcelain.length === EMPTY_LENGTH) {
    console.log(chalk.dim("No changes to commit."));
    return;
  }

  const msg =
    args.messageOverride?.trim() ||
    `vibetools sync (${formatTimestampForCommit()})`;
  await gitOrThrow(args.repoPath, ["commit", "-m", msg], "git commit failed.");
  console.log(chalk.green("Committed changes."));
}

async function pushToOrigin(repoPath: string): Promise<void> {
  if (!(await hasOriginRemote(repoPath))) {
    console.log(
      chalk.yellow(
        "No origin remote configured. Set one with: git remote add origin <url>"
      )
    );
    return;
  }

  const pushResult = await git(repoPath, ["push"]);
  if (pushResult.code !== EXIT_SUCCESS) {
    throw new Error(
      `git push failed:\n${pushResult.stderr.trim() || pushResult.stdout.trim()}`
    );
  }
  console.log(chalk.green("Pushed to remote."));
}

export async function runPush(opts: PushOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);
  await ensureGitAvailable();

  await runCollect({ dryRun: opts.dryRun });
  if (opts.dryRun) {
    console.log(chalk.yellow("Dry run: skipping git add/commit/push."));
    return;
  }

  await gitOrThrow(config.repoPath, ["add", "-A"], "git add failed.");
  await commitIfNeeded({
    messageOverride: opts.message,
    repoPath: config.repoPath,
  });
  await pushToOrigin(config.repoPath);
}
