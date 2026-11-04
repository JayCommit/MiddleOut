import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function canonicalUri(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return path
    .split("/")
    .map((seg, i) => (i === 0 ? "" : encodeRfc3986(safeDecode(seg))))
    .join("/");
}

export function canonicalQueryString(url: URL): string {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((value, key) => {
    if (key.toLowerCase() === "x-amz-signature") return;
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function headerValue(name: string, raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return name === "host" ? collapsed.toLowerCase() : collapsed;
}

export function canonicalRequest(opts: {
  method: string;
  uri: string;
  query: string;
  headers: Headers;
  signedHeaders: string[];
  payloadHash: string;
}): string {
  const signed = [...new Set(opts.signedHeaders.map((h) => h.trim().toLowerCase()))].sort();
  const block = signed
    .map((name) => `${name}:${headerValue(name, opts.headers.get(name) ?? "")}\n`)
    .join("");
  return [
    opts.method.toUpperCase(),
    opts.uri,
    opts.query,
    block,
    signed.join(";"),
    opts.payloadHash,
  ].join("\n");
}

export function stringToSign(amzDate: string, scope: string, canonical: string): string {
  return ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

export function signatureHex(key: Buffer, toSign: string): string {
  return createHmac("sha256", key).update(toSign).digest("hex");
}

export type ParsedAuth = {
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
  amzDate: string;
  expiresSec: number | null;
  presigned: boolean;
};

function parseAmz(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function parseAuthorization(request: Request): ParsedAuth | { error: string } | null {
  const header = request.headers.get("authorization") ?? "";
  const url = new URL(request.url);
  if (header.startsWith("AWS4-HMAC-SHA256 ")) {
    const cred = /Credential=([^,\s]+)/.exec(header);
    const signed = /SignedHeaders=([^,\s]+)/.exec(header);
    const sig = /Signature=([0-9a-f]{64})/i.exec(header);
    if (!cred?.[1] || !signed?.[1] || !sig?.[1]) return { error: "Authorization header is malformed." };
    const parts = cred[1].split("/");
    if (parts.length !== 5) return { error: "Credential scope is malformed." };
    const amzDate = request.headers.get("x-amz-date") ?? "";
    if (!amzDate) return { error: "Missing x-amz-date." };
    return {
      accessKeyId: parts[0] ?? "",
      dateStamp: parts[1] ?? "",
      region: parts[2] ?? "",
      service: parts[3] ?? "",
      signedHeaders: signed[1].split(";").filter(Boolean),
      signature: sig[1].toLowerCase(),
      amzDate,
      expiresSec: null,
      presigned: false,
    };
  }
  if ((url.searchParams.get("X-Amz-Algorithm") ?? "").toUpperCase() === "AWS4-HMAC-SHA256") {
    const cred = url.searchParams.get("X-Amz-Credential") ?? "";
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    const sig = url.searchParams.get("X-Amz-Signature") ?? "";
    const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
    const expires = Number(url.searchParams.get("X-Amz-Expires") ?? "0");
    const parts = cred.split("/");
    if (parts.length !== 5 || !/^[0-9a-f]{64}$/i.test(sig) || !amzDate) {
      return { error: "Presigned URL is malformed." };
    }
    return {
      accessKeyId: parts[0] ?? "",
      dateStamp: parts[1] ?? "",
      region: parts[2] ?? "",
      service: parts[3] ?? "",
      signedHeaders: signed.split(";").filter(Boolean),
      signature: sig.toLowerCase(),
      amzDate,
      expiresSec: Number.isFinite(expires) ? expires : 0,
      presigned: true,
    };
  }
  return null;
}

export function verifySigV4(opts: {
  request: Request;
  body: Buffer;
  secret: string;
  parsed: ParsedAuth;
  now?: number;
}): { ok: true } | { ok: false; code: string; message: string } {
  const now = opts.now ?? Date.now();
  const when = parseAmz(opts.parsed.amzDate);
  if (when === null) return { ok: false, code: "AccessDenied", message: "Invalid date." };
  if (opts.parsed.presigned) {
    const exp = opts.parsed.expiresSec ?? 0;
    if (exp < 1 || exp > 604800) {
      return { ok: false, code: "AccessDenied", message: "Invalid expiry." };
    }
    if (now > when + exp * 1000) return { ok: false, code: "AccessDenied", message: "Request has expired." };
  } else if (Math.abs(now - when) > 15 * 60 * 1000) {
    return { ok: false, code: "RequestTimeTooSkewed", message: "The difference between the request time and the server's time is too large." };
  }
  if (opts.parsed.service !== "s3" || !opts.parsed.amzDate.startsWith(opts.parsed.dateStamp)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "Credential scope does not match." };
  }

  const url = new URL(opts.request.url);
  const declared = opts.request.headers.get("x-amz-content-sha256");
  const payloadHash = declared && declared.length > 0 ? declared : "UNSIGNED-PAYLOAD";
  if (/^[0-9a-f]{64}$/.test(payloadHash) && payloadHash !== sha256Hex(opts.body)) {
    return { ok: false, code: "XAmzContentSHA256Mismatch", message: "The provided x-amz-content-sha256 does not match the body." };
  }

  const headers = new Headers(opts.request.headers);
  if (!headers.get("host")) headers.set("host", url.host);
  const canonical = canonicalRequest({
    method: opts.request.method,
    uri: canonicalUri(url.pathname),
    query: canonicalQueryString(url),
    headers,
    signedHeaders: opts.parsed.signedHeaders,
    payloadHash,
  });
  const scope = `${opts.parsed.dateStamp}/${opts.parsed.region}/${opts.parsed.service}/aws4_request`;
  const toSign = stringToSign(opts.parsed.amzDate, scope, canonical);
  const expected = signatureHex(
    signingKey(opts.secret, opts.parsed.dateStamp, opts.parsed.region, opts.parsed.service),
    toSign,
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.parsed.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "The request signature we calculated does not match the signature you provided." };
  }
  return { ok: true };
}

export function decodeAwsChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const cr = buf.indexOf(0x0d, i);
    if (cr < 0 || buf[cr + 1] !== 0x0a) throw new Error("Malformed chunk");
    const line = buf.subarray(i, cr).toString("ascii");
    i = cr + 2;
    const size = Number.parseInt(line.split(";")[0]?.trim() ?? "", 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("Malformed chunk size");
    if (size === 0) break;
    if (i + size > buf.length) throw new Error("Truncated chunk");
    parts.push(buf.subarray(i, i + size));
    i += size;
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) i += 2;
  }
  return Buffer.concat(parts);
}

export function crc32Base64(buf: Buffer): string {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((~c) >>> 0);
  return out.toString("base64");
}
