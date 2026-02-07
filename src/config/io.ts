import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, VibetoolsConfig } from "./types.js";

import { createDefaultConfig } from "./defaults.js";
import { getDefaultConfigPath, getVibetoolsHome } from "./paths.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function getString(
  obj: Record<string, unknown> | null,
  key: string
): string | undefined {
  if (!obj) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function getBoolean(
  obj: Record<string, unknown> | null,
  key: string
): boolean | undefined {
  if (!obj) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}

function coerceAgentConfig(value: unknown, fallback: AgentConfig): AgentConfig {
  const v = asRecord(value);
  if (!v) {
    return fallback;
  }

  const enabled = getBoolean(v, "enabled") ?? fallback.enabled;
  const pathsObj = asRecord(v.paths);
  const paths = {
    commands: getString(pathsObj, "commands") ?? fallback.paths.commands,
    skills: getString(pathsObj, "skills") ?? fallback.paths.skills,
  };

  const filtersObj = asRecord(v.filters);
  const skillsFilters = asRecord(filtersObj?.skills) ?? {};
  const commandsFilters = asRecord(filtersObj?.commands) ?? {};

  const filters = {
    commands: {
      exclude: isStringArray(commandsFilters.exclude)
        ? commandsFilters.exclude
        : fallback.filters.commands.exclude,
      include: isStringArray(commandsFilters.include)
        ? commandsFilters.include
        : fallback.filters.commands.include,
    },
    skills: {
      exclude: isStringArray(skillsFilters.exclude)
        ? skillsFilters.exclude
        : fallback.filters.skills.exclude,
      include: isStringArray(skillsFilters.include)
        ? skillsFilters.include
        : fallback.filters.skills.include,
    },
  };

  return { enabled, filters, paths };
}

function coerceConfig(value: unknown): VibetoolsConfig {
  const defaults = createDefaultConfig();
  const v = asRecord(value);
  if (!v) {
    return defaults;
  }
  const agentsObj = asRecord(v.agents);
  const backupsObj = asRecord(v.backups);

  const config: VibetoolsConfig = {
    agents: {
      "claude-code": coerceAgentConfig(
        agentsObj?.["claude-code"],
        defaults.agents["claude-code"]
      ),
      codex: coerceAgentConfig(agentsObj?.codex, defaults.agents.codex),
      opencode: coerceAgentConfig(
        agentsObj?.opencode,
        defaults.agents.opencode
      ),
    },
    backups: {
      dir: getString(backupsObj, "dir") ?? defaults.backups.dir,
      enabled: getBoolean(backupsObj, "enabled") ?? defaults.backups.enabled,
    },
    conflictPolicy:
      v.conflictPolicy === "repoWins" ||
      v.conflictPolicy === "localWins" ||
      v.conflictPolicy === "prompt"
        ? v.conflictPolicy
        : defaults.conflictPolicy,
    installMode:
      v.installMode === "copy" || v.installMode === "symlink"
        ? v.installMode
        : defaults.installMode,
    repoPath: getString(v, "repoPath") ?? defaults.repoPath,
    symlinkFallback:
      v.symlinkFallback === "copy" ||
      v.symlinkFallback === "error" ||
      v.symlinkFallback === "prompt"
        ? v.symlinkFallback
        : defaults.symlinkFallback,
    version: defaults.version,
  };

  return config;
}

export async function loadConfig(): Promise<{
  config: VibetoolsConfig;
  configPath: string;
}> {
  const configPath = getDefaultConfigPath();
  if (!(await pathExists(configPath))) {
    const config = createDefaultConfig();
    return { config, configPath };
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  return { config: coerceConfig(parsed), configPath };
}

export async function saveConfig(
  config: VibetoolsConfig,
  configPath?: string
): Promise<string> {
  const target = configPath ?? getDefaultConfigPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return target;
}

export async function ensureVibetoolsHome(): Promise<void> {
  await fs.mkdir(getVibetoolsHome(), { recursive: true });
}
