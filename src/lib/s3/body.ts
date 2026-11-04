export class BodyTooLarge extends Error {}

/** Enforce the limit while consuming the stream, including chunked requests. */
export async function readBoundedBody(request: Request, limit: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new BodyTooLarge();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Client address for rate limiting. srvx derives it from the transport, so
 * callers cannot select it via headers. Behind a reverse proxy every request
 * shares the proxy's address; set TRUST_PROXY=true only when the node is
 * reachable exclusively through a proxy that appends X-Forwarded-For (the
 * bundled Caddy overlay does). The right-most entry is the one added by that
 * proxy, so client-supplied entries to its left are ignored.
 */
export function transportAddress(request: Request): string {
  const transport = request as Request & {
    ip?: string;
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } };
  };
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = request.headers.get("x-forwarded-for");
    const last = forwarded?.split(",").pop()?.trim();
    if (last) return last;
  }
  return transport.runtime?.node?.req?.socket?.remoteAddress || transport.ip || "unknown";
}
