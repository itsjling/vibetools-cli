import os from "node:os";
import path from "node:path";

import type { AgentAdapter } from "./types.js";

function home(...parts: string[]) {
  return path.join(os.homedir(), ...parts);
}

export const adapters: AgentAdapter[] = [
  {
    defaultCommandsPath: () => home(".codex", "commands"),
    defaultSkillsPath: () => home(".codex", "skills"),
    displayName: "Codex",
    id: "codex",
  },
  {
    defaultCommandsPath: () => null,
    defaultSkillsPath: () => null,
    displayName: "Claude Code",
    id: "claude-code",
  },
  {
    defaultCommandsPath: () => null,
    defaultSkillsPath: () => null,
    displayName: "OpenCode",
    id: "opencode",
  },
];

export function getAdapter(id: AgentAdapter["id"]): AgentAdapter {
  const adapter = adapters.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return adapter;
}
