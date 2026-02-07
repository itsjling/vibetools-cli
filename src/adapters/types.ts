import type { AgentId } from "../config/types.js";

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  defaultSkillsPath(): string | null;
  defaultCommandsPath(): string | null;
}
