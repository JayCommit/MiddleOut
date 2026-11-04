import { previewPathPrefix } from "@/lib/preview-path-prefix";

export function withBase(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof window === "undefined") return normalized;
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
  return `${prefix}${normalized}`;
}

export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${withBase(path)}`;
}

export function s3Endpoint(): string {
  return absoluteUrl("/api/s3");
}
