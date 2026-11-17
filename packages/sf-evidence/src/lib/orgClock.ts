import type { Connection } from '@salesforce/core';

/**
 * The org's clock, from the `Date` header of one `GET /services/data/` (a read of the API
 * version list). The Connection does not surface response headers, so the connection's own
 * transport is wrapped to read it; the request, its auth and its error handling are the
 * Connection's. The header has one-second resolution. `doctor --target-org` compares it
 * with the local clock; `collect` ends its windows at the earlier of the two.
 */
export async function readOrgClock(conn: Connection): Promise<Date> {
  type Transport = { httpRequest(req: unknown, opts?: unknown): Promise<{ headers?: Record<string, string> }> };
  const base = (conn as unknown as { _transport?: Transport })._transport;
  if (!base) throw new Error('the connection exposes no transport to read response headers from');
  let header: string | undefined;
  const spy: Transport = {
    httpRequest: (req, opts) => {
      const pending = base.httpRequest(req, opts);
      void pending.then(
        (res) => {
          header = res?.headers?.date;
        },
        () => undefined,
      );
      return pending;
    },
  };
  await (conn as unknown as { request(r: unknown, o: unknown): Promise<unknown> }).request(
    { method: 'GET', url: '/services/data/' },
    { transport: spy },
  );
  const parsed = header ? new Date(header) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('the org response carried no usable Date header');
  return parsed;
}
