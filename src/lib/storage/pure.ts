export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;

export const REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
] as const;

export type RegionId = (typeof REGIONS)[number];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function validateBucketName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (name.length < 3 || name.length > 63) return "Use 3–63 characters.";
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    return "Lowercase letters, numbers, dots, and hyphens only.";
  }
  if (name.includes("..") || name.includes(".-") || name.includes("-.")) {
    return "That name isn't a valid bucket name.";
  }
  return null;
}

export function normalizeBucketName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateKey(key: string): string | null {
  if (!key) return "Object name is required.";
  if (key.startsWith("/") || key.includes("//")) return "Object name is invalid.";
  if (key.includes("\0") || key.length > 1024) return "Object name is invalid.";
  if (key.split("/").some((part) => part === "." || part === ".."))
    return "Object name is invalid.";
  return null;
}

const TYPES: Record<string, string> = {
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  md: "text/markdown",
  xml: "application/xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
};

export function guessType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

export function leafName(full: string, parent: string): string {
  const rest = full.slice(parent.length).replace(/\/$/, "");
  const slash = rest.lastIndexOf("/");
  return slash >= 0 ? rest.slice(slash + 1) : rest;
}

export const ACTION_LABEL: Record<string, string> = {
  "bucket.create": "Created bucket",
  "bucket.delete": "Deleted bucket",
  "bucket.acl": "Changed access",
  "object.put": "Uploaded",
  "object.delete": "Deleted object",
  "key.create": "Created access key",
  "key.revoke": "Revoked access key",
};

export type ListingRow = { key: string };

export function groupListing<T extends ListingRow>(
  rows: T[],
  opts: {
    prefix: string;
    delimiter: string;
    maxKeys: number;
    rawCapped: boolean;
    skipExactPrefix?: boolean;
  },
): { contents: T[]; prefixes: string[]; truncated: boolean; nextStart: string | null } {
  if (opts.maxKeys <= 0) return { contents: [], prefixes: [], truncated: false, nextStart: null };
  const contents: T[] = [];
  const prefixes: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  let truncated = false;
  let nextStart: string | null = null;
  let lastConsumed: string | null = null;

  for (const row of rows) {
    if (!row.key.startsWith(opts.prefix) || (opts.skipExactPrefix && row.key === opts.prefix)) {
      lastConsumed = row.key;
      continue;
    }
    const rest = row.key.slice(opts.prefix.length);
    let common: string | null = null;
    if (opts.delimiter) {
      const idx = rest.indexOf(opts.delimiter);
      if (idx >= 0) common = opts.prefix + rest.slice(0, idx + opts.delimiter.length);
    }
    const isNew = common ? !seen.has(common) : true;
    if (isNew && count >= opts.maxKeys) {
      truncated = true;
      nextStart = lastConsumed;
      break;
    }
    lastConsumed = row.key;
    if (!isNew) continue;
    count += 1;
    if (common) {
      seen.add(common);
      prefixes.push(common);
    } else {
      contents.push(row);
    }
  }

  if (!truncated && opts.rawCapped) {
    truncated = true;
    nextStart = lastConsumed;
  }
  return { contents, prefixes, truncated, nextStart };
}

export function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
