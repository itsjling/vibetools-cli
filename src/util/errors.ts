const DEFAULT_EXIT_CODE = 1;

export class VibetoolsError extends Error {
  exitCode: number;
  cause?: unknown;

  constructor(message: string, opts?: { exitCode?: number; cause?: unknown }) {
    super(message);
    this.name = "VibetoolsError";
    this.exitCode = opts?.exitCode ?? DEFAULT_EXIT_CODE;
    this.cause = opts?.cause;
  }

  static fromUnknown(error: unknown): VibetoolsError {
    if (error instanceof VibetoolsError) {
      return error;
    }
    if (error instanceof Error) {
      return new VibetoolsError(error.message, { cause: error });
    }
    return new VibetoolsError(String(error));
  }
}
