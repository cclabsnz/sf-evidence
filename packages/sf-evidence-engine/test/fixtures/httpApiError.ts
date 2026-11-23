/**
 * The error a real Salesforce API failure arrives as.
 *
 * A copy of jsforce's `HttpApiError` (@jsforce/jsforce-node 3.10.24, lib/http-api.js), which
 * is what `Connection.query` / `autoFetchQuery` reject with when the org answers 4xx with a
 * JSON error body. jsforce is not a dependency of this package (pnpm does not hoist it into
 * the engine's node_modules), so the class is mirrored rather than imported: same constructor,
 * same fields. In particular it has `errorCode`, `name` and `data`, and NO `statusCode`, which
 * neither jsforce, @salesforce/core nor sf-core's SoqlClientImpl adds.
 */
export class HttpApiError extends Error {
  public data: unknown;
  public errorCode: string;

  public constructor(message: string, errorCode?: string, data?: unknown) {
    super(message);
    this.name = errorCode || this.name;
    this.errorCode = this.name;
    this.data = data;
  }
}

/** The error jsforce builds from the org's JSON error body `[{ message, errorCode }]`. */
export function sfApiError(errorCode: string, message = `sObject type 'X' is not supported (${errorCode})`): HttpApiError {
  return new HttpApiError(message, errorCode, { message, errorCode });
}
