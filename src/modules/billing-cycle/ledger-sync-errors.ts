/** Thrown when gateway payment cannot be written to maintenance-management ledgers. */
export class LedgerSyncError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerSyncError";
    this.code = code;
  }
}

export function isLedgerSyncError(err: unknown): err is LedgerSyncError {
  return err instanceof LedgerSyncError;
}
