import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../config/io.js";
import {
  AGENT_IDS,
  VIBETOOLS_ARTIFACT_TYPES,
  type AgentId,
  type VibetoolsArtifactType,
  type VibetoolsConfig,
} from "../config/types.js";
import {
  repoAgentsCommandsDir,
  repoAgentsSkillsDir,
  repoMetadataPath,
} from "../repo/layout.js";
import { pathExists } from "../sync/fs.js";
import { VibetoolsError } from "../util/errors.js";

export async function loadConfigOrThrow(): Promise<{
  config: VibetoolsConfig;
  configPath: string;
}> {
  const { config, configPath } = await loadConfig();
  return { config, configPath };
}

function isAgentId(value: string): value is AgentId {
  return AGENT_IDS.some((id) => id === value);
}

function isArtifactType(value: string): value is VibetoolsArtifactType {
  return VIBETOOLS_ARTIFACT_TYPES.some((t) => t === value);
}

export function parseAgentFilter(agent?: string): AgentId[] {
  if (!agent) {
    return [...AGENT_IDS];
  }
  if (isAgentId(agent)) {
    return [agent];
  }
  throw new VibetoolsError(
    `Unknown agent '${agent}'. Expected one of: ${AGENT_IDS.join(", ")}.`,
    { exitCode: 1 }
  );
}

export function parseTypeFilter(type?: string): VibetoolsArtifactType[] {
  if (!type) {
    return [...VIBETOOLS_ARTIFACT_TYPES];
  }
  if (isArtifactType(type)) {
    return [type];
  }
  throw new VibetoolsError(
    `Unknown type '${type}'. Expected one of: ${VIBETOOLS_ARTIFACT_TYPES.join(", ")}.`,
    { exitCode: 1 }
  );
}

export async function ensureRepoLooksInitialized(
  repoPath: string
): Promise<void> {
  const skillsDir = repoAgentsSkillsDir(repoPath);
  const commandsDir = repoAgentsCommandsDir(repoPath);
  const metadataPath = repoMetadataPath(repoPath);
  const hasDirs =
    (await pathExists(skillsDir)) && (await pathExists(commandsDir));
  const hasMetadata = await pathExists(metadataPath);
  if (!hasDirs && !hasMetadata) {
    throw new VibetoolsError(
      `Repo at ${repoPath} does not look initialized. Run 'vibetools init' first.`,
      { exitCode: 1 }
    );
  }
}

export function repoTypeDir(
  repoPath: string,
  type: VibetoolsArtifactType
): string {
  return type === "skills"
    ? repoAgentsSkillsDir(repoPath)
    : repoAgentsCommandsDir(repoPath);
}

export function agentTypeDir(
  config: VibetoolsConfig,
  agentId: AgentId,
  type: VibetoolsArtifactType
): string | null {
  return type === "skills"
    ? config.agents[agentId].paths.skills
    : config.agents[agentId].paths.commands;
}

export async function ensureWritableDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const testPath = path.join(dir, `.vibetools-writecheck-${Date.now()}`);
  try {
    await fs.writeFile(testPath, "ok", "utf8");
  } finally {
    await fs.rm(testPath, { force: true });
  }
}
