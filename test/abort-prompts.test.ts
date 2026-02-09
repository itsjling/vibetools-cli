import fs from "node:fs/promises";
import path from "node:path";
import prompts from "prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, saveConfig } from "../src/config/io.js";
import { repoAgentsSkillsDir } from "../src/repo/layout.js";
import { makeTempDir, rmTempDir, writeFile } from "./helpers.js";

vi.mock("prompts", () => ({ default: vi.fn() }));

const promptsMock = vi.mocked(prompts);

let tempHome = "";

beforeEach(async () => {
  tempHome = await makeTempDir();
  process.env.VIBETOOLS_HOME = tempHome;
  promptsMock.mockReset();
});

afterEach(async () => {
  delete process.env.VIBETOOLS_HOME;
  await rmTempDir(tempHome);
});

describe("prompt abort handling", () => {
  it("install aborts when conflict prompt is cancelled", async () => {
    // Set up mock responses BEFORE importing and calling runInit
    // RunInit needs: promptRemoteChoice (choice: "new"), promptRemoteUrl, promptBranchName
    promptsMock
      .mockResolvedValueOnce({ choice: "new" })
      .mockResolvedValueOnce({ remote: "https://github.com/test/repo.git" })
      .mockResolvedValueOnce({ branch: "main" });

    const { runInit } = await import("../src/commands/init.js");
    const { runInstall } = await import("../src/commands/install.js");

    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    await writeFile(
      path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
      "repo\n"
    );

    const agentSkills = path.join(tempHome, "agent", "skills");
    const agentCommands = path.join(tempHome, "agent", "commands");
    await fs.mkdir(agentSkills, { recursive: true });
    await fs.mkdir(agentCommands, { recursive: true });
    await writeFile(path.join(agentSkills, "foo", "SKILL.md"), "local\n");

    const { config, configPath } = await loadConfig();
    config.repoPath = repoPath;
    config.agents.codex.enabled = true;
    config.agents.codex.paths.skills = agentSkills;
    config.agents.codex.paths.commands = agentCommands;
    await saveConfig(config, configPath);

    promptsMock.mockResolvedValueOnce({});

    await expect(
      runInstall({ agent: "codex", policy: "prompt", type: "skills" })
    ).rejects.toThrow(/Aborted/);
  });

  it("collect aborts when conflict prompt is cancelled", async () => {
    // Set up mock responses BEFORE importing and calling runInit
    promptsMock
      .mockResolvedValueOnce({ choice: "new" })
      .mockResolvedValueOnce({ remote: "https://github.com/test/repo.git" })
      .mockResolvedValueOnce({ branch: "main" })
      .mockResolvedValueOnce({ selected: ["local"] })
      .mockResolvedValueOnce({});

    const { runInit } = await import("../src/commands/init.js");
    const { runCollect } = await import("../src/commands/collect.js");

    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    const agentSkills = path.join(tempHome, "agent", "skills");
    const agentCommands = path.join(tempHome, "agent", "commands");
    await fs.mkdir(agentSkills, { recursive: true });
    await fs.mkdir(agentCommands, { recursive: true });
    await writeFile(path.join(agentSkills, "local", "SKILL.md"), "local\n");

    const { config, configPath } = await loadConfig();
    config.repoPath = repoPath;
    config.agents.codex.enabled = true;
    config.agents.codex.paths.skills = agentSkills;
    config.agents.codex.paths.commands = agentCommands;
    await saveConfig(config, configPath);

    await expect(
      runCollect({
        agent: "codex",
        importExtras: false,
        policy: "prompt",
        type: "skills",
      })
    ).rejects.toThrow(/Aborted/);
  });
});
