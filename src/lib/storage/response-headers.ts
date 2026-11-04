/** Object data is untrusted, even when its owner is a signed-in operator. */
export function untrustedResponseHeaders(headers: Headers): Headers {
  headers.set(
    "content-security-policy",
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

const ACTIVE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/xsl",
  "text/rdf",
  "text/cache-manifest",
  "multipart/x-mixed-replace",
  "message/rfc822",
  "application/x-mimearchive",
  "application/x-shockwave-flash",
]);

const ACTIVE_EXTENSION_RE = /\.(?:html?|xhtml|shtml|svg|xml|xsl|xslt|rdf|js|mjs|cjs|mht|mhtml|swf)$/i;

export function objectResponseHeaders(headers: Headers, key: string, download = false): Headers {
  untrustedResponseHeaders(headers);
  const type = (headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const name = key.split("/").pop() || "download";
  if (
    download ||
    ACTIVE_MIME_TYPES.has(type) ||
    type.endsWith("/xml") ||
    type.endsWith("+xml") ||
    ACTIVE_EXTENSION_RE.test(name)
  ) {
    const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_");
    headers.set(
      "content-disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    );
  } else {
    headers.delete("content-disposition");
  }
  return headers;
}
