import chalk from "chalk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";

import type {
  AgentId,
  ConflictPolicy,
  VibetoolsArtifactType,
} from "../config/types.js";

import { diffFiles } from "../sync/diff.js";
import { applyFilters } from "../sync/filters.js";
import {
  backupEntry,
  copyEntryDereference,
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
  parseTypeFilter,
  repoTypeDir,
} from "./_shared.js";
import { runPush } from "./push.js";

interface CollectOptions {
  dryRun?: boolean;
  agent?: string;
  type?: string;
  policy?: string;
  importExtras?: boolean;
  force?: boolean;
  selectAll?: boolean;
  push?: boolean;
  sources?: string;
}

type CollectionSource = "shared" | AgentId;

type ConflictDecision = "import" | "skip";

const EXIT_ABORT = 2;
const SHARED_LABEL = "shared";
const SHARED_FILTERS = { exclude: [] as string[], include: ["**"] };
const INDEX_FIRST = 0;

function promptOnCancel(): never {
  throw new VibetoolsError("Aborted.", { exitCode: 1 });
}

interface SourceOption {
  enabled: boolean;
  label: string;
  source: CollectionSource;
}

interface CollectibleEntry {
  localPath: string;
  name: string;
  repoPath: string;
  sourceLabel: string;
  type: VibetoolsArtifactType;
}

function getSharedAgentsDir(): string {
  const override = process.env.VIBETOOLS_HOME;
  if (override) {
    return path.join(override, ".agents");
  }
  return path.join(os.homedir(), ".agents");
}

async function getAvailableSources(
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"]
): Promise<SourceOption[]> {
  const sources: SourceOption[] = [];

  // Add shared folder
  const sharedPath = getSharedAgentsDir();
  sources.push({
    enabled: await pathExists(sharedPath),
    label: `Shared folder (~/.agents)`,
    source: "shared",
  });

  // Add configured agents
  const agentIds: AgentId[] = ["codex", "claude-code", "cursor", "opencode"];
  for (const agentId of agentIds) {
    const agentCfg = config.agents[agentId];
    if (agentCfg?.enabled) {
      sources.push({
        enabled: true,
        label: `${agentId} (${agentCfg.paths.skills ?? "not configured"})`,
        source: agentId,
      });
    }
  }

  return sources.filter((s) => s.enabled);
}

async function promptForSources(
  availableSources: SourceOption[],
  selectAll: boolean
): Promise<CollectionSource[]> {
  if (availableSources.length === 0) {
    return [];
  }

  if (selectAll) {
    return availableSources.map((s) => s.source);
  }

  const res = await prompts<{ selected: CollectionSource[] }>(
    {
      choices: availableSources.map((s) => ({
        selected: true,
        title: s.label,
        value: s.source,
      })),
      hint: "- Space to toggle, A to toggle all, Enter to confirm",
      message: "Select sources to collect from",
      name: "selected",
      type: "multiselect",
    },
    { onCancel: promptOnCancel }
  );

  return res.selected ?? [];
}

async function promptForAllEntries(
  entries: CollectibleEntry[],
  selectAll: boolean
): Promise<CollectibleEntry[]> {
  if (entries.length === 0) {
    return [];
  }

  if (selectAll) {
    return entries;
  }

  const res = await prompts<{ selected: string[] }>(
    {
      choices: entries.map((entry) => ({
        selected: true,
        title: `${entry.sourceLabel} ${entry.type}: ${entry.name}`,
        value: `${entry.sourceLabel}:${entry.type}:${entry.name}`,
      })),
      hint: "- Space to toggle, A to toggle all, Enter to confirm",
      message: "Select skills/commands to collect",
      name: "selected",
      type: "multiselect",
    },
    { onCancel: promptOnCancel }
  );

  const selectedKeys = new Set(res.selected ?? []);
  return entries.filter((e) =>
    selectedKeys.has(`${e.sourceLabel}:${e.type}:${e.name}`)
  );
}

async function promptPush(): Promise<boolean> {
  const res = await prompts<{ ok?: boolean }>(
    {
      initial: INDEX_FIRST,
      message: "Push changes to remote?",
      name: "ok",
      type: "confirm",
    },
    { onCancel: promptOnCancel }
  );
  return Boolean(res.ok);
}

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
    }>(
      {
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
      },
      { onCancel: promptOnCancel }
    );
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
  entry: CollectibleEntry;
  policy: ConflictPolicy;
  force: boolean;
  dryRun: boolean;
  importExtras: boolean;
  backupsEnabled: boolean;
  backupsDir: string;
  timestamp: string;
}): Promise<boolean> {
  const {
    localPath: local,
    repoPath: repo,
    sourceLabel,
    type,
    name,
  } = args.entry;

  if (await isRepoPointingSymlink(local, repo)) {
    return false;
  }

  const repoExists = await pathExists(repo);
  const action = repoExists
    ? await handleRepoExists({
        backupsDir: args.backupsDir,
        backupsEnabled: args.backupsEnabled,
        dryRun: args.dryRun,
        force: args.force,
        local,
        name,
        policy: args.policy,
        repo,
        sourceLabel,
        timestamp: args.timestamp,
        type,
      })
    : await handleRepoMissing({
        force: args.force,
        importExtras: args.importExtras,
        local,
        name,
        policy: args.policy,
        repo,
        sourceLabel,
        type,
      });
  if (action === "skip") {
    return false;
  }

  if (args.dryRun) {
    console.log(`${sourceLabel} ${type}: would import ${name} into repo`);
    return true;
  }

  await copyEntryDereference(local, repo);
  console.log(
    chalk.green(`${sourceLabel} ${type}: imported ${name} into repo`)
  );
  return true;
}

