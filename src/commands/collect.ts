import chalk from "chalk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";

import type { ConflictPolicy, VibetoolsArtifactType } from "../config/types.js";

import { diffFiles } from "../sync/diff.js";
import { applyFilters } from "../sync/filters.js";
import {
  backupEntry,
  copyEntryDereference,
  ensureDir,
  listTopLevelEntries,
  pathExists,
  removeEntry,
} from "../sync/fs.js";
import { areHashesEqual, hashEntry } from "../sync/hash.js";
import { isSymlink, sameRealpath } from "../sync/symlink.js";
import { VibetoolsError } from "../util/errors.js";
import { formatTimestampForPath } from "../util/time.js";
import {
  agentTypeDir,
  ensureRepoLooksInitialized,
  loadConfigOrThrow,
  parseAgentFilter,
  parseTypeFilter,
  repoTypeDir,
} from "./_shared.js";

interface CollectOptions {
  dryRun?: boolean;
  agent?: string;
  type?: string;
  policy?: string;
  importExtras?: boolean;
  force?: boolean;
  selectAll?: boolean;
}

type ConflictDecision = "import" | "skip";

const EXIT_ABORT = 2;
const SHARED_LABEL = "shared";
const SHARED_FILTERS = { exclude: [] as string[], include: ["**"] };

async function decideRepoConflict(args: {
  sourceLabel: string;
  type: VibetoolsArtifactType;
  name: string;
  local: string;
  repo: string;
  force: boolean;
  isExtra: boolean;
}): Promise<ConflictDecision> {
  if (args.force) {
    return "import";
  }

  const localStat = await fs.lstat(args.local).catch(() => null);
  const repoStat = await fs.lstat(args.repo).catch(() => null);
  const canDiff =
    localStat !== null &&
    repoStat !== null &&
    localStat.isFile() &&
    repoStat.isFile();

  while (true) {
    const res = await prompts<{
      decision: ConflictDecision | "diff" | "abort";
    }>({
      choices: [
        {
          title: args.isExtra
            ? "Import into repo"
            : "Overwrite repo with local",
          value: "import",
        },
        { title: "Skip", value: "skip" },
        ...(canDiff ? [{ title: "Show diff", value: "diff" }] : []),
        { title: "Abort", value: "abort" },
      ],
      message: args.isExtra
        ? `Local-only: ${args.sourceLabel} ${args.type} '${args.name}'. Import into repo?`
        : `Conflict: repo already has '${args.name}'. Import local over repo?`,
      name: "decision",
      type: "select",
    });
    if (!res.decision) {
      throw new VibetoolsError("Aborted due to unresolved conflicts.", {
        exitCode: EXIT_ABORT,
      });
    }
    if (res.decision === "abort") {
      throw new VibetoolsError("Aborted due to unresolved conflicts.", {
        exitCode: EXIT_ABORT,
      });
    }
    if (res.decision === "diff") {
      const patch = await diffFiles(args.repo, args.local);
      console.log(patch);
      continue;
    }
    return res.decision;
  }
}

function resolvePolicy(
  raw: string | undefined,
  fallback: ConflictPolicy
): ConflictPolicy {
  if (raw === "prompt" || raw === "repoWins" || raw === "localWins") {
    return raw;
  }
  return fallback;
}

async function isRepoPointingSymlink(
  local: string,
  repo: string
): Promise<boolean> {
  if (!(await isSymlink(local))) {
    return false;
  }
  return await sameRealpath(local, repo);
}

async function areEntriesEqual(repo: string, local: string): Promise<boolean> {
  const [repoHash, localHash] = await Promise.all([
    hashEntry(repo),
    hashEntry(local),
  ]);
  return areHashesEqual(repoHash, localHash);
}

