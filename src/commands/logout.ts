import { apiFetch } from "../lib/api.js";
import { clearConfig, isEnvToken } from "../lib/config.js";
import { ui } from "../lib/ui.js";

/** `bd logout` — revoke the stored token server-side, then delete local config. */
export async function logoutCommand(): Promise<void> {
  if (isEnvToken()) {
    ui.info(
      "Using BETADROP_TOKEN from the environment — nothing stored locally to remove.",
    );
    ui.dim("Revoke this token in the dashboard (Settings → API Tokens) to disable it.");
    return;
  }

  // Best-effort server-side revocation. Even if it fails (already revoked,
  // offline), we still clear the local credentials.
  try {
    await apiFetch("/api/cli/logout", { method: "POST" });
  } catch {
    // ignore — proceed to clear local config regardless
  }

  await clearConfig();
  ui.success("Logged out");
}
