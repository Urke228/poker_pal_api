/**
 * Every failure leaves the API as `{ error: { code, message } }`, so both
 * clients can branch on a stable `code` while showing `message` to the user.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const unauthenticated = (message = "Sign in to continue.") =>
  new ApiError(401, "UNAUTHENTICATED", message);

export const forbidden = (message = "You are not allowed to do that.") =>
  new ApiError(403, "FORBIDDEN", message);

export const notFound = (what: string) =>
  new ApiError(404, "NOT_FOUND", `${what} was not found.`);

export const badRequest = (code: string, message: string) =>
  new ApiError(400, code, message);

export const conflict = (code: string, message: string) =>
  new ApiError(409, code, message);
