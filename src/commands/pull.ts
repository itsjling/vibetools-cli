import chalk from "chalk";
import fs from "node:fs/promises";
import path from "node:path";
import prompts from "prompts";

import {
  ensureGitAvailable,
  getDiffSummary,
  getGitStatusPorcelain,
  gitOrThrow,
  type FileChange,
} from "../git/git.js";
import {
  backupEntry,
  copyEntryDereference,
  ensureDir,
  removeEntry,
} from "../sync/fs.js";
import { VibetoolsError } from "../util/errors.js";
import { formatTimestampForPath } from "../util/time.js";
import { ensureRepoLooksInitialized, loadConfigOrThrow } from "./_shared.js";
import { type KeptLocalEntry, runInstall } from "./install.js";
import { runPush } from "./push.js";

interface PullOptions {
  rebase?: boolean;
  dryRun?: boolean;
  conflictResolution?: string;
}

const INDEX_FIRST = 0;

function promptOnCancel(): never {
  throw new VibetoolsError("Aborted.", { exitCode: 1 });
}

function displayChangesSummary(changes: FileChange[]): void {
  if (changes.length === 0) {
    console.log(chalk.dim("No new changes to sync."));
    return;
  }

  console.log(chalk.cyan("\nPulled changes summary:"));
  console.log(chalk.gray("─".repeat(50)));

  const added = changes.filter((c) => c.status === "added");
  const updated = changes.filter((c) => c.status === "updated");
  const deleted = changes.filter((c) => c.status === "deleted");

  if (added.length > 0) {
    console.log(chalk.green(`\n  Added (${added.length}):`));
    for (const change of added) {
      console.log(chalk.green(`    + ${change.path}`));
    }
  }

  if (updated.length > 0) {
    console.log(chalk.yellow(`\n  Updated (${updated.length}):`));
    for (const change of updated) {
      console.log(chalk.yellow(`    ~ ${change.path}`));
    }
  }

  if (deleted.length > 0) {
    console.log(chalk.red(`\n  Deleted (${deleted.length}):`));
    for (const change of deleted) {
      console.log(chalk.red(`    - ${change.path}`));
    }
  }

  console.log(chalk.gray("─".repeat(50)));
  console.log(chalk.cyan(`\nTotal: ${changes.length} file(s) pulled\n`));
}

function resolveConflictPolicy(
  resolution: string | undefined
): "localWins" | "repoWins" | "prompt" | undefined {
  if (resolution === "local") {
    return "localWins";
  }
  if (resolution === "remote") {
    return "repoWins";
  }
  if (resolution === "prompt") {
    return "prompt";
  }
  return undefined;
}

async function promptSyncAndPush(): Promise<boolean> {
  const res = await prompts<{ ok?: boolean }>(
    {
      initial: INDEX_FIRST,
      message: "Sync local versions to repo and push?",
      name: "ok",
      type: "confirm",
    },
    { onCancel: promptOnCancel }
  );
  return Boolean(res.ok);
}

async function syncKeptLocals(
  keptLocals: KeptLocalEntry[],
  dryRun: boolean
): Promise<number> {
  const { config } = await loadConfigOrThrow();
  const timestamp = formatTimestampForPath();
  let syncedCount = 0;

  for (const entry of keptLocals) {
    const repoEntryPath = entry.repoPath;
    const localEntryPath = entry.localPath;

    // Skip if it's a symlink pointing to repo
    try {
      const stats = await fs.lstat(localEntryPath);
      if (stats.isSymbolicLink()) {
        const realPath = await fs.realpath(localEntryPath);
        if (realPath.startsWith(config.repoPath)) {
          continue;
        }
      }
    } catch {
      // If we can't stat it, skip it
      continue;
    }

    if (dryRun) {
      console.log(
        `Would sync ${entry.agentId} ${entry.type}: ${entry.name} to repo`
      );
      syncedCount += 1;
      continue;
    }

    // Backup existing repo entry if it exists
    if (config.backups.enabled) {
      const backupDest = path.join(
        config.backups.dir,
        timestamp,
        entry.agentId,
        entry.type,
        entry.name
      );
      try {
        await fs.access(repoEntryPath);
        await backupEntry(repoEntryPath, backupDest);
      } catch {
        // Entry doesn't exist, no backup needed
      }
    }

    // Remove existing repo entry
    try {
      await removeEntry(repoEntryPath);
    } catch {
      // Entry doesn't exist, that's fine
    }

    // Copy local to repo
    await ensureDir(path.dirname(repoEntryPath));
    await copyEntryDereference(localEntryPath, repoEntryPath);
    console.log(
      chalk.green(
        `Synced ${entry.agentId} ${entry.type}: ${entry.name} to repo`
      )
    );
    syncedCount += 1;
  }

  return syncedCount;
}

export async function runPull(opts: PullOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);
  await ensureGitAvailable();

  const porcelain = await getGitStatusPorcelain(config.repoPath);
  if (porcelain.length > 0) {
    const res = await prompts<{ ok: boolean }>(
      {
        initial: false,
        message: "Repo has uncommitted changes. Continue with git pull?",
        name: "ok",
        type: "confirm",
      },
      { onCancel: promptOnCancel }
    );
    if (!res.ok) {
      return;
    }
  }

  const useRebase = opts.rebase !== false;
  const args = ["pull", ...(useRebase ? ["--rebase"] : ["--no-rebase"])];

  // Get the changes that will be pulled
  const pulledChanges = opts.dryRun
    ? []
    : await getDiffSummary(config.repoPath, "HEAD...@{u}");

  await gitOrThrow(config.repoPath, args, "git pull failed.");
  console.log(chalk.green("Pulled latest changes."));

  // Display summary of what was pulled
  displayChangesSummary(pulledChanges);

  // Determine conflict policy based on --conflict-resolution flag
  const conflictPolicy = resolveConflictPolicy(opts.conflictResolution);

  const installResult = await runInstall({
    dryRun: opts.dryRun,
    policy: conflictPolicy,
  });

  // If we kept any local versions, offer to sync them
  if (!opts.dryRun && installResult.keptLocals.length > 0) {
    console.log(
      chalk.yellow(
        `\nKept ${installResult.keptLocals.length} local version(s) during install.`
      )
    );

    const shouldSync = await promptSyncAndPush();
    if (shouldSync) {
      console.log(chalk.cyan("Syncing local versions to repo..."));
      const syncedCount = await syncKeptLocals(installResult.keptLocals, false);

      if (syncedCount > 0) {
        console.log(chalk.green(`Synced ${syncedCount} item(s) to repo.`));
        await runPush({ collect: false });
      }
    }
  }
}
