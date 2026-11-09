/**
 * An error the person running the CLI can act on: it prints as its message alone and exits
 * 2, rather than as a stack. It's recognized by a brand, not by its class, so the CLI tells
 * Docsworth pro's errors apart without importing pro: pro is another package, and its errors
 * may extend another copy of this class.
 */
export class UserError extends Error {
  readonly userError = true as const;
}

/** Whether `err` is a UserError, from this copy of core or any other. */
export function isUserError(err: unknown): err is Error {
  return err instanceof Error && (err as { userError?: unknown }).userError === true;
}
