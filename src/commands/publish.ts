import { promises as fs } from "node:fs";
import path from "node:path";
import cliProgress from "cli-progress";
import { apiBaseUrl } from "../lib/api.js";
import { getToken, resolveAppUrl } from "../lib/config.js";
import { uploadBuild } from "../lib/upload.js";
import { CliError, UnauthorizedError, UsageError } from "../lib/errors.js";
import { ui, chalk } from "../lib/ui.js";
import type { PublishResponse } from "../types.js";

interface PublishOptions {
  name?: string;
  notes?: string;
  channel?: string;
  ci?: boolean;
  json?: boolean;
}

/**
 * The line `--ci` prints when a channel was used, one line ABOVE the install URL.
 *
 * The install URL stays the last line of stdout — that is the contract the GitHub Action reads
 * with `tail -n 1`, and it cannot change without breaking every pinned workflow. The channel's
 * stable link therefore travels as a `key=value` line the Action greps for, in the same shape
 * `$GITHUB_OUTPUT` uses, so the Action can forward it without parsing prose.
 */
export const CI_CHANNEL_LINE = "channel-url=";

const ALLOWED_EXT = [".ipa", ".apk"];

/**
 * IPA and APK are both ZIP archives and share the same magic bytes: PK\x03\x04.
 * A renamed .txt file will not have these bytes — catch it here before wasting
 * bandwidth uploading 500 MB only for the server to reject it.
 */
async function validateMagicBytes(filePath: string, ext: string): Promise<void> {
  const platform = ext === ".ipa" ? "iOS" : "Android";
  const expectedMsg = ext === ".ipa"
    ? "Please upload a valid IPA file."
    : "Please upload a valid APK file.";

  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    // ZIP magic: 50 4B 03 04
    if (bytesRead < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
      throw new UsageError(
        `This file does not appear to be a valid ${platform} build. ${expectedMsg}`,
      );
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new UsageError(`Could not read file to validate it: ${filePath}`);
  } finally {
    await fh?.close();
  }
}

