export class T4Error extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "T4Error";
  }
}

export function isT4Error(error: unknown): error is T4Error {
  return error instanceof T4Error;
}
