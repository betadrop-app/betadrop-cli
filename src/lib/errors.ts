/**
 * Typed CLI errors with friendly messages and explicit exit codes.
 *
 * Exit codes: 0 success, 1 runtime/auth error, 2 invalid usage.
 */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Raised on a 401 — the token is missing, expired, or revoked. */
export class UnauthorizedError extends CliError {
  constructor(message = "Your token is invalid, expired, or was revoked. Run `bd login` to sign in again.") {
    super(message, 1);
    this.name = "UnauthorizedError";
  }
}

/** Raised on a usage/validation problem (bad args, missing file). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
