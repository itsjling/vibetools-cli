import chalk from "chalk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureGitAvailable } from "../git/git.js";
import { ensureDir, removeEntry } from "../sync/fs.js";
import { createSymlink } from "../sync/symlink.js";
import { VibetoolsError } from "../util/errors.js";
import {
  ensureRepoLooksInitialized,
  ensureWritableDir,
  loadConfigOrThrow,
} from "./_shared.js";

const EXIT_FAILURE = 1;

async function canSymlink(): Promise<boolean> {
  const base = path.join(os.tmpdir(), `vibetools-symlink-test-${Date.now()}`);
  const src = path.join(base, "src.txt");
  const dest = path.join(base, "dest.txt");
  try {
    await ensureDir(base);
    await fs.writeFile(src, "ok", "utf8");
    await createSymlink(src, dest);
    return true;
  } catch {
    return false;
  } finally {
    await removeEntry(base).catch(() => undefined);
  }
}

async function checkGit(): Promise<{ notes: string[]; issues: string[] }> {
  try {
    await ensureGitAvailable();
    return { issues: [], notes: ["git: OK"] };
  } catch {
    return { issues: ["git: not available in PATH"], notes: [] };
  }
}

async function checkRepo(
  repoPath: string
): Promise<{ notes: string[]; issues: string[] }> {
  try {
    await ensureRepoLooksInitialized(repoPath);
    return { issues: [], notes: [`repo: OK (${repoPath})`] };
  } catch {
    return { issues: [`repo: not initialized at ${repoPath}`], notes: [] };
  }
}

async function checkSymlink(
  installMode: string
): Promise<{ notes: string[]; issues: string[] }> {
  if (installMode !== "symlink") {
    return { issues: [], notes: [] };
  }
  const ok = await canSymlink();
  if (ok) {
    return { issues: [], notes: ["symlink: OK"] };
  }
  return {
    issues: ["symlink: failed (Windows Developer Mode/admin may be required)."],
    notes: [],
  };
}

async function checkAgentDirs(
  config: Awaited<ReturnType<typeof loadConfigOrThrow>>["config"]
): Promise<{
  notes: string[];
  issues: string[];
}> {
  const notes: string[] = [];
  const issues: string[] = [];
  for (const [agentId, agentCfg] of Object.entries(config.agents)) {
    if (!agentCfg.enabled) {
      continue;
    }
    if (!agentCfg.paths.skills) {
      issues.push(`${agentId}: skills path not set`);
    } else {
      try {
        await ensureWritableDir(agentCfg.paths.skills);
        notes.push(`${agentId}: skills dir writable`);
      } catch {
        issues.push(
          `${agentId}: skills dir not writable (${agentCfg.paths.skills})`
        );
      }
    }
    if (!agentCfg.paths.commands) {
      issues.push(`${agentId}: commands path not set`);
    } else {
      try {
        await ensureWritableDir(agentCfg.paths.commands);
        notes.push(`${agentId}: commands dir writable`);
      } catch {
        issues.push(
          `${agentId}: commands dir not writable (${agentCfg.paths.commands})`
        );
      }
    }
  }
  return { issues, notes };
}

export async function runDoctor(): Promise<void> {
  const { config } = await loadConfigOrThrow();
  const sections = await Promise.all([
    checkGit(),
    checkRepo(config.repoPath),
    checkSymlink(config.installMode),
    checkAgentDirs(config),
  ]);

  const notes = sections.flatMap((s) => s.notes);
  const issues = sections.flatMap((s) => s.issues);

  console.log(chalk.bold("Doctor"));
  for (const n of notes) {
    console.log(chalk.green(`- ${n}`));
  }
  for (const i of issues) {
    console.log(chalk.red(`- ${i}`));
  }

  if (issues.length > 0) {
    throw new VibetoolsError("Doctor found issues.", {
      exitCode: EXIT_FAILURE,
    });
  }
}
