import { untrustedResponseHeaders } from "../storage/response-headers.ts";
export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "\u0026amp;";
    if (ch === "<") return "\u0026lt;";
    if (ch === ">") return "\u0026gt;";
    if (ch === "'") return "\u0026#39;";
    return "\u0026quot;";
  });
}

export function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
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

export function listBucketsXml(
  buckets: { name: string; createdAt: string }[],
  owner: string,
): string {
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
  continuationToken?: string | null;
  startAfter?: string | null;
  marker?: string | null;
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

  if (opts.v2) {
    const continuationToken = opts.continuationToken
      ? `  <ContinuationToken>${xmlEscape(opts.continuationToken)}</ContinuationToken>\n`
      : "";
    const nextContinuationToken =
      opts.truncated && opts.next
        ? `  <NextContinuationToken>${xmlEscape(opts.next)}</NextContinuationToken>\n`
        : "";
    const startAfter = opts.startAfter
      ? `  <StartAfter>${xmlEscape(opts.startAfter)}</StartAfter>\n`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(opts.bucket)}</Name>
  <Prefix>${xmlEscape(opts.prefix)}</Prefix>
${startAfter}${continuationToken}${nextContinuationToken}  <KeyCount>${opts.contents.length + opts.prefixes.length}</KeyCount>
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <Delimiter>${xmlEscape(opts.delimiter)}</Delimiter>
  <IsTruncated>${opts.truncated}</IsTruncated>
${contents}
${prefixes}
</ListBucketResult>`;
  }

  const marker = `  <Marker>${xmlEscape(opts.marker ?? "")}</Marker>\n`;
  const nextMarker =
    opts.truncated && opts.next ? `  <NextMarker>${xmlEscape(opts.next)}</NextMarker>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(opts.bucket)}</Name>
  <Prefix>${xmlEscape(opts.prefix)}</Prefix>
${marker}${nextMarker}  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <Delimiter>${xmlEscape(opts.delimiter)}</Delimiter>
  <IsTruncated>${opts.truncated}</IsTruncated>
${contents}
${prefixes}
</ListBucketResult>`;
}

export function taggingXml(tags: { key: string; value: string }[]): string {
  const items = tags
    .map((t) => `    <Tag><Key>${xmlEscape(t.key)}</Key><Value>${xmlEscape(t.value)}</Value></Tag>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet>
${items}
  </TagSet>
</Tagging>`;
}

export function parseTaggingXml(xml: string): { key: string; value: string }[] {
  const tags: { key: string; value: string }[] = [];
  const tagRe = /<Tag>([\s\S]*?)<\/Tag>/g;
  let match = tagRe.exec(xml);
  while (match && tags.length <= 10) {
    const block = match[1] ?? "";
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const valMatch = /<Value>([\s\S]*?)<\/Value>/.exec(block);
    if (keyMatch && valMatch) {
      tags.push({
        key: xmlUnescape(keyMatch[1].trim()),
        value: xmlUnescape(valMatch[1].trim()),
      });
    }
    match = tagRe.exec(xml);
  }
  return tags;
}

export function initiateMultipartUploadXml(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <UploadId>${xmlEscape(uploadId)}</UploadId>
</InitiateMultipartUploadResult>`;
}

export function completeMultipartUploadXml(
  bucket: string,
  key: string,
  etag: string,
  location: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${xmlEscape(location)}</Location>
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <ETag>"${xmlEscape(etag)}"</ETag>
</CompleteMultipartUploadResult>`;
}

export function listPartsXml(opts: {
  bucket: string;
  key: string;
  uploadId: string;
  ownerId: string;
  parts: { partNumber: number; size: number; etag: string; updatedAt: string }[];
}): string {
  const items = opts.parts
    .map(
      (p) => `  <Part>
    <PartNumber>${p.partNumber}</PartNumber>
    <LastModified>${xmlEscape(p.updatedAt)}</LastModified>
    <ETag>"${xmlEscape(p.etag)}"</ETag>
    <Size>${p.size}</Size>
  </Part>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${xmlEscape(opts.bucket)}</Bucket>
  <Key>${xmlEscape(opts.key)}</Key>
  <UploadId>${xmlEscape(opts.uploadId)}</UploadId>
  <Owner><ID>${xmlEscape(opts.ownerId)}</ID><DisplayName>${xmlEscape(opts.ownerId)}</DisplayName></Owner>
  <StorageClass>STANDARD</StorageClass>
${items}
</ListPartsResult>`;
}

export function listMultipartUploadsXml(opts: {
  bucket: string;
  uploads: { uploadId: string; key: string; ownerId: string; createdAt: string }[];
}): string {
  const items = opts.uploads
    .map(
      (u) => `  <Upload>
    <Key>${xmlEscape(u.key)}</Key>
    <UploadId>${xmlEscape(u.uploadId)}</UploadId>
    <Owner><ID>${xmlEscape(u.ownerId)}</ID><DisplayName>${xmlEscape(u.ownerId)}</DisplayName></Owner>
    <Initiated>${xmlEscape(u.createdAt)}</Initiated>
    <StorageClass>STANDARD</StorageClass>
  </Upload>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${xmlEscape(opts.bucket)}</Bucket>
${items}
</ListMultipartUploadsResult>`;
}

export function withCors(res: Response): Response {
  const headers = untrustedResponseHeaders(new Headers(res.headers));
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, PUT, POST, DELETE, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  headers.set(
    "access-control-expose-headers",
    "ETag, x-amz-expiration, x-amz-request-id, Content-Range, Accept-Ranges, x-amz-checksum-crc32, x-amz-error-code",
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
