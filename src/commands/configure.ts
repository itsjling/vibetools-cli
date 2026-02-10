import chalk from "chalk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";

import { adapters, getAdapter } from "../adapters/adapters.js";
import { loadConfig, saveConfig } from "../config/io.js";
import {
  AGENT_IDS,
  type AgentId,
  type ConflictPolicy,
  type InstallMode,
  type SymlinkFallback,
  type VibetoolsConfig,
} from "../config/types.js";
import { VibetoolsError } from "../util/errors.js";
import { ensureRepoLooksInitialized } from "./_shared.js";

const INDEX_FIRST = 0;
const INDEX_SECOND = 1;
const INDEX_THIRD = 2;
const EMPTY_LENGTH = 0;

function promptOnCancel(): never {
  throw new VibetoolsError("Aborted.", { exitCode: 1 });
}

function expandUserPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirInteractive(dirPath: string): Promise<void> {
  if (await pathExists(dirPath)) {
    return;
  }
  const res = await prompts<{ create: boolean }>(
    {
      initial: true,
      message: `Directory does not exist: ${dirPath}\nCreate it?`,
      name: "create",
      type: "confirm",
    },
    { onCancel: promptOnCancel }
  );
  if (!res.create) {
    throw new Error(`Aborted (missing directory ${dirPath}).`);
  }
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizeList(value: string): string[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : ["**"];
}

async function configureFilters(
  config: VibetoolsConfig,
  agentId: AgentId,
  type: "skills" | "commands"
): Promise<void> {
  const current = config.agents[agentId].filters[type];
  const res = await prompts<{ include: string; exclude: string }>(
    [
      {
        initial: current.include.join(","),
        message: `${agentId} ${type} include globs (comma-separated)`,
        name: "include",
        type: "text",
      },
      {
        initial: current.exclude.join(","),
        message: `${agentId} ${type} exclude globs (comma-separated)`,
        name: "exclude",
        type: "text",
      },
    ],
    { onCancel: promptOnCancel }
  );
  config.agents[agentId].filters[type] = {
    exclude: String(res.exclude ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    include: normalizeList(String(res.include ?? "")),
  };
}

function getInstallModeInitial(config: VibetoolsConfig): number {
  return config.installMode === "copy" ? INDEX_SECOND : INDEX_FIRST;
}

function getSymlinkFallbackInitial(config: VibetoolsConfig): number {
  if (config.symlinkFallback === "prompt") {
    return INDEX_SECOND;
  }
  if (config.symlinkFallback === "error") {
    return INDEX_THIRD;
  }
  return INDEX_FIRST;
}

function getConflictPolicyInitial(config: VibetoolsConfig): number {
  if (config.conflictPolicy === "repoWins") {
    return INDEX_SECOND;
  }
  if (config.conflictPolicy === "localWins") {
    return INDEX_THIRD;
  }
  return INDEX_FIRST;
}

async function promptSettings(config: VibetoolsConfig): Promise<{
  installMode?: InstallMode;
  symlinkFallback?: SymlinkFallback;
  conflictPolicy?: ConflictPolicy;
}> {
  return await prompts<{
    installMode?: InstallMode;
    symlinkFallback?: SymlinkFallback;
    conflictPolicy?: ConflictPolicy;
  }>(
    [
      {
        choices: [
          {
            title: "Symlink (recommended)",
            value: "symlink" satisfies InstallMode,
          },
          { title: "Copy", value: "copy" satisfies InstallMode },
        ],
        initial: getInstallModeInitial(config),
        message: "Default install mode",
        name: "installMode",
        type: "select",
      },
      {
        choices: [
          {
            title: "Fallback to copy (recommended)",
            value: "copy" satisfies SymlinkFallback,
          },
          { title: "Prompt", value: "prompt" satisfies SymlinkFallback },
          { title: "Error", value: "error" satisfies SymlinkFallback },
        ],
        initial: getSymlinkFallbackInitial(config),
        message: "If symlink fails, then…",
        name: "symlinkFallback",
        type: (prev: unknown) => (prev === "symlink" ? "select" : null),
      },
      {
        choices: [
          {
            title: "Prompt (recommended)",
            value: "prompt" satisfies ConflictPolicy,
          },
          { title: "Repo wins", value: "repoWins" satisfies ConflictPolicy },
          { title: "Local wins", value: "localWins" satisfies ConflictPolicy },
        ],
        initial: getConflictPolicyInitial(config),
        message: "Default conflict policy",
        name: "conflictPolicy",
        type: "select",
      },
    ],
    { onCancel: promptOnCancel }
  );
}

async function promptEnabledAgents(
  config: VibetoolsConfig
): Promise<AgentId[]> {
  const enabledDefault = new Set(
    AGENT_IDS.filter((id) => config.agents[id].enabled)
  );
  const enabled = await prompts<{ agents?: AgentId[] }>(
    {
      choices: adapters.map((a) => ({
        selected: enabledDefault.has(a.id),
        title: a.displayName,
        value: a.id,
      })),
      hint: "- Space to select. Enter to submit.",
      message: "Enable which agents on this machine?",
      name: "agents",
      type: "multiselect",
    },
    { onCancel: promptOnCancel }
  );
  return enabled.agents ?? [];
}

async function promptAgentDirs(args: {
  agentName: string;
  defaults: { skills: string; commands: string };
}): Promise<{ skills: string; commands: string }> {
  return await prompts<{ skills: string; commands: string }>(
    [
      {
        initial: args.defaults.skills,
        message: `${args.agentName} skills directory`,
        name: "skills",
        type: "text",
        validate: (v: unknown) =>
          String(v).trim().length > EMPTY_LENGTH ? true : "Required",
      },
      {
        initial: args.defaults.commands,
        message: `${args.agentName} commands directory`,
        name: "commands",
        type: "text",
        validate: (v: unknown) =>
          String(v).trim().length > EMPTY_LENGTH ? true : "Required",
      },
    ],
    { onCancel: promptOnCancel }
  );
}

async function maybeEditFiltersForAgent(
  config: VibetoolsConfig,
  agentId: AgentId,
  agentName: string
): Promise<void> {
  const filterToggle = await prompts<{ edit: boolean }>(
    {
      initial: false,
      message: `Edit include/exclude globs for ${agentName}?`,
      name: "edit",
      type: "confirm",
    },
    { onCancel: promptOnCancel }
  );
  if (!filterToggle.edit) {
    return;
  }
  await configureFilters(config, agentId, "skills");
  await configureFilters(config, agentId, "commands");
}

async function configureAgent(
  config: VibetoolsConfig,
  agentId: AgentId
): Promise<void> {
  const adapter = getAdapter(agentId);
  const current = config.agents[agentId];
  const defaults = {
    commands: adapter.defaultCommandsPath() ?? current.paths.commands ?? "",
    skills: adapter.defaultSkillsPath() ?? current.paths.skills ?? "",
  };

  const res = await promptAgentDirs({
    agentName: adapter.displayName,
    defaults,
  });

  const skillsPath = path.resolve(expandUserPath(String(res.skills)));
  const commandsPath = path.resolve(expandUserPath(String(res.commands)));

  await ensureDirInteractive(skillsPath);
  await ensureDirInteractive(commandsPath);

  config.agents[agentId].paths.skills = skillsPath;
  config.agents[agentId].paths.commands = commandsPath;

  await maybeEditFiltersForAgent(config, agentId, adapter.displayName);
}

export async function runConfigure(): Promise<void> {
  const { config, configPath } = await loadConfig();
  await ensureRepoLooksInitialized(config.repoPath);

  const settings = await promptSettings(config);

  config.installMode = settings.installMode ?? config.installMode;
  config.symlinkFallback = settings.symlinkFallback ?? config.symlinkFallback;
  config.conflictPolicy = settings.conflictPolicy ?? config.conflictPolicy;

  const enabledAgents = await promptEnabledAgents(config);
  for (const id of AGENT_IDS) {
    config.agents[id].enabled = enabledAgents.includes(id);
  }

  for (const agentId of enabledAgents) {
    await configureAgent(config, agentId);
  }

  await saveConfig(config, configPath);
  console.log(chalk.green(`Saved config: ${configPath}`));
}
