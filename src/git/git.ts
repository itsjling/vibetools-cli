import { spawn, type SpawnOptions } from "node:child_process";

import { VibetoolsError } from "../util/errors.js";

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EMPTY_LENGTH = 0;
const PARTS_EXPECTED = 2;
const INDEX_BEHIND = 0;
const INDEX_AHEAD = 1;

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<GitResult> {
  return await new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(cmd, args, spawnOptions);
    if (!child.stdout || !child.stderr) {
      reject(new Error("Failed to create child process with piped stdio."));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) =>
      resolve({ code: code ?? EXIT_FAILURE, stderr, stdout })
    );
  });
}

export async function ensureGitAvailable(): Promise<void> {
  const result = await run("git", ["--version"], {});
  if (result.code !== EXIT_SUCCESS) {
    throw new VibetoolsError("git is required but was not found in PATH.", {
      exitCode: 1,
    });
  }
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const result = await run("git", args, { cwd });
  return result;
}

export async function gitOrThrow(
  cwd: string,
  args: string[],
  message: string
): Promise<GitResult> {
  const result = await git(cwd, args);
  if (result.code !== EXIT_SUCCESS) {
    throw new VibetoolsError(
      `${message}\n${result.stderr.trim() || result.stdout.trim()}`.trim(),
      { exitCode: 1 }
    );
  }
  return result;
}

export async function getGitStatusPorcelain(repoPath: string): Promise<string> {
  const result = await gitOrThrow(
    repoPath,
    ["status", "--porcelain"],
    "Failed to get git status."
  );
  return result.stdout.trim();
}

export async function hasOriginRemote(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ["remote", "get-url", "origin"]);
  return (
    result.code === EXIT_SUCCESS && result.stdout.trim().length > EMPTY_LENGTH
  );
}

export async function getAheadBehind(
  repoPath: string
): Promise<{ ahead: number; behind: number } | null> {
  // Requires upstream; returns null if not configured.
  const result = await git(repoPath, [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{u}",
  ]);
  if (result.code !== EXIT_SUCCESS) {
    return null;
  }
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length !== PARTS_EXPECTED) {
    return null;
  }
  const behind = Number(parts[INDEX_BEHIND]);
  const ahead = Number(parts[INDEX_AHEAD]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
}

export interface FileChange {
  path: string;
  status: "added" | "deleted" | "updated";
}

export async function getDiffSummary(
  repoPath: string,
  ref?: string
): Promise<FileChange[]> {
  const args = ref
    ? ["diff", "--name-status", ref]
    : ["diff", "--name-status", "HEAD~1", "HEAD"];
  const result = await git(repoPath, args);
  if (result.code !== EXIT_SUCCESS) {
    return [];
  }

  const changes: FileChange[] = [];
  const lines = result.stdout.trim().split("\n");

  for (const line of lines) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const status = parts[0];
    const filePath = parts[1];

    let changeStatus: "added" | "deleted" | "updated";
    if (status === "A") {
      changeStatus = "added";
    } else if (status === "D") {
      changeStatus = "deleted";
    } else {
      changeStatus = "updated";
    }

    changes.push({ path: filePath, status: changeStatus });
  }

  return changes;
}

export async function getStagedChanges(
  repoPath: string
): Promise<FileChange[]> {
  const result = await git(repoPath, ["diff", "--cached", "--name-status"]);
  if (result.code !== EXIT_SUCCESS) {
    return [];
  }

  const changes: FileChange[] = [];
  const lines = result.stdout.trim().split("\n");

  for (const line of lines) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const status = parts[0];
    const filePath = parts[1];

    let changeStatus: "added" | "deleted" | "updated";
    if (status === "A") {
      changeStatus = "added";
    } else if (status === "D") {
      changeStatus = "deleted";
    } else {
      changeStatus = "updated";
    }

    changes.push({ path: filePath, status: changeStatus });
  }

  return changes;
}