async function maybeBackupAndRemoveRepo(args: {
  repoPath: string;
  backupDir: string;
  timestamp: string;
  sourceLabel: string;
  type: VibetoolsArtifactType;
  name: string;
  dryRun: boolean;
  backupsEnabled: boolean;
}): Promise<void> {
  if (!args.backupsEnabled || args.dryRun) {
    return;
  }
  const backupDest = path.join(
    args.backupDir,
    args.timestamp,
    args.sourceLabel,
    args.type,
    args.name
  );
  await backupEntry(args.repoPath, backupDest);
  await removeEntry(args.repoPath);
}

async function handleRepoExists(args: {
  repo: string;
  local: string;
  sourceLabel: string;
  type: VibetoolsArtifactType;
  name: string;
  policy: ConflictPolicy;
  force: boolean;
  dryRun: boolean;
  backupsEnabled: boolean;
  backupsDir: string;
  timestamp: string;
}): Promise<"skip" | "proceed"> {
  if (await areEntriesEqual(args.repo, args.local)) {
    return "skip";
  }
  if (args.policy === "repoWins") {
    return "skip";
  }
  if (args.policy === "prompt") {
    const decision = await decideRepoConflict({
      force: args.force,
      isExtra: false,
      local: args.local,
      name: args.name,
      repo: args.repo,
      sourceLabel: args.sourceLabel,
      type: args.type,
    });
    if (decision === "skip") {
      return "skip";
    }
  }

  await maybeBackupAndRemoveRepo({
    backupDir: args.backupsDir,
    backupsEnabled: args.backupsEnabled,
    dryRun: args.dryRun,
    name: args.name,
    repoPath: args.repo,
    sourceLabel: args.sourceLabel,
    timestamp: args.timestamp,
    type: args.type,
  });

  if (!args.dryRun && !args.backupsEnabled) {
    await removeEntry(args.repo);
  }

  return "proceed";
}

async function handleRepoMissing(args: {
  repo: string;
  local: string;
  sourceLabel: string;
  type: VibetoolsArtifactType;
  name: string;
  policy: ConflictPolicy;
  force: boolean;
  importExtras: boolean;
}): Promise<"skip" | "proceed"> {
  if (!args.importExtras) {
    if (args.policy === "repoWins") {
      return "skip";
    }
    if (args.policy === "localWins") {
      // Local-only entries are not auto-imported without --import-extras.
      return "skip";
    }
  }
  if (!args.importExtras && args.policy === "prompt") {
    const decision = await decideRepoConflict({
      force: args.force,
      isExtra: true,
      local: args.local,
      name: args.name,
      repo: args.repo,
      sourceLabel: args.sourceLabel,
      type: args.type,
    });
    if (decision === "skip") {
      return "skip";
    }
  }
  return "proceed";
}

async function collectEntry(args: {
  repoRoot: string;
  localRoot: string;
  sourceLabel: string;
  type: VibetoolsArtifactType;
  name: string;
  policy: ConflictPolicy;
  force: boolean;
  dryRun: boolean;
  importExtras: boolean;
  backupsEnabled: boolean;
  backupsDir: string;
  timestamp: string;
}): Promise<void> {
  const local = path.join(args.localRoot, args.name);
  const repo = path.join(args.repoRoot, args.name);

  if (await isRepoPointingSymlink(local, repo)) {
    return;
  }

  const repoExists = await pathExists(repo);
  const action = repoExists
    ? await handleRepoExists({
        backupsDir: args.backupsDir,
        backupsEnabled: args.backupsEnabled,
        dryRun: args.dryRun,
        force: args.force,
        local,
        name: args.name,
        policy: args.policy,
        repo,
        sourceLabel: args.sourceLabel,
        timestamp: args.timestamp,
        type: args.type,
      })
    : await handleRepoMissing({
        force: args.force,
        importExtras: args.importExtras,
        local,
        name: args.name,
        policy: args.policy,
        repo,
        sourceLabel: args.sourceLabel,
        type: args.type,
      });
  if (action === "skip") {
    return;
  }

  if (args.dryRun) {
    console.log(
      `${args.sourceLabel} ${args.type}: would import ${args.name} into repo`
    );
    return;
  }

  await copyEntryDereference(local, repo);
  console.log(
    chalk.green(
      `${args.sourceLabel} ${args.type}: imported ${args.name} into repo`
    )
  );
}

