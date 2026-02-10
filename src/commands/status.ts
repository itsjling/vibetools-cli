import chalk from "chalk";
import path from "node:path";

import type { AgentId, VibetoolsArtifactType } from "../config/types.js";

import {
  ensureGitAvailable,
  getAheadBehind,
  getGitStatusPorcelain,
  git,
  hasOriginRemote,
} from "../git/git.js";
import { applyFilters } from "../sync/filters.js";
import { listTopLevelEntries, pathExists } from "../sync/fs.js";
import { areHashesEqual, hashEntry, type HashSummary } from "../sync/hash.js";
import { isSymlink, sameRealpath } from "../sync/symlink.js";
import {
  agentTypeDir,
  ensureRepoLooksInitialized,
  loadConfigOrThrow,
  parseAgentFilter,
  parseTypeFilter,
  repoTypeDir,
} from "./_shared.js";

interface StatusOptions {
  json?: boolean;
  remote?: boolean;
  agent?: string;
  type?: string;
}

type ItemStatus =
  | { kind: "remote_only" }
  | { kind: "ok_symlink" }
  | { kind: "broken_symlink" }
  | { kind: "ok_copy" }
  | { kind: "diverged"; repo: string; local: string };

interface TypeStatus {
  type: VibetoolsArtifactType;
  repoRoot: string;
  localRoot: string | null;
  entries: Record<string, ItemStatus>;
  localOnly: string[];
}

interface AgentStatus {
  agentId: AgentId;
  enabled: boolean;
  types: TypeStatus[];
}

type GitInfo =
  | null
  | { origin: false; dirty: boolean; aheadBehind: null }
  | {
      origin: true;
      dirty: boolean;
      aheadBehind: { ahead: number; behind: number } | null;
    };

const EMPTY_LENGTH = 0;
const JSON_INDENT = 2;

function hashSummaryLabel(summary: HashSummary): string {
  if (summary.kind === "file" || summary.kind === "dir") {
    return summary.sha256;
  }
  return summary.kind;
}

async function getItemStatus(src: string, dest: string): Promise<ItemStatus> {
  if (!(await pathExists(dest))) {
    return { kind: "remote_only" };
  }
  if (await isSymlink(dest)) {
    const ok = await sameRealpath(dest, src);
    return ok ? { kind: "ok_symlink" } : { kind: "broken_symlink" };
  }

  const [repoHash, localHash] = await Promise.all([
    hashEntry(src),
    hashEntry(dest),
  ]);
  if (areHashesEqual(repoHash, localHash)) {
    return { kind: "ok_copy" };
  }
  return {
    kind: "diverged",
    local: hashSummaryLabel(localHash),
    repo: hashSummaryLabel(repoHash),
  };
}

async function getLocalOnly(args: {
  agentFilters: { include: string[]; exclude: string[] };
  localRoot: string;
  repoEntries: string[];
  repoRoot: string;
}): Promise<string[]> {
  const localEntriesAll = applyFilters(
    await listTopLevelEntries(args.localRoot),
    args.agentFilters
  );
  const repoSet = new Set(args.repoEntries);
  const localOnly: string[] = [];
  for (const name of localEntriesAll) {
    if (repoSet.has(name)) {
      continue;
    }
    const dest = path.join(args.localRoot, name);
    const src = path.join(args.repoRoot, name);
    if ((await isSymlink(dest)) && (await sameRealpath(dest, src))) {
      continue;
    }
    localOnly.push(name);
  }
  return localOnly;
}

async function getTypeStatus(args: {
  agentId: AgentId;
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"];
  type: VibetoolsArtifactType;
}): Promise<TypeStatus> {
  const agentCfg = args.config.agents[args.agentId];
  const repoRoot = repoTypeDir(args.config.repoPath, args.type);
  const localRoot = agentTypeDir(args.config, args.agentId, args.type);
  const entries: Record<string, ItemStatus> = {};

  const repoEntries = applyFilters(
    await listTopLevelEntries(repoRoot),
    agentCfg.filters[args.type]
  );
  if (!localRoot) {
    for (const name of repoEntries) {
      entries[name] = { kind: "remote_only" };
    }
    return { entries, localOnly: [], localRoot, repoRoot, type: args.type };
  }

  for (const name of repoEntries) {
    const src = path.join(repoRoot, name);
    const dest = path.join(localRoot, name);
    entries[name] = await getItemStatus(src, dest);
  }

  const localOnly = await getLocalOnly({
    agentFilters: agentCfg.filters[args.type],
    localRoot,
    repoEntries,
    repoRoot,
  });
  return { entries, localOnly, localRoot, repoRoot, type: args.type };
}

