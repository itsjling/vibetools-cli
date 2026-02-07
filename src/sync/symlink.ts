import fs from "node:fs/promises";
import path from "node:path";

type SymlinkType = "file" | "dir" | "junction" | undefined;

export async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function getSymlinkAbsoluteTarget(
  linkPath: string
): Promise<string | null> {
  try {
    const rawTarget = await fs.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), rawTarget);
  } catch {
    return null;
  }
}

export async function sameRealpath(a: string, b: string): Promise<boolean> {
  try {
    const ra = await fs.realpath(a);
    const rb = await fs.realpath(b);
    return ra === rb;
  } catch {
    return false;
  }
}

export async function createSymlink(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(src);
  const isDir = stat.isDirectory();
  // On Windows, directory symlinks often need elevated permissions; "junction" is more permissive.
  let type: SymlinkType = undefined;
  if (process.platform === "win32") {
    type = isDir ? "junction" : "file";
  }
  await fs.symlink(src, dest, type);
}
