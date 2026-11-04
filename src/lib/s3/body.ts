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

/** srvx derives ip from the transport; callers cannot select it via headers. */
export function transportAddress(request: Request): string {
  const transport = request as Request & {
    ip?: string;
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } };
  };
  return transport.runtime?.node?.req?.socket?.remoteAddress || transport.ip || "unknown";
}
