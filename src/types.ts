/** Shape of the locally-stored credentials file. */
export interface Config {
  apiUrl: string;
  token: string;
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

/** Standard Laravel API envelope. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface WhoamiResponse {
  user: { id: string; email: string; role: string };
  /** null when authenticated via browser cookie session rather than a CLI token */
  token: { id: string; name: string; last_used_at: string | null; expires_at: string | null } | null;
}

/**
 * Present only when the account's plan shortened the retention that was asked for.
 *
 * The API has always clamped silently — the request is rewritten, a 200 comes back — which the
 * web form could at least show by changing its own field, while a CLI or CI caller got no signal
 * at all. A pipeline configured for 30-day links has been quietly producing 7-day ones.
 *
 * `message` is built server-side (`RetentionClamp::message`) so the web form, the CLI and the MCP
 * server cannot describe the same limit three different ways. Print it verbatim.
 */
export interface RetentionClamp {
  requestedDays: number;
  appliedDays: number;
  maxDays: number;
  permanentDenied: boolean;
  message: string;
}

export interface PublishResponse {
  id: string;
  platform: string;
  fileSize: number;
  shortId: string;
  url: string;
  meta: {
    name: string;
    version: string;
    package: string;
    icon: string | null;
    dominantColor: string | null;
  };
  /** Null/absent on an ordinary upload — presence means there is something to tell the user. */
  retentionClamp?: RetentionClamp | null;
  /** Same contract: set only when this account already has a live build with these exact bytes. */
  duplicateOf?: DuplicateOf | null;
  /** Set when `channel` was sent and that channel now serves this build. `url` is its stable link. */
  channel?: PublishedChannel | null;
  /**
   * Set when `channel` was sent, the build was stored, and the channel could NOT be pointed at it.
   * The upload succeeded; the channel did not move. Never silent — see `publish.ts`.
   */
  channelWarning?: string | null;
}

export interface PublishedChannel {
  id: string;
  slug: string;
  label: string | null;
  url: string;
}

/**
 * A build the account already had, byte-identical to the one just published.
 *
 * Nothing failed — the new build is live and `url` above is its link. This says a second link now
 * exists for the same file, which is the state a CI pipeline is most likely to reach by accident:
 * a re-run of an unchanged commit publishes the identical artifact again and gets a new URL, and
 * nothing until now said so.
 */
export interface DuplicateOf {
  /** Build id of the EARLIER copy, never the one just published. */
  id: string;
  shortId: string;
  /** Install URL of the earlier copy, composed by the API so every client agrees on it. */
  url: string;
  name: string;
  version: string | null;
  buildNumber: string | null;
  /** "MyApp 1.2 (45)", already degraded for missing version/build number. */
  label: string;
  /** The full sentence, rendered server-side so the CLI, the web app and the MCP server say the
   *  same thing about the same situation. */
  message: string;
  createdAt: string | null;
  downloadCount: number;
}
