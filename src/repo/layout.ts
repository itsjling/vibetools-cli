import path from "node:path";

export function repoAgentsSkillsDir(repoPath: string): string {
  return path.join(repoPath, ".agents", "skills");
}

export function repoAgentsCommandsDir(repoPath: string): string {
  return path.join(repoPath, ".agents", "commands");
}

export function repoTemplatesAgentsMdDir(repoPath: string): string {
  return path.join(repoPath, "templates", "AGENTS.md");
}

export function repoMetadataPath(repoPath: string): string {
  return path.join(repoPath, "vibetools.repo.json");
}