async function getAgentStatus(args: {
  agentId: AgentId;
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"];
  types: VibetoolsArtifactType[];
}): Promise<AgentStatus> {
  const agentCfg = args.config.agents[args.agentId];
  if (!agentCfg.enabled) {
    return { agentId: args.agentId, enabled: false, types: [] };
  }

  const typeStatuses: TypeStatus[] = [];
  for (const type of args.types) {
    typeStatuses.push(
      await getTypeStatus({ agentId: args.agentId, config: args.config, type })
    );
  }
  return { agentId: args.agentId, enabled: true, types: typeStatuses };
}

async function getGitInfo(repoPath: string): Promise<GitInfo> {
  await ensureGitAvailable();
  const origin = await hasOriginRemote(repoPath);
  const porcelain = await getGitStatusPorcelain(repoPath);
  if (!origin) {
    return {
      aheadBehind: null,
      dirty: porcelain.length > EMPTY_LENGTH,
      origin: false,
    };
  }

  await git(repoPath, ["fetch"]);
  const aheadBehind = await getAheadBehind(repoPath);
  return { aheadBehind, dirty: porcelain.length > EMPTY_LENGTH, origin: true };
}

function renderGitInfo(info: GitInfo): void {
  if (!info) {
    return;
  }
  if (!info.origin) {
    console.log(chalk.yellow("Git: no origin remote configured."));
    return;
  }
  if (info.aheadBehind) {
    console.log(
      `Git: ahead ${info.aheadBehind.ahead}, behind ${info.aheadBehind.behind}, dirty ${info.dirty}`
    );
    return;
  }
  console.log(`Git: dirty ${info.dirty}`);
}

function kindCounts(
  entries: Record<string, ItemStatus>
): Record<ItemStatus["kind"], number> {
  const counts: Record<ItemStatus["kind"], number> = {
    broken_symlink: 0,
    diverged: 0,
    remote_only: 0,
    ok_copy: 0,
    ok_symlink: 0,
  };
  for (const v of Object.values(entries)) {
    counts[v.kind] += 1;
  }
  return counts;
}

function renderHuman(
  repoPath: string,
  agentStatuses: AgentStatus[],
  gitInfo: GitInfo
): void {
  console.log(chalk.bold(`Repo: ${repoPath}`));
  renderGitInfo(gitInfo);

  for (const agent of agentStatuses) {
    console.log("");
    console.log(
      chalk.bold(`${agent.agentId}${agent.enabled ? "" : " (disabled)"}`)
    );
    for (const t of agent.types) {
      const counts = kindCounts(t.entries);
      const orange = chalk.hex("#FFA500");
      console.log(
        `  ${t.type}: ok_symlink ${chalk.green(counts.ok_symlink)}, ok_copy ${chalk.green(counts.ok_copy)}, diverged ${orange(counts.diverged)}, broken_symlink ${chalk.red(counts.broken_symlink)}, remote_only ${chalk.yellow(counts.remote_only)}, local_only ${chalk.cyan(t.localOnly.length)}`
      );
      if (t.localRoot) {
        console.log(chalk.dim(`    local: ${t.localRoot}`));
      }
    }
  }
}

export async function runStatus(opts: StatusOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);

  const agents = parseAgentFilter(opts.agent);
  const types = parseTypeFilter(opts.type);

  const agentStatuses: AgentStatus[] = [];
  for (const agentId of agents) {
    agentStatuses.push(await getAgentStatus({ agentId, config, types }));
  }

  const gitInfo = opts.remote ? await getGitInfo(config.repoPath) : null;

  if (opts.json) {
    console.log(
      JSON.stringify(
        { agents: agentStatuses, git: gitInfo, repoPath: config.repoPath },
        null,
        JSON_INDENT
      )
    );
    return;
  }

  renderHuman(config.repoPath, agentStatuses, gitInfo);
}