async function gatherEntriesFromSource(
  sourceLabel: string,
  source: CollectionSource,
  types: VibetoolsArtifactType[],
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"]
): Promise<CollectibleEntry[]> {
  const entries: CollectibleEntry[] = [];

  for (const type of types) {
    let localRoot: string | null = null;
    let includeFilters = SHARED_FILTERS;

    if (source === "shared") {
      localRoot = path.join(getSharedAgentsDir(), type);
    } else {
      localRoot = agentTypeDir(config, source, type);
      const agentCfg = config.agents[source];
      if (agentCfg) {
        includeFilters = agentCfg.filters[type];
      }
    }

    if (!localRoot || !(await pathExists(localRoot))) {
      continue;
    }

    const repoRoot = repoTypeDir(config.repoPath, type);
    const localEntries = applyFilters(
      await listTopLevelEntries(localRoot),
      includeFilters
    );

    for (const name of localEntries) {
      entries.push({
        localPath: path.join(localRoot, name),
        name,
        repoPath: path.join(repoRoot, name),
        sourceLabel,
        type,
      });
    }
  }

  return entries;
}

function parseSources(
  sourcesStr: string | undefined,
  availableSources: CollectionSource[]
): CollectionSource[] | undefined {
  if (!sourcesStr) {
    return undefined;
  }
  const sources = sourcesStr
    .split(",")
    .map((s) => s.trim()) as CollectionSource[];
  return sources.filter((s) => availableSources.includes(s));
}

export async function runCollect(opts: CollectOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);

  const types = parseTypeFilter(opts.type);
  const policy = resolvePolicy(opts.policy, config.conflictPolicy);
  const respectEnabled = !opts.agent;

  // Get available sources and prompt for selection
  const availableSources = await getAvailableSources(config);
  const selectedSources =
    parseSources(
      opts.sources,
      availableSources.map((s) => s.source)
    ) ?? (await promptForSources(availableSources, Boolean(opts.selectAll)));

  if (selectedSources.length === 0) {
    console.log(chalk.yellow("No sources selected. Nothing to collect."));
    return;
  }

  // Gather all entries from all selected sources
  console.log(chalk.cyan("Scanning for skills/commands..."));
  const allEntries: CollectibleEntry[] = [];

  for (const source of selectedSources) {
    if (source === "shared") {
      const entries = await gatherEntriesFromSource(
        SHARED_LABEL,
        source,
        types,
        config
      );
      allEntries.push(...entries);
    } else {
      // It's an agent
      const agentCfg = config.agents[source];
      if (!agentCfg) {
        throw new VibetoolsError(
          `Agent '${source}' is not configured. Run 'vibetools configure' to set it up.`,
          { exitCode: 1 }
        );
      }
      if (respectEnabled && !agentCfg.enabled) {
        continue;
      }
      if (!respectEnabled && !agentCfg.enabled) {
        console.log(
          chalk.yellow(
            `${source}: agent is disabled in config, but collecting because --agent was specified.`
          )
        );
      }

      const entries = await gatherEntriesFromSource(
        source,
        source,
        types,
        config
      );
      allEntries.push(...entries);
    }
  }

  if (allEntries.length === 0) {
    console.log(chalk.yellow("No skills/commands found to collect."));
    return;
  }

  // Prompt for which entries to collect (all at once)
  const selectedEntries = await promptForAllEntries(
    allEntries,
    Boolean(opts.selectAll)
  );

  if (selectedEntries.length === 0) {
    console.log(chalk.yellow("No entries selected. Nothing to collect."));
    return;
  }

  // Collect selected entries
  const timestamp = formatTimestampForPath();
  let totalCollected = 0;

  for (const entry of selectedEntries) {
    const wasCollected = await collectEntry({
      backupsDir: config.backups.dir,
      backupsEnabled: config.backups.enabled,
      dryRun: Boolean(opts.dryRun),
      entry,
      force: Boolean(opts.force),
      importExtras: Boolean(opts.importExtras),
      policy,
      timestamp,
    });
    if (wasCollected) {
      totalCollected += 1;
    }
  }

  // Handle push after collection
  if (!opts.dryRun && totalCollected > 0) {
    const shouldPush = opts.push ?? (await promptPush());
    if (shouldPush) {
      await runPush({ collect: false });
    }
  }
}
