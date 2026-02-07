import chalk from "chalk";
import { Command } from "commander";

import { runCollect } from "./commands/collect.js";
import { runConfigure } from "./commands/configure.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runInstall } from "./commands/install.js";
import { runPull } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runStatus } from "./commands/status.js";
import { VibetoolsError } from "./util/errors.js";

const program = new Command();

program
  .name("vibetools")
  .description("Manage agent skills/commands via a git-backed repo.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize the vibetools git repo and directory structure.")
  .option("--repo <path>", "Repo path (default: ~/.vibetools/repo)")
  .option("--remote <url>", "Optional git remote URL (origin)")
  .action(async (opts) => runInit(opts));

program
  .command("configure")
  .description("Configure local agent install paths and preferences.")
  .action(async () => runConfigure());

program
  .command("status")
  .description("Show sync status between repo and enabled agents.")
  .option("--json", "Output machine-readable JSON")
  .option("--remote", "Fetch and show git ahead/behind (if remote configured)")
  .option(
    "--agent <id>",
    "Filter to a single agent (codex|claude-code|cursor|opencode)"
  )
  .option("--type <type>", "Filter to a single type (skills|commands)")
  .action(async (opts) => runStatus(opts));

program
  .command("install")
  .description(
    "Install repo skills/commands into enabled agents (symlink or copy)."
  )
  .option("--dry-run", "Print planned operations without writing")
  .option(
    "--agent <id>",
    "Filter to a single agent (codex|claude-code|cursor|opencode)"
  )
  .option("--type <type>", "Filter to a single type (skills|commands)")
  .option("--policy <policy>", "Conflict policy (prompt|repoWins|localWins)")
  .option("--mode <mode>", "Install mode (symlink|copy)")
  .option("--force", "Do not confirm per conflict (still backs up)")
  .action(async (opts) => runInstall(opts));

program
  .command("collect")
  .description("Collect skills/commands from enabled agents into the repo.")
  .option("--dry-run", "Print planned operations without writing")
  .option(
    "--agent <id>",
    "Filter to a single agent (codex|claude-code|cursor|opencode)"
  )
  .option("--type <type>", "Filter to a single type (skills|commands)")
  .option("--policy <policy>", "Conflict policy (prompt|repoWins|localWins)")
  .option(
    "--import-extras",
    "Import local-only entries into the repo without prompting"
  )
  .option("--force", "Do not confirm per conflict (still backs up)")
  .action(async (opts) => runCollect(opts));

program
  .command("pull")
  .description("git pull then install into enabled agents.")
  .option("--rebase", "Use git pull --rebase")
  .option("--dry-run", "Plan install without writing")
  .action(async (opts) => runPull(opts));

program
  .command("push")
  .description("Collect, commit (if needed), then git push.")
  .option("--message <msg>", "Commit message override")
  .option("--dry-run", "Collect and plan git actions without writing")
  .action(async (opts) => runPush(opts));

program
  .command("doctor")
  .description("Check environment, repo, and config for issues.")
  .action(async () => runDoctor());

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const vibetoolsError = VibetoolsError.fromUnknown(error);
  console.error(chalk.red(vibetoolsError.message));
  process.exit(vibetoolsError.exitCode);
});
