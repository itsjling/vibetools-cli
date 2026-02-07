import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_IGNORE_BASENAMES } from "./ignore.js";

export type HashSummary =
  | { kind: "missing" }
  | { kind: "symlink"; target: string | null }
  | { kind: "file"; sha256: string; bytes: number }
  | { kind: "dir"; sha256: string; files: number };

async function sha256File(
  filePath: string
): Promise<{ sha256: string; bytes: number }> {
  const buf = await fs.readFile(filePath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return { bytes: buf.byteLength, sha256: hash };
}

async function hashSymlink(entryPath: string): Promise<HashSummary> {
  try {
    const target = await fs.readlink(entryPath);
    return { kind: "symlink", target };
  } catch {
    return { kind: "symlink", target: null };
  }
}

async function walkDir(root: string, relative = ""): Promise<string[]> {
  const abs = path.join(root, relative);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (DEFAULT_IGNORE_BASENAMES.has(entry.name)) {
      continue;
    }
    const rel = path.join(relative, entry.name);
    const childAbs = path.join(root, rel);
    const stat = await fs.lstat(childAbs);
    if (stat.isSymbolicLink()) {
      // Hash the link itself by recording its target.
      files.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...(await walkDir(root, rel)));
    } else {
      files.push(rel);
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

async function hashDirectory(entryPath: string): Promise<HashSummary> {
  const files = await walkDir(entryPath);
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    const abs = path.join(entryPath, rel);
    const childStat = await fs.lstat(abs);
    hash.update(rel);
    if (childStat.isSymbolicLink()) {
      const target = await fs.readlink(abs);
      hash.update("->");
      hash.update(target);
    } else {
      const buf = await fs.readFile(abs);
      hash.update(buf);
    }
    hash.update("\n");
  }
  return { files: files.length, kind: "dir", sha256: hash.digest("hex") };
}

export async function hashEntry(entryPath: string): Promise<HashSummary> {
  try {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      return await hashSymlink(entryPath);
    }
    if (stat.isDirectory()) {
      return await hashDirectory(entryPath);
    }
    const { sha256, bytes } = await sha256File(entryPath);
    return { bytes, kind: "file", sha256 };
  } catch {
    return { kind: "missing" };
  }
}

export function areHashesEqual(a: HashSummary, b: HashSummary): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "missing": {
      return true;
    }
    case "symlink": {
      if (b.kind !== "symlink") {
        return false;
      }
      return a.target === b.target;
    }
    case "file": {
      if (b.kind !== "file") {
        return false;
      }
      return a.sha256 === b.sha256;
    }
    case "dir": {
      if (b.kind !== "dir") {
        return false;
      }
      return a.sha256 === b.sha256;
    }
    default: {
      return false;
    }
  }
}
