import os from "node:os";
import path from "node:path";

export function getVibetoolsHome(): string {
  const override = process.env.VIBETOOLS_HOME;
  if (override?.trim()) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".vibetools");
}

export function getDefaultRepoPath(): string {
  return path.join(getVibetoolsHome(), "repo");
}

export function getDefaultBackupsPath(): string {
  return path.join(getVibetoolsHome(), "backups");
}

export function getDefaultConfigPath(): string {
  return path.join(getVibetoolsHome(), "config.json");
}
