export type ConflictPolicy = "prompt" | "repoWins" | "localWins";
export type InstallMode = "symlink" | "copy";
export type SymlinkFallback = "copy" | "error" | "prompt";

export const VIBETOOLS_CONFIG_VERSION = 1 as const;
export type VibetoolsConfigVersion = typeof VIBETOOLS_CONFIG_VERSION;

export type VibetoolsArtifactType = "skills" | "commands";
export const VIBETOOLS_ARTIFACT_TYPES: readonly VibetoolsArtifactType[] = [
  "skills",
  "commands",
] as const;

export type AgentId = "codex" | "claude-code" | "opencode";
export const AGENT_IDS: readonly AgentId[] = [
  "codex",
  "claude-code",
  "opencode",
] as const;

export interface Filters {
  include: string[];
  exclude: string[];
}

export interface AgentConfig {
  enabled: boolean;
  paths: {
    skills: string | null;
    commands: string | null;
  };
  filters: {
    skills: Filters;
    commands: Filters;
  };
}

export interface VibetoolsConfig {
  version: VibetoolsConfigVersion;
  repoPath: string;
  conflictPolicy: ConflictPolicy;
  installMode: InstallMode;
  symlinkFallback: SymlinkFallback;
  backups: {
    enabled: boolean;
    dir: string;
  };
  agents: Record<AgentId, AgentConfig>;
}
