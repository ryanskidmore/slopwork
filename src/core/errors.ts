import { EXIT_CODES, type ExitCode } from "./exit-codes.js";

/** A domain/application error carrying the process exit code it maps to. */
export class SlopError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT_CODES.GENERIC_ERROR) {
    super(message);
    this.name = "SlopError";
    this.exitCode = exitCode;
  }
}
