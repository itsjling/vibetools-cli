import os from "node:os";
import path from "node:path";

import { getDefaultBackupsPath, getDefaultRepoPath } from "./paths.js";
import {
  VIBETOOLS_CONFIG_VERSION,
  type AgentConfig,
  type AgentId,
  type Filters,
  type VibetoolsArtifactType,
  type VibetoolsConfig,
} from "./types.js";

function defaultFilters() {
  return { exclude: [] as string[], include: ["**"] };
}

function defaultAgentConfig(): AgentConfig {
  return {
    enabled: false,
    filters: { commands: defaultFilters(), skills: defaultFilters() },
    paths: { commands: null, skills: null },
  };
}

function defaultCodexPaths() {
  const base = path.join(os.homedir(), ".codex");
  return {
    commands: path.join(base, "commands"),
    skills: path.join(base, "skills"),
  };
}

export function createDefaultConfig(): VibetoolsConfig {
  const codex = defaultAgentConfig();
  codex.enabled = true;
  codex.paths = defaultCodexPaths();

  const claude = defaultAgentConfig();
  const opencode = defaultAgentConfig();

  return {
    agents: {
      "claude-code": claude,
      codex,
      opencode,
    },
    backups: { dir: getDefaultBackupsPath(), enabled: true },
    conflictPolicy: "prompt",
    installMode: "symlink",
    repoPath: getDefaultRepoPath(),
    symlinkFallback: "copy",
    version: VIBETOOLS_CONFIG_VERSION,
  };
}

export function getAgentConfig(
  config: VibetoolsConfig,
  agentId: AgentId
): AgentConfig {
  return config.agents[agentId];
}

export function getAgentTypeFilters(
  config: VibetoolsConfig,
  agentId: AgentId,
  type: VibetoolsArtifactType
): Filters {
  return config.agents[agentId].filters[type];
}
