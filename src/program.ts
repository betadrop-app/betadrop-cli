import dns from "node:dns";
import { Command } from "commander";
import path from "node:path";

// Node 17+ prefers IPv6 by default; force IPv4 to avoid broken IPv6 routes
// (e.g. Cloudflare-proxied AAAA records on networks with no IPv6 transit).
dns.setDefaultResultOrder("ipv4first");
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { publishCommand } from "./commands/publish.js";
import { CliError } from "./lib/errors.js";
import { ui } from "./lib/ui.js";

// Injected at build time by tsup from package.json — no runtime file read.
declare const __CLI_VERSION__: string;

/** Wrap an async action so thrown CliErrors print cleanly and set the exit code. */
function action<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof CliError) {
        ui.error(err.message);
        process.exitCode = err.exitCode;
      } else if (err instanceof Error) {
        // Inquirer throws on Ctrl-C; treat as a clean cancel.
        if (err.name === "ExitPromptError") {
          ui.dim("\nCancelled.");
          process.exitCode = 130;
          return;
        }
        ui.error(err.message);
        process.exitCode = 1;
      } else {
        ui.error("An unexpected error occurred.");
        process.exitCode = 1;
      }
    }
  };
}

export function buildProgram(): Command {
  const program = new Command();

  let name = "bd";
  if (process.argv[1]) {
    const base = path.basename(process.argv[1], ".js").replace(/\.(cmd|ps1)$/i, "");
    if (base === "betadrop" || base === "bd") {
      name = base;
    }
  }

  program
    .name(name)
    .description("BetaDrop CLI — publish iOS/Android builds from your terminal.")
    .version(__CLI_VERSION__);

  program
    .command("login")
    .description("Authenticate the CLI with BetaDrop")
    .option("--token <token>", "log in non-interactively with an API token")
    .action(action(loginCommand));

  program
    .command("logout")
    .description("Revoke the stored token and remove local credentials")
    .action(action(logoutCommand));

  program
    .command("whoami")
    .description("Show the currently authenticated user")
    .option("--json", "output as JSON")
    .action(action(whoamiCommand));

  program
    .command("publish")
    .argument("<file>", "path to the .ipa or .apk file")
    .argument("[extra...]", "(internal) catches unquoted path fragments")
    .description("Upload a build and print its public install link")
    .option("--name <name>", "override the build name")
    .option("--notes <notes>", "release notes for this build")
    .option(
      "--channel <slug>",
      "point a channel at this build once it is live, so its stable link follows every publish (Pro)",
    )
    .option("--ci", "non-interactive mode for CI (no spinners/prompts)")
    .option("--json", "output as JSON")
    .action(action(publishCommand));

  return program;
}