async function promptForEntries(
  entries: string[],
  sourceLabel: string,
  type: VibetoolsArtifactType,
  selectAll: boolean
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }

  if (selectAll) {
    return entries;
  }

  const res = await prompts<{ selected: string[] }>({
    choices: entries.map((name) => ({
      selected: true,
      title: name,
      value: name,
    })),
    hint: "- Space to toggle, A to toggle all, Enter to confirm",
    message: `Select ${sourceLabel} ${type} to collect`,
    name: "selected",
    type: "multiselect",
  });

  return res.selected ?? [];
}

async function collectForAgentType(args: {
  sourceLabel: string;
  type: VibetoolsArtifactType;
  localRoot: string;
  repoRoot: string;
  includeFilters: { include: string[]; exclude: string[] };
  policy: ConflictPolicy;
  force: boolean;
  dryRun: boolean;
  importExtras: boolean;
  backupsEnabled: boolean;
  backupsDir: string;
  timestamp: string;
  selectAll: boolean;
}): Promise<void> {
  await ensureDir(args.repoRoot);
  const localEntries = applyFilters(
    await listTopLevelEntries(args.localRoot),
    args.includeFilters
  );

  if (localEntries.length === 0) {
    return;
  }

  const selectedEntries = await promptForEntries(
    localEntries,
    args.sourceLabel,
    args.type,
    args.selectAll
  );

  for (const name of selectedEntries) {
    await collectEntry({
      backupsDir: args.backupsDir,
      backupsEnabled: args.backupsEnabled,
      dryRun: args.dryRun,
      force: args.force,
      importExtras: args.importExtras,
      localRoot: args.localRoot,
      name,
      policy: args.policy,
      repoRoot: args.repoRoot,
      sourceLabel: args.sourceLabel,
      timestamp: args.timestamp,
      type: args.type,
    });
  }
}

export async function runCollect(opts: CollectOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);

  const agents = parseAgentFilter(opts.agent);
  const types = parseTypeFilter(opts.type);
  const policy = resolvePolicy(opts.policy, config.conflictPolicy);
  const respectEnabled = !opts.agent;

  const timestamp = formatTimestampForPath();
  for (const agentId of agents) {
    const agentCfg = config.agents[agentId];
    if (!agentCfg) {
      throw new VibetoolsError(
        `Agent '${agentId}' is not configured. Run 'vibetools configure' to set it up.`,
        { exitCode: 1 }
      );
    }
    if (respectEnabled && !agentCfg.enabled) {
      continue;
    }
    if (!respectEnabled && !agentCfg.enabled) {
      console.log(
        chalk.yellow(
          `${agentId}: agent is disabled in config, but collecting because --agent was specified.`
        )
      );
    }

    for (const type of types) {
      const localRoot = agentTypeDir(config, agentId, type);
      if (!localRoot) {
        continue;
      }
      const repoRoot = repoTypeDir(config.repoPath, type);
      await collectForAgentType({
        backupsDir: config.backups.dir,
        backupsEnabled: config.backups.enabled,
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
        importExtras: Boolean(opts.importExtras),
        includeFilters: agentCfg.filters[type],
        localRoot,
        policy,
        repoRoot,
        selectAll: Boolean(opts.selectAll),
        sourceLabel: agentId,
        timestamp,
        type,
      });
    }
  }

  const sharedRoot = path.join(os.homedir(), ".agents");
  for (const type of types) {
    const localRoot = path.join(sharedRoot, type);
    const repoRoot = repoTypeDir(config.repoPath, type);
    await collectForAgentType({
      backupsDir: config.backups.dir,
      backupsEnabled: config.backups.enabled,
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
      importExtras: Boolean(opts.importExtras),
      includeFilters: SHARED_FILTERS,
      localRoot,
      policy,
      repoRoot,
      selectAll: Boolean(opts.selectAll),
      sourceLabel: SHARED_LABEL,
      timestamp,
      type,
    });
  }
}
