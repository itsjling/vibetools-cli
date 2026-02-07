import chalk from "chalk";
import fs from "node:fs/promises";
import path from "node:path";
import prompts from "prompts";

import type {
  AgentId,
  ConflictPolicy,
  InstallMode,
  SymlinkFallback,
  VibetoolsArtifactType,
} from "../config/types.js";

import { diffFiles } from "../sync/diff.js";
import { applyFilters } from "../sync/filters.js";
import {
  backupEntry,
  copyEntry,
  ensureDir,
  listTopLevelEntries,
  pathExists,
  removeEntry,
} from "../sync/fs.js";
import { areHashesEqual, hashEntry } from "../sync/hash.js";
import { createSymlink, isSymlink, sameRealpath } from "../sync/symlink.js";
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

interface InstallOptions {
  dryRun?: boolean;
  agent?: string;
  type?: string;
  policy?: string;
  mode?: string;
  force?: boolean;
}

type ConflictDecision = "replace" | "skip" | "abort";

function resolvePolicy(
  optsPolicy: string | undefined,
  configPolicy: ConflictPolicy
): ConflictPolicy {
  if (
    optsPolicy === "prompt" ||
    optsPolicy === "repoWins" ||
    optsPolicy === "localWins"
  ) {
    return optsPolicy;
  }
  return configPolicy;
}

function resolveInstallMode(
  optsMode: string | undefined,
  configInstallMode: InstallMode
): InstallMode {
  if (optsMode === "copy" || optsMode === "symlink") {
    return optsMode;
  }
  return configInstallMode;
}

async function decideConflict(args: {
  agentId: AgentId;
  type: VibetoolsArtifactType;
  name: string;
  src: string;
  dest: string;
  force: boolean;
}): Promise<ConflictDecision> {
  if (args.force) {
    return "replace";
  }

  // If both are files, allow showing diff.
  const srcStat = await fs.lstat(args.src).catch(() => null);
  const destStat = await fs.lstat(args.dest).catch(() => null);
  const canDiff =
    srcStat !== null &&
    destStat !== null &&
    srcStat.isFile() &&
    destStat.isFile();

  while (true) {
    const res = await prompts<{ decision: ConflictDecision | "diff" }>({
      choices: [
        { title: "Replace local with repo version", value: "replace" },
        { title: "Skip", value: "skip" },
        ...(canDiff ? [{ title: "Show diff", value: "diff" }] : []),
        { title: "Abort", value: "abort" },
      ],
      message: `Conflict: ${args.agentId} ${args.type} '${args.name}' already exists locally. What do you want to do?`,
      name: "decision",
      type: "select",
    });

    if (res.decision === "diff") {
      const patch = await diffFiles(args.src, args.dest);
      console.log(patch);
      continue;
    }
    return res.decision;
  }
}

async function isCorrectSymlink(dest: string, src: string): Promise<boolean> {
  return (await isSymlink(dest)) && (await sameRealpath(dest, src));
}

async function isIdenticalCopy(src: string, dest: string): Promise<boolean> {
  if (await isSymlink(dest)) {
    return false;
  }
  const [repoHash, localHash] = await Promise.all([
    hashEntry(src),
    hashEntry(dest),
  ]);
  return areHashesEqual(repoHash, localHash);
}

async function decideReplacement(args: {
  policy: ConflictPolicy;
  agentId: AgentId;
  type: VibetoolsArtifactType;
  name: string;
  src: string;
  dest: string;
  force: boolean;
}): Promise<ConflictDecision> {
  if (args.policy === "localWins") {
    return "skip";
  }
  if (args.policy === "repoWins") {
    return "replace";
  }
  return await decideConflict(args);
}

async function backupAndRemoveExisting(args: {
  dest: string;
  backupDest: string;
  backupsEnabled: boolean;
  dryRun: boolean;
}): Promise<void> {
  if (args.dryRun) {
    return;
  }
  if (args.backupsEnabled) {
    await backupEntry(args.dest, args.backupDest);
  }
  await removeEntry(args.dest);
}

async function installOne(args: {
  src: string;
  dest: string;
  installMode: InstallMode;
  symlinkFallback: SymlinkFallback;
  dryRun: boolean;
}): Promise<{ installed: boolean; modeUsed: InstallMode }> {
  await ensureDir(path.dirname(args.dest));
  if (args.dryRun) {
    return { installed: true, modeUsed: args.installMode };
  }

  if (args.installMode === "copy") {
    await copyEntry(args.src, args.dest);
    return { installed: true, modeUsed: "copy" };
  }

  try {
    await createSymlink(args.src, args.dest);
    return { installed: true, modeUsed: "symlink" };
  } catch (error) {
    if (args.symlinkFallback === "error") {
      throw error;
    }
    if (args.symlinkFallback === "copy") {
      await copyEntry(args.src, args.dest);
      return { installed: true, modeUsed: "copy" };
    }
    const res = await prompts<{ fallback: "copy" | "abort" }>({
      choices: [
        { title: "Fallback to copy", value: "copy" },
        { title: "Abort", value: "abort" },
      ],
      message: `Failed to create symlink for ${args.dest}.`,
      name: "fallback",
      type: "select",
    });
    if (res.fallback === "copy") {
      await copyEntry(args.src, args.dest);
      return { installed: true, modeUsed: "copy" };
    }
    throw new VibetoolsError("Aborted.", { cause: error, exitCode: 2 });
  }
}

