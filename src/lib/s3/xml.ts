export function xmlEscape(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "\u0026amp;";
    if (ch === "<") return "\u0026lt;";
    if (ch === ">") return "\u0026gt;";
    return "\u0026quot;";
  });
}

export function xmlResponse(status: number, body: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  if (!headers.has("content-type")) headers.set("content-type", "application/xml");
  return new Response(status === 204 ? null : body, { status, headers });
}

export function xmlError(status: number, code: string, message: string, resource = ""): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${xmlEscape(code)}</Code>
  <Message>${xmlEscape(message)}</Message>
  <Resource>${xmlEscape(resource)}</Resource>
</Error>`;
  return xmlResponse(status, body, { "x-amz-error-code": code });
}

export function listBucketsXml(buckets: { name: string; createdAt: string }[], owner: string): string {
  const items = buckets
    .map(
      (b) =>
        `    <Bucket><Name>${xmlEscape(b.name)}</Name><CreationDate>${xmlEscape(b.createdAt)}</CreationDate></Bucket>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>${xmlEscape(owner)}</ID><DisplayName>${xmlEscape(owner)}</DisplayName></Owner>
  <Buckets>
${items}
  </Buckets>
</ListAllMyBucketsResult>`;
}

export function listObjectsXml(opts: {
  v2: boolean;
  bucket: string;
  prefix: string;
  delimiter: string;
  maxKeys: number;
  contents: { key: string; size: number; etag: string; updatedAt: string }[];
  prefixes: string[];
  truncated: boolean;
  next: string | null;
}): string {
  const contents = opts.contents
    .map(
      (o) => `  <Contents>
    <Key>${xmlEscape(o.key)}</Key>
    <LastModified>${xmlEscape(o.updatedAt)}</LastModified>
    <ETag>"${xmlEscape(o.etag)}"</ETag>
    <Size>${o.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
    )
    .join("\n");
  const prefixes = opts.prefixes
    .map((p) => `  <CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
    .join("\n");
  const token = opts.truncated && opts.next
    ? opts.v2
      ? `<NextContinuationToken>${xmlEscape(opts.next)}</NextContinuationToken>`
      : `<NextMarker>${xmlEscape(opts.next)}</NextMarker>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(opts.bucket)}</Name>
  <Prefix>${xmlEscape(opts.prefix)}</Prefix>
  <Delimiter>${xmlEscape(opts.delimiter)}</Delimiter>
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  ${opts.v2 ? `<KeyCount>${opts.contents.length + opts.prefixes.length}</KeyCount>` : ""}
  <IsTruncated>${opts.truncated}</IsTruncated>
  ${token}
${contents}
${prefixes}
</ListBucketResult>`;
}

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, PUT, POST, DELETE, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  headers.set(
    "access-control-expose-headers",
    "ETag, x-amz-request-id, Content-Range, Accept-Ranges, x-amz-checksum-crc32, x-amz-error-code",
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
