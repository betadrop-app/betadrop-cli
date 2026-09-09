import { apiFetch } from "../lib/api.js";
import { ui, chalk } from "../lib/ui.js";
import { CliError } from "../lib/errors.js";
import type { WhoamiResponse } from "../types.js";

interface WhoamiOptions {
  json?: boolean;
}

/** `bd whoami` — identify the current user + token. */
export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const res = await apiFetch<WhoamiResponse>("/api/cli/whoami");
  if (!res.data) throw new CliError("Unexpected response from BetaDrop.");
  const { user, token } = res.data;

  if (options.json) {
    console.log(JSON.stringify({ user, token }, null, 2));
    return;
  }

  if (token) {
    const expiry = token.expires_at
      ? ` · expires ${new Date(token.expires_at).toLocaleDateString()}`
      : " · no expiry";
    const lastUsed = token.last_used_at
      ? ` · last used ${new Date(token.last_used_at).toLocaleDateString()}`
      : "";
    ui.info(`${chalk.bold(user.email)} ${chalk.dim(`(${user.role})`)}`);
    ui.dim(`  Token: ${token.name}${expiry}${lastUsed}`);
  } else {
    ui.info(`${chalk.bold(user.email)} ${chalk.dim(`(${user.role})`)}`);
  }
}
