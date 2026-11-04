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

export function objectResponseHeaders(headers: Headers, key: string, download = false): Headers {
  untrustedResponseHeaders(headers);
  const type = (headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (
    download ||
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    type === "image/svg+xml" ||
    type.endsWith("/xml") ||
    type.endsWith("+xml")
  ) {
    const name = key.split("/").pop() || "download";
    const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_");
    headers.set(
      "content-disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    );
  }
  return headers;
}
