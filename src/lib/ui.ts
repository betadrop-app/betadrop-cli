import chalk from "chalk";
import QRCode from "qrcode";

/**
 * BetaDrop blue — the same #0b64fc the site, the emails and the OG card use, so
 * a terminal screenshot reads as the same product as the install page it links to.
 *
 * chalk resolves truecolor down to the nearest 256/16-colour on terminals that
 * cannot do better, and strips colour entirely when stdout is not a TTY — which
 * is what keeps `--ci` output byte-clean when the GitHub Action captures it with
 * `$(betadrop … | tail -n 1)`.
 */
export const brand = chalk.hex("#0b64fc");

/** Consistent styled output helpers. */
export const ui = {
  success(msg: string) {
    console.log(`${chalk.green("✓")} ${msg}`);
  },
  error(msg: string) {
    console.error(`${chalk.red("✗")} ${msg}`);
  },
  info(msg: string) {
    console.log(msg);
  },
  dim(msg: string) {
    console.log(chalk.dim(msg));
  },
  /**
   * A plan limit that quietly changed what the user asked for.
   *
   * Amber rather than red, and it never uses the ✗ glyph: nothing failed — the build published
   * fine, it just will not live as long as the caller requested. Rendering it as an error would
   * make a successful publish look broken in CI logs.
   */
  warn(msg: string) {
    console.log(`${chalk.yellow("!")} ${msg}`);
  },
  /** A boxed value the user is meant to read/match (e.g. a device user_code). */
  code(value: string) {
    console.log(`\n    ${brand.bold(value)}\n`);
  },
  link(label: string, url: string) {
    console.log(`  ${label}  ${brand(url)}`);
  },
  /**
   * The install link — the payoff of `bd publish` and the line a developer
   * screenshots. Given its own emphasis so it wins the block outright rather
   * than sitting at the same weight as the metadata above it.
   */
  installLink(url: string) {
    console.log(`  ${chalk.bold("Install link")}  ${brand.bold(url)}`);
  },
  /**
   * Print a compact QR code using Unicode half-blocks (▀▄).
   * The utf8 renderer is ~half the height of qrcode-terminal's block-char
   * output. margin must be even (utf8 renderer does margin/2 internally).
   *
   * Awaitable, and it swallows its own failures, because the previous
   * fire-and-forget version had two ways to spoil a successful publish: the
   * caller's next `console.log` printed *between* the caption and the code,
   * and a render error surfaced as an unhandledRejection that exited non-zero
   * after the build had already been published.
   */
  async qr(url: string): Promise<void> {
    let code: string;
    try {
      code = await QRCode.toString(url, { type: "utf8", margin: 2 });
    } catch {
      // The link is the payload; the QR is only a shortcut to it.
      console.log(chalk.dim("  (Could not render the QR code — use the link above.)"));
      return;
    }
    console.log(chalk.dim("  Scan with your phone:"));
    const indented = code
      .split("\n")
      .map((l: string) => `  ${l}`)
      .join("\n");
    console.log(indented);
  },
};

export { chalk };
