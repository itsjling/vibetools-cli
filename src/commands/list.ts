import chalk from "chalk";
import fs from "node:fs/promises";
import prompts from "prompts";

import { repoTemplatesAgentsMdDir } from "../repo/layout.js";
import { listTopLevelEntries } from "../sync/fs.js";
import { VibetoolsError } from "../util/errors.js";
import {
  ensureRepoLooksInitialized,
  loadConfigOrThrow,
  repoTypeDir,
} from "./_shared.js";

interface ListOptions {
  type?: string;
  json?: boolean;
}

type ListableType = "skills" | "commands" | "templates" | "all";

const VALID_TYPES: ListableType[] = ["skills", "commands", "templates", "all"];

const JSON_INDENT = 2;

function isValidType(value: string): value is ListableType {
  return VALID_TYPES.includes(value as ListableType);
}

function promptOnCancel(): never {
  throw new VibetoolsError("Aborted.", { exitCode: 1 });
}

async function promptForType(): Promise<ListableType> {
  const response = await prompts<{ type: ListableType }>(
    {
      choices: [
        { title: "Skills", value: "skills" },
        { title: "Commands", value: "commands" },
        { title: "Templates", value: "templates" },
        { title: "All", value: "all" },
      ],
      message: "What would you like to list?",
      name: "type",
      type: "select",
    },
    { onCancel: promptOnCancel }
  );

  if (!response.type) {
    throw new VibetoolsError("Aborted.", { exitCode: 1 });
  }

  return response.type;
}

async function listSkills(repoPath: string): Promise<string[]> {
  const skillsDir = repoTypeDir(repoPath, "skills");
  return listTopLevelEntries(skillsDir);
}

async function listCommands(repoPath: string): Promise<string[]> {
  const commandsDir = repoTypeDir(repoPath, "commands");
  return listTopLevelEntries(commandsDir);
}

async function listTemplates(repoPath: string): Promise<string[]> {
  const templatesDir = repoTemplatesAgentsMdDir(repoPath);
  const exists = await fs
    .access(templatesDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return [];
  }

  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b));
}

interface ListResult {
  commands: string[];
  skills: string[];
  templates: string[];
}

async function getAllListings(repoPath: string): Promise<ListResult> {
  const [skills, commands, templates] = await Promise.all([
    listSkills(repoPath),
    listCommands(repoPath),
    listTemplates(repoPath),
  ]);

  return { commands, skills, templates };
}

function renderHuman(result: ListResult, type: ListableType): void {
  const sections: { items: string[]; title: string }[] = [];

  if (type === "all" || type === "skills") {
    sections.push({
      items: result.skills,
      title: "Skills",
    });
  }

  if (type === "all" || type === "commands") {
    sections.push({
      items: result.commands,
      title: "Commands",
    });
  }

  if (type === "all" || type === "templates") {
    sections.push({
      items: result.templates,
      title: "Templates",
    });
  }

  for (const section of sections) {
    console.log(chalk.bold(section.title));

    if (section.items.length === 0) {
      console.log(chalk.gray("  (none)"));
    } else {
      for (const item of section.items) {
        console.log(`  ${item}`);
      }
    }

    console.log();
  }
}

function renderJson(result: ListResult, type: ListableType): void {
  if (type === "all") {
    console.log(JSON.stringify(result, null, JSON_INDENT));
  } else {
    console.log(JSON.stringify({ [type]: result[type] }, null, JSON_INDENT));
  }
}

export async function runList(opts: ListOptions): Promise<void> {
  const { config } = await loadConfigOrThrow();
  await ensureRepoLooksInitialized(config.repoPath);

  let type: ListableType;

  if (opts.type) {
    if (!isValidType(opts.type)) {
      throw new VibetoolsError(
        `Unknown type '${opts.type}'. Expected one of: ${VALID_TYPES.join(", ")}.`,
        { exitCode: 1 }
      );
    }
    ({ type } = opts);
  } else {
    type = await promptForType();
  }

  const result = await getAllListings(config.repoPath);

  if (opts.json) {
    renderJson(result, type);
  } else {
    renderHuman(result, type);
  }
}
