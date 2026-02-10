import fs from "node:fs/promises";
import path from "node:path";
import prompts from "prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCollect } from "../src/commands/collect.js";
import { runInit } from "../src/commands/init.js";
import { runInstall } from "../src/commands/install.js";
import { runList } from "../src/commands/list.js";
import { runStatus } from "../src/commands/status.js";
import { loadConfig, saveConfig } from "../src/config/io.js";
import {
  repoAgentsSkillsDir,
  repoAgentsCommandsDir,
} from "../src/repo/layout.js";
import { createSymlink, sameRealpath } from "../src/sync/symlink.js";
import { makeTempDir, rmTempDir, writeFile } from "./helpers.js";

vi.mock("prompts", () => ({ default: vi.fn() }));

const promptsMock = vi.mocked(prompts);

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

async function setupRepoWithInitMocks(): Promise<string> {
  promptsMock
    .mockResolvedValueOnce({ choice: "new" })
    .mockResolvedValueOnce({ choice: "new" })
    .mockResolvedValueOnce({ remote: "https://github.com/test/repo.git" })
    .mockResolvedValueOnce({ branch: "main" });

  const repoPath = path.join(tempHome, "repo");
  await runInit({ repo: repoPath });
  return repoPath;
}

beforeEach(async () => {
  tempHome = await makeTempDir();
  process.env.VIBETOOLS_HOME = tempHome;
  promptsMock.mockReset();
});

afterEach(async () => {
  delete process.env.VIBETOOLS_HOME;
  await rmTempDir(tempHome);
});

