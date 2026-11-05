import { getRequest } from "@tanstack/react-start/server";

/** Reject scripted requests from sibling or unrelated browser origins. */
export class CrossSiteRequestError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden: cross-site request blocked");
    this.name = "CrossSiteRequestError";
  }
}

/** Throw `CrossSiteRequestError` for a scripted cross-site/sibling request. */
export function assertSameSiteRequest(req?: Request): void {
  const request = req ?? getRequest();
  if (!request) return; // no request context (e.g. build) — nothing to guard
  const h = request.headers;
  const origin = h.get("origin");
  if (origin) {
    let reqOrigin = "";
    let configuredOrigin = "";
    try {
      reqOrigin = new URL(request.url).origin;
      configuredOrigin = process.env.BETTER_AUTH_URL
        ? new URL(process.env.BETTER_AUTH_URL).origin
        : reqOrigin;
    } catch {
      throw new CrossSiteRequestError();
    }
    if (origin === "null" || (origin !== reqOrigin && origin !== configuredOrigin)) {
      throw new CrossSiteRequestError();
    }
  }
  const site = h.get("sec-fetch-site");
  // Non-browser client (no header), the app's own origin, or a direct
  // (address-bar/bookmark) load are all fine.
  if (!site || site === "same-origin" || site === "none") return;
  // A top-level GET navigation (e.g. the broker's OAuth callback redirect) is
  // fine even when it's cross-site; scripted requests never set navigate mode.
  const dest = h.get("sec-fetch-dest");
  const isTopLevelGet =
    h.get("sec-fetch-mode") === "navigate" &&
    request.method === "GET" &&
    dest !== "object" &&
    dest !== "embed";
  if (isTopLevelGet) return;
  throw new CrossSiteRequestError();
}
