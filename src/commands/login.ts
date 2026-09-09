import { password, select } from "@inquirer/prompts";
import { loginWithToken, loginWithBrowser } from "../lib/auth.js";
import { isEnvToken, readConfig, clearConfig, writeConfig } from "../lib/config.js";
import { logoutCommand } from "./logout.js";
import { ui, chalk } from "../lib/ui.js";
import { apiFetch } from "../lib/api.js";
import { UnauthorizedError } from "../lib/errors.js";
import type { WhoamiResponse } from "../types.js";

interface LoginOptions {
  token?: string;
}

/**
 * `bd login`
 *
 * - `--token <t>`: non-interactive token login.
 * - If already logged in: prompts to continue, switch accounts, or log out first.
 * - Interactive menu: Continue with Google / Continue with Email (device flow),
 *   or paste an API token.
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  if (isEnvToken()) {
    ui.info(
      "BETADROP_TOKEN is set in your environment; the CLI will use it automatically.",
    );
    ui.dim("Unset it to log in with a stored token instead.");
    return;
  }

  // Check if a session is already stored.
  const existing = await readConfig();
  if (existing?.token && existing.user?.email) {
    // Non-interactive: --token flag was passed — replace the session silently.
    if (options.token) {
      await applyToken(options.token);
      return;
    }

    let isValid = false;
    try {
      const res = await apiFetch<WhoamiResponse>("/api/cli/whoami", {
        auth: true,
        token: existing.token,
      });
      if (res.data?.user) {
        isValid = true;
        // Update stored config in case user details changed
        const { id, email, role } = res.data.user;
        await writeConfig({
          apiUrl: existing.apiUrl,
          token: existing.token,
          user: { id, email, role },
        });
        existing.user = res.data.user;
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await clearConfig();
      } else {
        throw err;
      }
    }

    if (isValid) {
      ui.info(
        `You are already logged in as ${chalk.bold(existing.user.email)}.`,
      );

      const choice = await select({
        message: "What would you like to do?",
        choices: [
          {
            name: `Continue as ${existing.user.email}`,
            value: "keep",
            description: "Use the existing session — no changes.",
          },
          {
            name: "Sign in with a different account",
            value: "switch",
            description: "Start the login flow and replace the current session.",
          },
          {
            name: "Log out and sign in again",
            value: "relogin",
            description: "Revoke the current token, then start fresh.",
          },
        ],
      });

      if (choice === "keep") {
        ui.dim(`Still logged in as ${existing.user.email}.`);
        return;
      }

      if (choice === "relogin") {
        await logoutCommand();
      }
      // Both "switch" and "relogin" fall through to the auth method picker below.
    } else {
      ui.info(chalk.yellow("Your session has expired. Please sign in again."));
    }
  }

  // Non-interactive: token provided directly (no existing session, or just cleared).
  if (options.token) {
    await applyToken(options.token);
    return;
  }

  await runAuthFlow();
}

/** Interactive authentication method picker. */
async function runAuthFlow(): Promise<void> {
  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      {
        name: "Continue with Google",
        value: "google",
        description: "Opens your browser to approve this device",
      },
      {
        name: "Continue with Email",
        value: "email",
        description: "Opens your browser to approve this device",
      },
      {
        name: "API Token",
        value: "token",
        description: "Paste a token from Settings → API Tokens",
      },
    ],
  });

  if (method === "google" || method === "email") {
    const user = await loginWithBrowser(method);
    ui.success(`Logged in as ${chalk.bold(user.email)}`);
    return;
  }

  const token = await password({
    message: "Paste your BetaDrop API token:",
    mask: true,
    validate: (value) =>
      value.trim().startsWith("bd_live_") ||
      "That doesn't look like a BetaDrop token (expected to start with bd_live_).",
  });

  await applyToken(token.trim());
}

async function applyToken(token: string): Promise<void> {
  const user = await loginWithToken(token);
  ui.success(`Logged in as ${chalk.bold(user.email)}`);
}