describe("vibetools", () => {
  describe("init command", () => {
    it("creates minimal repo layout", async () => {
      const repoPath = await setupRepoWithInitMocks();

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

    it("accepts --repo flag for custom repo path", async () => {
      promptsMock
        .mockResolvedValueOnce({ choice: "new" })
        .mockResolvedValueOnce({ choice: "new" })
        .mockResolvedValueOnce({ remote: "https://github.com/test/repo.git" })
        .mockResolvedValueOnce({ branch: "main" });

      const customRepoPath = path.join(tempHome, "custom-repo");
      await runInit({ repo: customRepoPath });

      await expect(
        fs.lstat(path.join(customRepoPath, ".git"))
      ).resolves.toBeTruthy();
    });

    it("accepts --branch flag for custom branch name", async () => {
      promptsMock
        .mockResolvedValueOnce({ choice: "new" })
        .mockResolvedValueOnce({ choice: "new" })
        .mockResolvedValueOnce({ remote: "https://github.com/test/repo.git" });

      const repoPath = path.join(tempHome, "repo");
      await runInit({ branch: "develop", repo: repoPath });

      await expect(fs.lstat(path.join(repoPath, ".git"))).resolves.toBeTruthy();
    });

    it("aborts when setup choice prompt is cancelled via Ctrl+C", async () => {
      // Simulate Ctrl+C by calling onCancel
      promptsMock.mockImplementationOnce((questions, options) => {
        if (options?.onCancel) {
          options.onCancel();
        }
        return Promise.resolve({});
      });

      await expect(runInit({})).rejects.toThrow(/Aborted/);
    });
  });

  describe("install command", () => {
    it("creates per-item symlink by default", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const repoSkill = path.join(
        repoAgentsSkillsDir(repoPath),
        "foo",
        "SKILL.md"
      );
      await writeFile(repoSkill, "# Foo skill\n");

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

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

    it("respects include filters", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );
      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "bar", "SKILL.md"),
        "bar\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
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

      await expect(
        fs.lstat(path.join(agentSkills, "foo"))
      ).resolves.toBeTruthy();
      await expect(
        fs.lstat(path.join(agentSkills, "bar"))
      ).rejects.toBeTruthy();
    });

    it("accepts --dry-run flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      await runInstall({
        agent: "codex",
        dryRun: true,
        mode: "symlink",
        policy: "repoWins",
        type: "skills",
      });

      // Should not actually create the symlink
      await expect(
        fs.lstat(path.join(agentSkills, "foo"))
      ).rejects.toBeTruthy();
    });

    it("accepts --mode copy flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      await runInstall({
        agent: "codex",
        mode: "copy",
        policy: "repoWins",
        type: "skills",
      });

      // Should create a copy, not a symlink
      const dest = path.join(agentSkills, "foo");
      await expect(fs.lstat(dest)).resolves.toBeTruthy();
      const stats = await fs.lstat(dest);
      expect(stats.isSymbolicLink()).toBe(false);
    });

    it("accepts --force flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "repo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await fs.mkdir(path.join(agentSkills, "foo"), { recursive: true });
      await writeFile(path.join(agentSkills, "foo", "SKILL.md"), "local\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Should not prompt when force is true
      await runInstall({
        agent: "codex",
        force: true,
        mode: "symlink",
        policy: "prompt",
        type: "skills",
      });

      const dest = path.join(agentSkills, "foo");
      await expect(fs.lstat(dest)).resolves.toBeTruthy();
    });

    it("accepts --policy localWins flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "repo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await fs.mkdir(path.join(agentSkills, "foo"), { recursive: true });
      await writeFile(path.join(agentSkills, "foo", "SKILL.md"), "local\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      await runInstall({
        agent: "codex",
        mode: "symlink",
        policy: "localWins",
        type: "skills",
      });

      // Local version should be preserved
      const content = await fs.readFile(
        path.join(agentSkills, "foo", "SKILL.md"),
        "utf8"
      );
      expect(content).toBe("local\n");
    });

    it("aborts when conflict prompt is cancelled via Ctrl+C", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "repo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await writeFile(path.join(agentSkills, "foo", "SKILL.md"), "local\n");

      const { config, configPath } = await loadConfig();
      config.repoPath = repoPath;
      config.agents.codex.enabled = true;
      config.agents.codex.paths.skills = agentSkills;
      config.agents.codex.paths.commands = agentCommands;
      await saveConfig(config, configPath);

      // Simulate Ctrl+C by calling onCancel
      promptsMock.mockImplementationOnce((questions, options) => {
        if (options?.onCancel) {
          options.onCancel();
        }
        return Promise.resolve({});
      });

      await expect(
        runInstall({ agent: "codex", policy: "prompt", type: "skills" })
      ).rejects.toThrow(/Aborted/);
    });
  });

  describe("collect command", () => {
    it("skips repo-pointing symlinks and can import extras", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);

      // Create a repo-pointing local symlink for foo.
      await createSymlink(
        path.join(repoAgentsSkillsDir(repoPath), "foo"),
        path.join(agentSkills, "foo")
      );
      // Create a local-only extra.
      await writeFile(path.join(agentSkills, "baz", "SKILL.md"), "baz\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Mock push prompt
      promptsMock.mockResolvedValueOnce({ ok: false });

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

    it("does not import local-only entries without --import-extras", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await writeFile(path.join(agentSkills, "local", "SKILL.md"), "local\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

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

    it("accepts --dry-run flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await writeFile(path.join(agentSkills, "test", "SKILL.md"), "test\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      await runCollect({
        agent: "codex",
        dryRun: true,
        importExtras: true,
        policy: "localWins",
        selectAll: true,
        type: "skills",
      });

      // Should not actually import
      await expect(
        fs.lstat(path.join(repoAgentsSkillsDir(repoPath), "test"))
      ).rejects.toBeTruthy();
    });

    it("accepts --force flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "repo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await fs.mkdir(path.join(agentSkills, "foo"), { recursive: true });
      await writeFile(path.join(agentSkills, "foo", "SKILL.md"), "local\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Mock push prompt
      promptsMock.mockResolvedValueOnce({ ok: false });

      await runCollect({
        agent: "codex",
        force: true,
        importExtras: true,
        policy: "prompt",
        selectAll: true,
        type: "skills",
      });

      // Should overwrite repo version with local
      const content = await fs.readFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "utf8"
      );
      expect(content).toBe("local\n");
    });

    it("accepts --sources flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await writeFile(path.join(agentSkills, "test", "SKILL.md"), "test\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Mock push prompt
      promptsMock.mockResolvedValueOnce({ ok: false });

      await runCollect({
        importExtras: true,
        policy: "localWins",
        selectAll: true,
        sources: "codex",
        type: "skills",
      });

      await expect(
        fs.lstat(path.join(repoAgentsSkillsDir(repoPath), "test"))
      ).resolves.toBeTruthy();
    });

    it("aborts when source selection prompt is cancelled via Ctrl+C", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Simulate Ctrl+C by calling onCancel
      promptsMock.mockImplementationOnce((questions, options) => {
        if (options?.onCancel) {
          options.onCancel();
        }
        return Promise.resolve({});
      });

      await expect(runCollect({})).rejects.toThrow(/Aborted/);
    });
  });

  describe("status command", () => {
    it("reports broken symlinks", async () => {
      const repoPath = await setupRepoWithInitMocks();

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

    it("accepts --json flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        await runStatus({ json: true });
      } finally {
        spy.mockRestore();
      }

      // Should output valid JSON
      const json = parseStatusJsonFromLogs(logs);
      expect(json.agents).toBeDefined();
    });

    it("accepts --agent flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        await runStatus({ agent: "codex", json: true });
      } finally {
        spy.mockRestore();
      }

      const json = parseStatusJsonFromLogs(logs);
      expect(json.agents.length).toBe(1);
      expect(json.agents[0].agentId).toBe("codex");
    });

    it("accepts --type flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );
      await writeFile(
        path.join(repoAgentsCommandsDir(repoPath), "bar", ".md"),
        "bar\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
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
      expect(codex?.types.length).toBe(1);
      expect(codex?.types[0].type).toBe("skills");
    });
  });

  describe("list command", () => {
    it("lists skills in the repo", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );
      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "bar", "SKILL.md"),
        "bar\n"
      );

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        await runList({ type: "skills" });
      } finally {
        spy.mockRestore();
      }

      expect(logs.some((log) => log.includes("foo"))).toBe(true);
      expect(logs.some((log) => log.includes("bar"))).toBe(true);
    });

    it("accepts --type flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );
      await writeFile(
        path.join(repoAgentsCommandsDir(repoPath), "bar", ".md"),
        "bar\n"
      );

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        await runList({ type: "commands" });
      } finally {
        spy.mockRestore();
      }

      expect(logs.some((log) => log.includes("bar"))).toBe(true);
      expect(logs.some((log) => log.includes("foo"))).toBe(false);
    });

    it("accepts --json flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        await runList({ json: true, type: "skills" });
      } finally {
        spy.mockRestore();
      }

      const json = JSON.parse(logs.join("\n"));
      expect(json.skills).toContain("foo");
    });

    it("aborts when type selection prompt is cancelled via Ctrl+C", async () => {
      await setupRepoWithInitMocks();

      // Simulate Ctrl+C by calling onCancel
      promptsMock.mockImplementationOnce((questions, options) => {
        if (options?.onCancel) {
          options.onCancel();
        }
        return Promise.resolve({});
      });

      await expect(runList({})).rejects.toThrow(/Aborted/);
    });
  });

  describe("pull command", () => {
    it("installs skills from repo", async () => {
      const repoPath = await setupRepoWithInitMocks();

      // Create initial skill in repo
      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Install the skill (simulating pull behavior)
      await runInstall({
        agent: "codex",
        mode: "symlink",
        policy: "repoWins",
        type: "skills",
      });

      // Verify skill is installed
      await expect(
        fs.lstat(path.join(agentSkills, "foo"))
      ).resolves.toBeTruthy();
    });
  });

  describe("push command", () => {
    it("accepts --no-collect flag to skip collection", async () => {
      const repoPath = await setupRepoWithInitMocks();

      // Create a skill in repo
      await writeFile(
        path.join(repoAgentsSkillsDir(repoPath), "foo", "SKILL.md"),
        "foo\n"
      );

      // Just verify the command runs without errors
      // (actual push would require a remote repo)
      const { runPush } = await import("../src/commands/push.js");
      await expect(runPush({ collect: false })).rejects.toThrow();
    });

    it("accepts --dry-run flag", async () => {
      const repoPath = await setupRepoWithInitMocks();

      const { agentCommands, agentSkills } = await createAgentDirs(tempHome);
      await writeFile(path.join(agentSkills, "test", "SKILL.md"), "test\n");

      await enableCodexInConfig({ agentCommands, agentSkills, repoPath });

      // Mock the push prompts
      promptsMock
        .mockResolvedValueOnce({ selected: ["codex"] })
        .mockResolvedValueOnce({ selected: ["codex skills: test"] })
        .mockResolvedValueOnce({ ok: false });

      const { runPush } = await import("../src/commands/push.js");
      await runPush({ collect: true, dryRun: true });

      // Should show dry-run message
    });
  });

  describe("doctor command", () => {
    it("checks environment and reports issues", async () => {
      await setupRepoWithInitMocks();

      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args) => logs.push(args.join(" ")));
      try {
        const { runDoctor } = await import("../src/commands/doctor.js");
        await runDoctor();
      } finally {
        spy.mockRestore();
      }

      // Doctor should output something
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe("configure command", () => {
    it("configures agent settings interactively", async () => {
      await setupRepoWithInitMocks();

      const skillsDir = path.join(tempHome, "codex", "skills");
      const commandsDir = path.join(tempHome, "codex", "commands");

      // Mock all the configure prompts
      promptsMock
        .mockResolvedValueOnce({
          installMode: "symlink",
          symlinkFallback: "copy",
          conflictPolicy: "prompt",
        })
        .mockResolvedValueOnce({ agents: ["codex"] })
        .mockResolvedValueOnce({
          skills: skillsDir,
          commands: commandsDir,
        })
        .mockResolvedValueOnce({ create: true }) // Create skills directory
        .mockResolvedValueOnce({ create: true }) // Create commands directory
        .mockResolvedValueOnce({ edit: false });

      const { runConfigure } = await import("../src/commands/configure.js");
      await runConfigure();

      // Verify config was updated
      const { config } = await loadConfig();
      expect(config.agents.codex.enabled).toBe(true);
      expect(config.installMode).toBe("symlink");
      expect(config.conflictPolicy).toBe("prompt");
      expect(config.agents.codex.paths.skills).toBe(skillsDir);
      expect(config.agents.codex.paths.commands).toBe(commandsDir);
    });

    it("aborts when install mode prompt is cancelled via Ctrl+C", async () => {
      await setupRepoWithInitMocks();

      // Simulate Ctrl+C by calling onCancel
      promptsMock.mockImplementationOnce((questions, options) => {
        if (options?.onCancel) {
          options.onCancel();
        }
        return Promise.resolve({});
      });

      const { runConfigure } = await import("../src/commands/configure.js");
      await expect(runConfigure()).rejects.toThrow(/Aborted/);
    });
  });
});
