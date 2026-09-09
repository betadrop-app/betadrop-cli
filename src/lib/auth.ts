import os from "node:os";
import open from "open";
import ora from "ora";
import { apiFetch, apiBaseUrl } from "./api.js";
import { readConfig, writeConfig, resolveApiUrl } from "./config.js";
import { CliError } from "./errors.js";
import { ui } from "./ui.js";
import type { WhoamiResponse } from "../types.js";

// Injected by tsup at build time from package.json — never a runtime file read.
declare const __CLI_VERSION__: string;

/** Identify this CLI build + host in the device request. */
function clientName(): string {
  return `betadrop-cli/${__CLI_VERSION__} (${os.platform()}/${os.arch()})`;
}

/**
 * Validate a plaintext token against the API and, if valid, persist it.
 * Returns the resolved user. Throws UnauthorizedError if the token is bad.
 */
export async function loginWithToken(token: string): Promise<WhoamiResponse["user"]> {
  // whoami validates the token (401 if invalid) and returns the user.
  const res = await apiFetch<WhoamiResponse>("/api/cli/whoami", {
    auth: true,
    token,
  });

  if (!res.data) {
    throw new CliError("Unexpected response from BetaDrop — could not verify token.");
  }
  const user = res.data.user;
  await persistToken(token, user);
  return user;
}

/** Store the token + user in the local config (env-token mode never writes). */
async function persistToken(
  token: string,
  user: WhoamiResponse["user"],
): Promise<void> {
  const existing = await readConfig();
  await writeConfig({
    apiUrl: resolveApiUrl(existing?.apiUrl ?? (await apiBaseUrl())),
    token,
    user: { id: user.id, email: user.email, role: user.role },
  });
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenSuccess {
  access_token: string;
  token_type: string;
  user: WhoamiResponse["user"];
}

/**
 * Run the browser device-authorization flow (RFC 8628):
 *   1. request a device code,
 *   2. show the user_code + open the browser,
 *   3. poll until approved/denied/expired.
 * On success the token is stored and the user returned.
 */
export async function loginWithBrowser(
  providerHint?: "google" | "email",
): Promise<WhoamiResponse["user"]> {
  const base = await apiBaseUrl();

  // 1. Request a device code (flat RFC-8628 response, not the app envelope).
  let codeRes: Response | null = null;
  try {
    codeRes = await fetch(`${base}/api/cli/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName(),
        scope: "publish read",
        provider_hint: providerHint,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CliError("Request timed out. Check your connection or try again.");
    }
    throw new CliError(
      `Could not reach BetaDrop at ${base}. Check your connection, or unset BETADROP_API_URL if it points at a server that isn't running.\nIf you are behind a corporate firewall or proxy, try running with: NODE_TLS_REJECT_UNAUTHORIZED=0 bd <command>`,
    );
  }

  if (!codeRes.ok) {
    throw new CliError(
      `BetaDrop at ${base} returned an error (HTTP ${codeRes.status}). Try again, or use an API token.`,
    );
  }
  const device = (await codeRes.json()) as DeviceCodeResponse;

  // 2. Show the code and QR, then open the browser, then start the spinner.
  ui.info("To sign in, open this page in your browser:");
  ui.link("", device.verification_uri);
  ui.info("\nand enter the code:");
  ui.code(device.user_code);
  await ui.qr(device.verification_uri_complete);

  try {
    await open(device.verification_uri_complete);
    ui.dim("Browser opened — approve the request to continue. (Ctrl-C to cancel)");
  } catch {
    ui.dim("Couldn't open the browser automatically — open the URL above manually. (Ctrl-C to cancel)");
  }

  // 3. Poll for the token.
  // ora only accepts chalk's *named* colours, so the brand hex cannot go here —
  // "blue" is the nearest named colour to #0b64fc and keeps the login flow in the
  // same family as the code and QR printed above it.
  const spinner = ora({ text: "Waiting for approval…", color: "blue" }).start();
  let interval = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;

  try {
    while (Date.now() < deadline) {
      await sleep(interval * 1000);

      const res = await fetch(`${base}/api/cli/device/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ device_code: device.device_code }),
        signal: AbortSignal.timeout(30_000),
      });

      const body = (await res.json().catch(() => ({}))) as
        | DeviceTokenSuccess
        | { error: string; interval?: number };

      if (res.ok && "access_token" in body) {
        spinner.succeed("Approved");
        await persistToken(body.access_token, body.user);
        return body.user;
      }

      const error = "error" in body ? body.error : "expired_token";
      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        // Use the server's updated interval if provided; otherwise fall back to +5.
        // The server already incremented its own counter — we must not add another +5
        // on top, or the effective wait doubles the intended back-off.
        interval = ("interval" in body && typeof body.interval === "number")
          ? body.interval
          : interval + 5;
        continue;
      }
      if (error === "access_denied") {
        spinner.fail("Login was denied in the browser.");
        throw new CliError("Login denied.");
      }
      // expired_token / anything else
      spinner.fail("The code expired.");
      throw new CliError("The code expired. Run `bd login` again.");
    }

    spinner.fail("The code expired.");
    throw new CliError("The code expired. Run `bd login` again.");
  } finally {
    if (spinner.isSpinning) spinner.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
