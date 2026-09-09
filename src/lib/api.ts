import { getToken, readConfig, resolveApiUrl } from "./config.js";
import { CliError, UnauthorizedError } from "./errors.js";
import type { ApiResponse } from "../types.js";

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Attach the Bearer token (default true). Set false for unauthenticated calls. */
  auth?: boolean;
  /** Explicit token override (used during login before config is written). */
  token?: string;
}

/** Resolve the API base URL from env/config. */
export async function apiBaseUrl(): Promise<string> {
  const config = await readConfig();
  return resolveApiUrl(config?.apiUrl);
}

/**
 * Call the BetaDrop API and return the parsed JSON envelope.
 * Throws UnauthorizedError on 401 and CliError on other failures.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", body, auth = true, token } = options;
  const base = await apiBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = { Accept: "application/json" };

  if (auth) {
    const activeToken = token ?? (await getToken());
    if (!activeToken) {
      throw new UnauthorizedError("You are not logged in. Run `bd login` first.");
    }
    headers.Authorization = `Bearer ${activeToken}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CliError("Request timed out. Check your connection or try again.");
    }
    throw new CliError(
      `Could not reach BetaDrop at ${base}. Check your connection or BETADROP_API_URL.\nIf you are behind a corporate firewall or proxy, try running with: NODE_TLS_REJECT_UNAUTHORIZED=0 bd <command>`,
    );
  }

  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  let json: ApiResponse<T>;
  try {
    json = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new CliError(`Unexpected response from BetaDrop (HTTP ${response.status}).`);
  }

  if (!response.ok || json.success === false) {
    throw new CliError(json.error || json.message || `Request failed (HTTP ${response.status}).`);
  }

  return json;
}
