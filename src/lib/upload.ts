import { createReadStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { CliError, UnauthorizedError } from "./errors.js";
import type { ApiResponse, PublishResponse } from "../types.js";

export interface UploadFields {
  name?: string;
  notes?: string;
  /** A channel slug the API points at the new build before answering — see `--channel`. */
  channel?: string;
}

interface UploadArgs {
  baseUrl: string;
  token: string;
  filePath: string;
  fields: UploadFields;
  onProgress?: (sent: number, total: number) => void;
  /**
   * How long the connection may be completely idle (no bytes sent or received)
   * before the upload is aborted (default 60 000 ms = 60s).
   * This resets on every chunk, so a slow-but-active 500 MB upload on a 5 Mbps
   * line (~800s total) will never be killed as long as data keeps flowing.
   */
  stallTimeoutMs?: number;
  /**
   * How long to wait for the TCP connection to be established before failing
   * (default 30 000 ms = 30s). Separate from the stall timeout so a hung DNS
   * or unreachable host doesn't wait 60s before reporting the error.
   */
  connectTimeoutMs?: number;
  /** How many times to retry on a transient 5xx before giving up (default 2). */
  retries?: number;
}

const CRLF = "\r\n";

/**
 * Stream a multipart/form-data upload to /api/cli/publish, reporting byte
 * progress as the request body is consumed. Uses the raw http/https client so
 * we get reliable upload-progress events (native fetch does not expose them).
 */
export async function uploadBuild(args: UploadArgs): Promise<PublishResponse> {
  const {
    baseUrl,
    token,
    filePath,
    fields,
    onProgress,
    stallTimeoutMs = 60_000,
    connectTimeoutMs = 30_000,
    retries = 2,
  } = args;

  const stat = await fs.stat(filePath);
  if (stat.size === 0) {
    throw new CliError("The file is empty.");
  }
  const fileName = path.basename(filePath);
  // Strip characters that would break the Content-Disposition header value:
  // quotes, backslashes, and bare CR/LF are all illegal inside the quoted-string.
  const safeFileName = fileName.replace(/["\\\r\n]/g, "_");

  // Build the multipart preamble (text fields + file header) and epilogue.
  // Boundary uses cryptographically random bytes so it can never collide with file content.
  const boundary = `----betadropcli${randomBytes(16).toString("hex")}`;
  const textParts: string[] = [];
  const addField = (key: string, value: string) => {
    textParts.push(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
        `${value}${CRLF}`,
    );
  };
  if (fields.name) addField("name", fields.name);
  if (fields.notes) addField("notes", fields.notes);
  if (fields.channel) addField("channel", fields.channel);

  const fileHeader =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`;

  const preamble = Buffer.from(textParts.join("") + fileHeader, "utf8");
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");
  const totalBytes = preamble.length + stat.size + epilogue.length;

  const url = new URL(`${baseUrl}/api/cli/publish`);
  const client = url.protocol === "https:" ? https : http;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpload();
    } catch (err) {
      // Retry transient 5xx errors (but not auth, usage, or network errors).
      // attempt-1 is the number of retries so far; stop when we've used them all.
      if (
        err instanceof CliError &&
        !(err instanceof UnauthorizedError) &&
        /HTTP 5\d\d/.test(err.message) &&
        attempt - 1 < retries
      ) {
        // Exponential back-off: 2s, 4s.
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }

  function attemptUpload(): Promise<PublishResponse> {
    return new Promise<PublishResponse>((resolve, reject) => {
      const req = client.request(
        url,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": totalBytes,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 401) {
              reject(new UnauthorizedError());
              return;
            }
            let json: ApiResponse<PublishResponse>;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new CliError(`Unexpected response from BetaDrop (HTTP ${status}).`));
              return;
            }
            if (status < 200 || status >= 300 || json.success === false) {
              reject(
                new CliError(
                  json.error || json.message || `Upload failed (HTTP ${status}).`,
                ),
              );
              return;
            }
            resolve(json.data as PublishResponse);
          });
        },
      );

      let sent = 0;
      const bump = (n: number) => {
        sent += n;
        onProgress?.(Math.min(sent, totalBytes), totalBytes);
      };

      const fileStream = createReadStream(filePath);

      // --- Stall detector ---------------------------------------------------
      // req.setTimeout() in Node is a wall-clock timeout from the moment the
      // socket is created — it fires even while bytes are actively flowing, which
      // breaks large uploads on slow connections. Instead we track the last time
      // any byte moved and only abort when nothing has happened for stallTimeoutMs.
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          fileStream.destroy();
          req.destroy(
            new Error(
              `Upload stalled — no data for ${stallTimeoutMs / 1000}s. Check your connection.`,
            ),
          );
        }, stallTimeoutMs);
      };

      // --- Connect timeout --------------------------------------------------
      // Fires once if the TCP socket is never established (hung DNS, unreachable host).
      // Cleared as soon as the socket connects and data starts flowing.
      const connectTimer = setTimeout(() => {
        fileStream.destroy();
        req.destroy(
          new Error(
            `Could not connect to BetaDrop after ${connectTimeoutMs / 1000}s. Check your connection or BETADROP_API_URL.`,
          ),
        );
      }, connectTimeoutMs);

      req.on("socket", (socket) => {
        socket.on("connect", () => {
          clearTimeout(connectTimer);
          resetStall(); // start stall detection once connected
        });
      });

      req.on("error", (err) => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
        reject(
          err.message.includes("stalled") || err.message.includes("connect")
            ? new CliError(err.message)
            : new CliError(
                `Could not reach BetaDrop at ${baseUrl}. Check your connection or BETADROP_API_URL.`,
              ),
        );
      });

      // Write preamble, then stream the file, then the epilogue.
      req.write(preamble);
      bump(preamble.length);

      fileStream.on("data", (chunk) => {
        resetStall(); // data is flowing — reset the stall clock
        bump(chunk.length);
      });
      fileStream.on("error", (err) => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
        req.destroy();
        reject(new CliError(`Failed to read ${fileName}: ${err.message}`));
      });
      fileStream.on("end", () => {
        resetStall(); // keep stall detection alive while server processes the upload
        req.write(epilogue);
        bump(epilogue.length);
        req.end();
      });
      fileStream.pipe(req, { end: false });

      // Clear timers once the response arrives (server is responding, not stalled).
      req.on("response", () => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
