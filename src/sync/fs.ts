import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_IGNORE_BASENAMES } from "./ignore.js";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function listTopLevelEntries(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !DEFAULT_IGNORE_BASENAMES.has(e.name))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b));
}

export async function removeEntry(p: string): Promise<void> {
  await fs.rm(p, { force: true, recursive: true });
}

export async function copyEntry(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(src);
  await ensureDir(path.dirname(dest));
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(src);
    await fs.symlink(linkTarget, dest);
    return;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const children = await fs.readdir(src, { withFileTypes: true });
    for (const child of children) {
      if (DEFAULT_IGNORE_BASENAMES.has(child.name)) {
        continue;
      }
      await copyEntry(path.join(src, child.name), path.join(dest, child.name));
    }
    return;
  }
  await fs.copyFile(src, dest);
}

export async function copyEntryDereference(
  src: string,
  dest: string
): Promise<void> {
  const stat = await fs.lstat(src);
  await ensureDir(path.dirname(dest));
  if (stat.isSymbolicLink()) {
    const resolved = await fs.realpath(src);
    await copyEntryDereference(resolved, dest);
    return;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const children = await fs.readdir(src, { withFileTypes: true });
    for (const child of children) {
      if (DEFAULT_IGNORE_BASENAMES.has(child.name)) {
        continue;
      }
      await copyEntryDereference(
        path.join(src, child.name),
        path.join(dest, child.name)
      );
    }
    return;
  }
  await fs.copyFile(src, dest);
}

export async function backupEntry(
  srcExisting: string,
  backupDest: string
): Promise<void> {
  await copyEntry(srcExisting, backupDest);
}