async function installEntry(args: {
  agentId: AgentId;
  backupsEnabled: boolean;
  backupDest: string;
  dest: string;
  dryRun: boolean;
  force: boolean;
  installMode: InstallMode;
  name: string;
  policy: ConflictPolicy;
  src: string;
  symlinkFallback: SymlinkFallback;
  type: VibetoolsArtifactType;
}): Promise<"ok" | "abort"> {
  if (await pathExists(args.dest)) {
    if (await isCorrectSymlink(args.dest, args.src)) {
      return "ok";
    }
    if (await isIdenticalCopy(args.src, args.dest)) {
      return "ok";
    }

    const decision = await decideReplacement({
      agentId: args.agentId,
      dest: args.dest,
      force: args.force,
      name: args.name,
      policy: args.policy,
      src: args.src,
      type: args.type,
    });
    if (decision === "skip") {
      return "ok";
    }
    if (decision === "abort") {
      return "abort";
    }

    await backupAndRemoveExisting({
      backupDest: args.backupDest,
      backupsEnabled: args.backupsEnabled,
      dest: args.dest,
      dryRun: args.dryRun,
    });
  }

  const result = await installOne({
    dest: args.dest,
    dryRun: args.dryRun,
    installMode: args.installMode,
    src: args.src,
    symlinkFallback: args.symlinkFallback,
  });

  if (args.dryRun) {
    console.log(
      `${args.agentId} ${args.type}: would install ${args.name} (${args.installMode})`
    );
    return "ok";
  }

  console.log(
    chalk.green(
      `${args.agentId} ${args.type}: installed ${args.name} (${result.modeUsed === "symlink" ? "symlink" : "copy"})`
    )
  );
  return "ok";
}

async function installForAgentType(args: {
  agentId: AgentId;
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"];
  dryRun: boolean;
  force: boolean;
  installMode: InstallMode;
  policy: ConflictPolicy;
  timestamp: string;
  type: VibetoolsArtifactType;
}): Promise<"ok" | "abort"> {
  const agentCfg = args.config.agents[args.agentId];
  const localRoot = agentTypeDir(args.config, args.agentId, args.type);
  if (!localRoot) {
    return "ok";
  }
  const repoRoot = repoTypeDir(args.config.repoPath, args.type);
  const names = applyFilters(
    await listTopLevelEntries(repoRoot),
    agentCfg.filters[args.type]
  );

  for (const name of names) {
    const src = path.join(repoRoot, name);
    const dest = path.join(localRoot, name);
    const backupDest = path.join(
      args.config.backups.dir,
      args.timestamp,
      args.agentId,
      args.type,
      name
    );
    const result = await installEntry({
      agentId: args.agentId,
      backupDest,
      backupsEnabled: args.config.backups.enabled,
      dest,
      dryRun: args.dryRun,
      force: args.force,
      installMode: args.installMode,
      name,
      policy: args.policy,
      src,
      symlinkFallback: args.config.symlinkFallback,
      type: args.type,
    });
    if (result === "abort") {
      return "abort";
    }
  }

  return "ok";
}

async function installForAgent(args: {
  agentId: AgentId;
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"];
  dryRun: boolean;
  force: boolean;
  installMode: InstallMode;
  policy: ConflictPolicy;
  timestamp: string;
  types: VibetoolsArtifactType[];
}): Promise<"ok" | "abort"> {
  const agentCfg = args.config.agents[args.agentId];
  if (!agentCfg.enabled) {
    return "ok";
  }
  for (const type of args.types) {
    const result = await installForAgentType({
      agentId: args.agentId,
      config: args.config,
      dryRun: args.dryRun,
      force: args.force,
      installMode: args.installMode,
      policy: args.policy,
      timestamp: args.timestamp,
      type,
    });
    if (result === "abort") {
      return "abort";
    }
  }
  return "ok";
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);

  const agents = parseAgentFilter(opts.agent);
  const types = parseTypeFilter(opts.type);

  const policy = resolvePolicy(opts.policy, config.conflictPolicy);
  const installMode = resolveInstallMode(opts.mode, config.installMode);
  const timestamp = formatTimestampForPath();

  for (const agentId of agents) {
    const result = await installForAgent({
      agentId,
      config,
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
      installMode,
      policy,
      timestamp,
      types,
    });
    if (result === "abort") {
      throw new VibetoolsError("Aborted due to unresolved conflicts.", {
        exitCode: 2,
      });
    }
  }
}