/** `bd publish <file>` — upload a build and print its public install link. */
export async function publishCommand(
  file: string,
  extra: string[],
  options: PublishOptions,
): Promise<void> {
  const filePath = await resolveFilePath(file, extra);
  const ext = path.extname(filePath).toLowerCase();

  if (!ALLOWED_EXT.includes(ext)) {
    throw new UsageError(
      `Unsupported file type "${ext}". Expected .ipa or .apk.`,
    );
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new UsageError(`File not found: ${file}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Not a file: ${file}`);
  }

  // Validate actual file content via magic bytes — catches renamed files
  // (e.g. notes.txt renamed to app.ipa) before any bytes are uploaded.
  await validateMagicBytes(filePath, ext);

  const token = await getToken();
  if (!token) {
    throw new UnauthorizedError("You are not logged in. Run `bd login` first.");
  }

  const baseUrl = await apiBaseUrl();
  const quiet = options.ci || options.json;

  // Progress bar (suppressed in CI/JSON modes).
  let bar: cliProgress.SingleBar | null = null;
  if (!quiet) {
    ui.info(`Uploading ${chalk.bold(path.basename(filePath))}…`);
    bar = new cliProgress.SingleBar(
      {
        format: `  {bar} {percentage}% · {value}/{total} MB`,
        hideCursor: true,
        barCompleteChar: "█",
        barIncompleteChar: "░",
      },
      cliProgress.Presets.shades_classic,
    );
    const totalMb = +(stat.size / 1024 / 1024).toFixed(1);
    bar.start(totalMb, 0);
  }

  let result: PublishResponse;
  try {
    result = await uploadBuild({
      baseUrl,
      token,
      filePath,
      fields: {
        name: options.name,
        notes: options.notes,
        channel: options.channel?.trim() || undefined,
      },
      onProgress: (sent, total) => {
        if (bar) bar.update(+(sent / 1024 / 1024).toFixed(1), { total });
      },
    });
  } catch (err) {
    if (bar) bar.stop();
    // Re-throw typed errors so program.ts formats them and sets exit codes.
    if (err instanceof CliError) throw err;
    throw new CliError(err instanceof Error ? err.message : "Upload failed");
  }

  if (bar) bar.stop();

  const installUrl = `${resolveAppUrl()}/install/?i=${result.shortId}`;

  // Set only when the plan shortened the retention that was asked for. The API clamps either way;
  // what this adds is that the caller finds out. A CI pipeline configured for 30-day links had no
  // way to learn it was producing 7-day ones — the request was rewritten and a 200 came back.
  const clamp = result.retentionClamp;

  // Set when the API recognised these exact bytes as a build this account already has live. The CI
  // case is the one worth catching: a re-run of an unchanged commit republishes the identical
  // artifact and, until now, silently produced a second link to it.
  const dupe = result.duplicateOf;

  // Set when `--channel` was given and the API pointed that channel at this build. Its `url` is
  // the link that survives the next publish, which for a pipeline is the one worth printing.
  const channel = result.channel ?? null;

  // Set when `--channel` was given, the build was stored, and the channel did NOT move. This is
  // the one advisory here that must not be treated as advice: a pipeline that asked for a channel
  // and got a build nobody's link points at has failed at the thing it was for. So it is printed
  // like the others AND the command exits non-zero — after the install URL, which is still real.
  const channelWarning = result.channelWarning ?? null;
  const failIfChannelDidNotMove = () => {
    if (channelWarning) throw new CliError(channelWarning);
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          id: result.id,
          short_id: result.shortId,
          install_url: installUrl,
          // Emitted only when it fired, so a script can test for presence rather than
          // comparing day counts itself. Mirrors the API's own contract.
          ...(clamp ? { retention_clamp: clamp } : {}),
          // Present only when `--channel` was given and the channel now serves this build.
          ...(channel
            ? { channel: { id: channel.id, slug: channel.slug, label: channel.label, url: channel.url } }
            : {}),
          ...(channelWarning ? { channel_warning: channelWarning } : {}),
          // Same shape rule as the clamp: present only when it fired, so a script tests for the
          // key rather than comparing digests itself.
          ...(dupe
            ? {
                duplicate_of: {
                  id: dupe.id,
                  short_id: dupe.shortId,
                  install_url: dupe.url,
                  label: dupe.label,
                  created_at: dupe.createdAt,
                  download_count: dupe.downloadCount,
                  message: dupe.message,
                },
              }
            : {}),
        },
        null,
        2,
      ),
    );
    failIfChannelDidNotMove();
    return;
  }

  if (options.ci) {
    // The install URL must remain the LAST line of stdout — the GitHub Action reads it with
    // `tail -n 1`. So the clamp notice goes to stderr, where it is visible in the run log
    // without displacing the contract the Action depends on.
    if (clamp) console.error(`warning: ${clamp.message}`);
    // stderr, for the same reason the clamp goes there: the install URL must remain the LAST line
    // of stdout because the GitHub Action reads it with `tail -n 1`. A notice printed to stdout
    // here would silently become the "install URL" every Action run publishes.
    if (dupe) console.error(`warning: ${dupe.message} (${dupe.url})`);
    // The channel warning is not echoed here: `failIfChannelDidNotMove` below throws it, and the
    // error path prints it to stderr once, after the install URL has gone to stdout.
    // Above the install URL, never below it — see CI_CHANNEL_LINE.
    if (channel) console.log(`${CI_CHANNEL_LINE}${channel.url}`);
    console.log(installUrl);
    failIfChannelDidNotMove();
    return;
  }

  // Human-friendly summary block. This prints after the upload has completed and
  // the build is live, so the headline states a finished fact — the old
  // "Processing build…" under a green tick told the one person watching that the
  // job might not be done, on the screen they are most likely to screenshot.
  // The install link follows it as the climax: it is the whole product, and the
  // QR underneath is only a shortcut for getting it onto a phone.
  console.log("");
  ui.success(`Published to BetaDrop`);
  console.log(
    `\n  ${chalk.bold(result.meta.name)}  ${chalk.dim(`v${result.meta.version} (${result.platform})`)}`,
  );
  ui.installLink(installUrl);
  console.log("");
  // The channel's link, directly under the build's own: this is the one to hand out, because
  // the next `--channel` publish updates it in place. Named by slug so it reads as a fact about
  // the channel rather than a second copy of the install link.
  if (channel) {
    ui.dim(`  Channel ${channel.slug} now serves this build:`);
    console.log(`  ${chalk.bold(channel.url)}`);
    console.log("");
  }
  // Below the link, not above it: the publish succeeded and the link is the headline. This is a
  // footnote about how long that link lives — and, for the only plan limit this product has that
  // fires on a normal upload, the one moment a free account is told the paid tier exists.
  if (clamp) {
    ui.warn(clamp.message);
    console.log("");
  }
  // After the clamp: the clamp is about the link just printed, this is about a different link. It
  // names that other URL explicitly rather than saying "check your dashboard", because the whole
  // problem being solved is that the uploader cannot tell the two apart.
  if (dupe) {
    ui.warn(dupe.message);
    console.log(`  ${chalk.dim(dupe.url)}`);
    console.log("");
  }
  if (channelWarning) {
    ui.warn(channelWarning);
    console.log("");
  }
  // Awaited: unawaited, this printed its caption synchronously and the code
  // itself a tick later, so the blank line below landed between the two.
  // The QR carries the channel link when there is one: a phone that scans it once keeps a link
  // that follows every later publish, which is what a channel is for.
  await ui.qr(channel ? channel.url : installUrl);
  console.log("");
  failIfChannelDidNotMove();
}

/**
 * Resolve the file path, handling the common case where a path with spaces was
 * passed unquoted (so the shell split it into multiple arguments).
 *
 *   bd publish C:\...\IKW Designs.ipa     → file="C:\...\IKW", extra=["Designs.ipa"]
 *
 * If rejoining the fragments with spaces points at a real file, use it (and warn
 * to quote next time). Otherwise, fail with a clear quoting hint instead of a
 * confusing "Unsupported file type" error.
 */
async function resolveFilePath(file: string, extra: string[]): Promise<string> {
  if (!extra || extra.length === 0) {
    return path.resolve(file);
  }

  const rejoined = path.resolve([file, ...extra].join(" "));
  try {
    const stat = await fs.stat(rejoined);
    if (stat.isFile()) {
      ui.dim(
        `Note: the path contains spaces — wrap it in quotes next time, e.g. "${[file, ...extra].join(" ")}"`,
      );
      return rejoined;
    }
  } catch {
    // fall through to the error below
  }

  throw new UsageError(
    `Too many arguments. If your file path contains spaces, wrap it in quotes:\n` +
      `  bd publish "${[file, ...extra].join(" ")}"`,
  );
}
