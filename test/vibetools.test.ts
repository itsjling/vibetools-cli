import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCollect } from "../src/commands/collect.js";
import { runInit } from "../src/commands/init.js";
import { runInstall } from "../src/commands/install.js";
import { runStatus } from "../src/commands/status.js";
import { loadConfig, saveConfig } from "../src/config/io.js";
import { repoAgentsSkillsDir } from "../src/repo/layout.js";
import { createSymlink, sameRealpath } from "../src/sync/symlink.js";
import { makeTempDir, rmTempDir, writeFile } from "./helpers.js";

let tempHome = "";

interface StatusJson {
  agents: {
    agentId: string;
    types: {
      type: string;
      entries: Record<string, { kind: string }>;
    }[];
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusJson(value: unknown): value is StatusJson {
  if (!isRecord(value)) {
    return false;
  }
  const { agents } = value;
  if (!Array.isArray(agents)) {
    return false;
  }
  for (const agent of agents) {
    if (!isRecord(agent)) {
      return false;
    }
    if (typeof agent.agentId !== "string") {
      return false;
    }
    if (!Array.isArray(agent.types)) {
      return false;
    }
    for (const type of agent.types) {
      if (!isRecord(type)) {
        return false;
      }
      if (typeof type.type !== "string") {
        return false;
      }
      if (!isRecord(type.entries)) {
        return false;
      }
    }
  }
  return true;
}

function parseStatusJsonFromLogs(logs: string[]): StatusJson {
  const parsed: unknown = JSON.parse(logs.join("\n"));
  if (!isStatusJson(parsed)) {
    throw new Error("Unexpected status JSON shape");
  }
  return parsed;
}

async function createAgentDirs(base: string): Promise<{
  agentSkills: string;
  agentCommands: string;
}> {
  const agentSkills = path.join(base, "agent", "skills");
  const agentCommands = path.join(base, "agent", "commands");
  await fs.mkdir(agentSkills, { recursive: true });
  await fs.mkdir(agentCommands, { recursive: true });
  return { agentCommands, agentSkills };
}

async function enableCodexInConfig(args: {
  repoPath: string;
  agentSkills: string;
  agentCommands: string;
}): Promise<void> {
  const { config, configPath } = await loadConfig();
  config.repoPath = args.repoPath;
  config.agents.codex.enabled = true;
  config.agents.codex.paths.skills = args.agentSkills;
  config.agents.codex.paths.commands = args.agentCommands;
  await saveConfig(config, configPath);
}

beforeEach(async () => {
  tempHome = await makeTempDir();
  process.env.VIBETOOLS_HOME = tempHome;
});

afterEach(async () => {
  delete process.env.VIBETOOLS_HOME;
  await rmTempDir(tempHome);
});

describe("vibetools", () => {
  it("init creates minimal repo layout", async () => {
    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    await expect(fs.lstat(path.join(repoPath, ".git"))).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(repoPath, ".agents", "skills"))
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(repoPath, ".agents", "commands"))
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(repoPath, "templates", "AGENTS.md"))
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(repoPath, "vibetools.repo.json"))
    ).resolves.toBeTruthy();
  });

  it("install creates per-item symlink by default", async () => {
    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    const repoSkill = path.join(
      repoAgentsSkillsDir(repoPath),
      "foo",
      "SKILL.md"
    );
    await writeFile(repoSkill, "# Foo skill\n");

    const agentSkills = path.join(tempHome, "agent", "skills");
    const agentCommands = path.join(tempHome, "agent", "commands");
    await fs.mkdir(agentSkills, { recursive: true });
    await fs.mkdir(agentCommands, { recursive: true });

    const { config, configPath } = await loadConfig();
    config.repoPath = repoPath;
    config.agents.codex.enabled = true;
    config.agents.codex.paths.skills = agentSkills;
    config.agents.codex.paths.commands = agentCommands;
    await saveConfig(config, configPath);

    await runInstall({
      agent: "codex",
      mode: "symlink",
      policy: "repoWins",
      type: "skills",
    });

    const dest = path.join(agentSkills, "foo");
    const src = path.join(repoAgentsSkillsDir(repoPath), "foo");
    await expect(sameRealpath(dest, src)).resolves.toBeTruthy();
  });

  it("install respects include filters", async () => {
    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    await writeFile(
      path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
      "foo\n"
    );
    await writeFile(
      path.join(repoAgentsSkillsDir(repoPath), "bar", "SKILL.md"),
      "bar\n"
    );

    const agentSkills = path.join(tempHome, "agent", "skills");
    const agentCommands = path.join(tempHome, "agent", "commands");
    await fs.mkdir(agentSkills, { recursive: true });
    await fs.mkdir(agentCommands, { recursive: true });

    const { config, configPath } = await loadConfig();
    config.repoPath = repoPath;
    config.agents.codex.enabled = true;
    config.agents.codex.paths.skills = agentSkills;
    config.agents.codex.paths.commands = agentCommands;
    config.agents.codex.filters.skills.include = ["foo"];
    config.agents.codex.filters.skills.exclude = [];
    await saveConfig(config, configPath);

    await runInstall({
      agent: "codex",
      mode: "symlink",
      policy: "repoWins",
      type: "skills",
    });

    await expect(fs.lstat(path.join(agentSkills, "foo"))).resolves.toBeTruthy();
    await expect(fs.lstat(path.join(agentSkills, "bar"))).rejects.toBeTruthy();
  });

  it("collect skips repo-pointing symlinks and can import extras", async () => {
    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    await writeFile(
      path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
      "foo\n"
    );

    const agentSkills = path.join(tempHome, "agent", "skills");
    const agentCommands = path.join(tempHome, "agent", "commands");
    await fs.mkdir(agentSkills, { recursive: true });
    await fs.mkdir(agentCommands, { recursive: true });

    // Create a repo-pointing local symlink for foo.
    await createSymlink(
      path.join(repoAgentsSkillsDir(repoPath), "foo"),
      path.join(agentSkills, "foo")
    );
    // Create a local-only extra.
    await writeFile(path.join(agentSkills, "baz", "SKILL.md"), "baz\n");

    const { config, configPath } = await loadConfig();
    config.repoPath = repoPath;
    config.agents.codex.enabled = true;
    config.agents.codex.paths.skills = agentSkills;
    config.agents.codex.paths.commands = agentCommands;
    await saveConfig(config, configPath);

    await runCollect({
      agent: "codex",
      importExtras: true,
      policy: "localWins",
      selectAll: true,
      type: "skills",
    });

    await expect(
      fs.readFile(
        path.join(repoAgentsSkillsDir(repoPath), "baz", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("baz");
  });

  it("collect does not import local-only entries without --import-extras", async () => {
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

    await runCollect({
      agent: "codex",
      importExtras: false,
      policy: "localWins",
      selectAll: true,
      type: "skills",
    });

    await expect(
      fs.lstat(path.join(repoAgentsSkillsDir(repoPath), "local"))
    ).rejects.toBeTruthy();
  });

  it("status reports broken symlinks", async () => {
    const repoPath = path.join(tempHome, "repo");
    await runInit({ repo: repoPath });

    await writeFile(
      path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
      "foo\n"
    );

    const { agentCommands, agentSkills } = await createAgentDirs(tempHome);

    // Point foo to the wrong target.
    const wrongTarget = path.join(tempHome, "wrong", "foo");
    await fs.mkdir(path.dirname(wrongTarget), { recursive: true });
    await writeFile(path.join(wrongTarget, "SKILL.md"), "wrong\n");
    await createSymlink(wrongTarget, path.join(agentSkills, "foo"));

    await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args) => logs.push(args.join(" ")));
    try {
      await runStatus({ agent: "codex", json: true, type: "skills" });
    } finally {
      spy.mockRestore();
    }
    const json = parseStatusJsonFromLogs(logs);
    const codex = json.agents.find((a) => a.agentId === "codex");
    expect(codex).toBeTruthy();
    const skills = codex?.types.find((t) => t.type === "skills");
    expect(skills).toBeTruthy();
    expect(skills?.entries.foo.kind).toBe("broken_symlink");
  });
});
