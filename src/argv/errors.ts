// Usage and client-side failures with the exit code they map to. Shared by the
// Bun CLI and the daemon's /argv route, so no parameter properties (Node's
// type stripping can't erase them).

export class CliError extends Error {
  exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
}
