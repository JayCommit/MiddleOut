import { createHash, createSign, randomUUID } from "node:crypto";
import { getSql, type Sql } from "../db.ts";

export interface GDriveCredentials {
  id: string;
  ownerId: string;
  provider: "gdrive";
  authType: "oauth" | "service_account";
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: string | null;
  serviceAccountJson: string;
  metadata: {
    email?: string;
    totalBytes?: number;
    usedBytes?: number;
    lastTested?: string;
  };
}

export interface GDriveBucketConfig {
  folderId: string;
  folderName?: string;
  mountMode?: "ro" | "rw";
  email?: string;
}

// In-memory cache for folder ID lookups: `${rootFolderId}:${path}` -> folderId
const folderCache = new Map<string, { id: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

function base64UrlEncode(str: string | Buffer): string {
  const buf = typeof str === "string" ? Buffer.from(str) : str;
  return buf.toString("base64url");
}

/**
 * Mint a Google Service Account OAuth2 Access Token using RS256 JWT assertion.
 */
async function getServiceAccountAccessToken(
  serviceAccountJson: string,
  fetchFn = fetch,
): Promise<{ accessToken: string; expiresIn: number; email: string }> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const toSign = `${encodedHeader}.${encodedClaimSet}`;

  const signer = createSign("RSA-SHA256");
  signer.update(toSign);
  const signature = signer.sign(sa.private_key, "base64url");
  const assertion = `${toSign}.${signature}`;

  const res = await fetchFn(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to exchange service account JWT for token: ${res.status} ${errorText}`);
  }

  const tokenData = (await res.json()) as { access_token: string; expires_in?: number };
  return {
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in ?? 3600,
    email: sa.client_email,
  };
}

/**
 * Refresh an OAuth2 access token using the stored refresh_token.
 */
async function refreshOAuth2AccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchFn = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to refresh OAuth token: ${res.status} ${errorText}`);
  }

  const tokenData = (await res.json()) as { access_token: string; expires_in?: number };
  return {
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in ?? 3600,
  };
}

/**
 * Get active access token for user's Google Drive credentials, refreshing if needed.
 */
export async function getValidDriveAccessToken(
  ownerId: string,
  fetchFn = fetch,
): Promise<{ token: string; creds: GDriveCredentials }> {
  const creds = await getDriveCredentials(ownerId);
  if (!creds) {
    throw new Error("No Google Drive integration connected for this account.");
  }

  const now = Date.now();
  const expiryTime = creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() : 0;
  // If token is still valid with 2 minutes grace period, reuse it
  if (creds.accessToken && expiryTime > now + 120_000) {
    return { token: creds.accessToken, creds };
  }

  // Otherwise refresh
  let nextAccessToken = creds.accessToken;
  let expiresIn = 3600;

  if (creds.authType === "service_account" && creds.serviceAccountJson) {
    const tokenResult = await getServiceAccountAccessToken(creds.serviceAccountJson, fetchFn);
    nextAccessToken = tokenResult.accessToken;
    expiresIn = tokenResult.expiresIn;
  } else if (creds.refreshToken) {
    const tokenResult = await refreshOAuth2AccessToken(
      creds.clientId,
      creds.clientSecret,
      creds.refreshToken,
      fetchFn,
    );
    nextAccessToken = tokenResult.accessToken;
    expiresIn = tokenResult.expiresIn;
  }

  const newExpiry = new Date(now + expiresIn * 1000).toISOString();
  const sql = await getSql();
  await sql`
    update mo_external_credentials
    set access_token = ${nextAccessToken}, token_expiry = ${newExpiry}, updated_at = now()
    where id = ${creds.id}
  `;

  creds.accessToken = nextAccessToken;
  creds.tokenExpiry = newExpiry;
  return { token: nextAccessToken, creds };
}

/**
 * Retrieve stored Google Drive credentials for an owner.
 */
export async function getDriveCredentials(
  ownerId: string,
  sqlParam?: Sql,
): Promise<GDriveCredentials | null> {
  const sql = sqlParam ?? (await getSql());
  const rows = await sql<{
    id: string;
    owner_id: string;
    provider: string;
    auth_type: string;
    client_id: string;
    client_secret: string;
    access_token: string;
    refresh_token: string;
    token_expiry: unknown;
    service_account_json: string;
    metadata: string;
  }>`
    select id, owner_id, provider, auth_type, client_id, client_secret,
      access_token, refresh_token, token_expiry, service_account_json, metadata
    from mo_external_credentials
    where owner_id = ${ownerId} and provider = 'gdrive'
  `;

  const row = rows[0];
  if (!row) return null;

  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata || "{}");
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: "gdrive",
    authType: (row.auth_type as "oauth" | "service_account") || "oauth",
    clientId: row.client_id,
    clientSecret: row.client_secret,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiry: row.token_expiry ? new Date(String(row.token_expiry)).toISOString() : null,
    serviceAccountJson: row.service_account_json,
    metadata,
  };
}

/**
 * Save or update Google Drive credentials.
 */
export async function saveDriveCredentials(
  ownerId: string,
  input: {
    authType: "oauth" | "service_account";
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiry?: string;
    serviceAccountJson?: string;
    metadata?: Record<string, unknown>;
  },
  sqlParam?: Sql,
): Promise<GDriveCredentials> {
  const sql = sqlParam ?? (await getSql());
  const id = randomUUID();
  const authType = input.authType;
  const clientId = input.clientId || "";
  const clientSecret = input.clientSecret || "";
  const accessToken = input.accessToken || "";
  const refreshToken = input.refreshToken || "";
  const tokenExpiry = input.tokenExpiry ? new Date(input.tokenExpiry).toISOString() : null;
  const serviceAccountJson = input.serviceAccountJson || "";
  const metadata = JSON.stringify(input.metadata || {});

  await sql`
    insert into mo_external_credentials (
      id, owner_id, provider, auth_type, client_id, client_secret,
      access_token, refresh_token, token_expiry, service_account_json, metadata,
      created_at, updated_at
    ) values (
      ${id}, ${ownerId}, 'gdrive', ${authType}, ${clientId}, ${clientSecret},
      ${accessToken}, ${refreshToken}, ${tokenExpiry}, ${serviceAccountJson}, ${metadata},
      now(), now()
    )
    on conflict (owner_id, provider) do update set
      auth_type = excluded.auth_type,
      client_id = excluded.client_id,
      client_secret = excluded.client_secret,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expiry = excluded.token_expiry,
      service_account_json = excluded.service_account_json,
      metadata = excluded.metadata,
      updated_at = now()
  `;

  const creds = await getDriveCredentials(ownerId, sql);
  if (!creds) throw new Error("Failed to save credentials");
  return creds;
}

/**
 * Disconnect Google Drive integration.
 */
export async function deleteDriveCredentials(ownerId: string): Promise<boolean> {
  const sql = await getSql();
  await sql`delete from mo_external_credentials where owner_id = ${ownerId} and provider = 'gdrive'`;
  folderCache.clear();
  return true;
}

/**
 * Test Google Drive connection and query account/quota info.
 */
export async function testDriveConnection(
  ownerId: string,
  fetchFn = fetch,
): Promise<{
  ok: boolean;
  email?: string;
  totalBytes?: number;
  usedBytes?: number;
  error?: string;
}> {
  try {
    const { token, creds } = await getValidDriveAccessToken(ownerId, fetchFn);
    const res = await fetchFn(
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `Google Drive API error: ${res.status} ${err}` };
    }

    const data = (await res.json()) as {
      user?: { emailAddress?: string };
      storageQuota?: { limit?: string; usage?: string };
    };

    const email = data.user?.emailAddress || creds.metadata?.email;
    const totalBytes = data.storageQuota?.limit ? Number(data.storageQuota.limit) : 0;
    const usedBytes = data.storageQuota?.usage ? Number(data.storageQuota.usage) : 0;

    // Update metadata in DB
    const sql = await getSql();
    const updatedMeta = JSON.stringify({
      ...creds.metadata,
      email,
      totalBytes,
      usedBytes,
      lastTested: new Date().toISOString(),
    });
    await sql`
      update mo_external_credentials
      set metadata = ${updatedMeta}, updated_at = now()
      where id = ${creds.id}
    `;

    return { ok: true, email, totalBytes, usedBytes };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List folders in Google Drive under a parent folder.
 */
export async function listDriveFolders(
  ownerId: string,
  parentFolderId = "root",
  fetchFn = fetch,
): Promise<{ id: string; name: string }[]> {
  const { token } = await getValidDriveAccessToken(ownerId, fetchFn);
  const q = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`;

  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to list folders: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { files?: { id: string; name: string }[] };
  return data.files || [];
}

/**
 * Resolve or create hierarchical subfolders under rootFolderId for a given path.
 * E.g., for "a/b/file.txt", resolves parent folder "a/b".
 */
export async function resolveDriveFolder(
  rootFolderId: string,
  dirPath: string,
  createIfMissing = false,
  token: string,
  fetchFn = fetch,
): Promise<string | null> {
  const trimmed = dirPath.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return rootFolderId;

  const cacheKey = `${rootFolderId}:${trimmed}`;
  const cached = folderCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.id;
  }

  const segments = trimmed.split("/").filter(Boolean);
  let currentParentId = rootFolderId;

  for (const segment of segments) {
    const segmentKey = `${currentParentId}:${segment}`;
    const segmentCached = folderCache.get(segmentKey);
    if (segmentCached && segmentCached.expiresAt > Date.now()) {
      currentParentId = segmentCached.id;
      continue;
    }

    const q = `'${currentParentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;

    const res = await fetchFn(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Failed to query folder '${segment}': ${res.status}`);
    }

    const data = (await res.json()) as { files?: { id: string; name: string }[] };
    if (data.files && data.files.length > 0 && data.files[0]?.id) {
      currentParentId = data.files[0].id;
      folderCache.set(segmentKey, { id: currentParentId, expiresAt: Date.now() + CACHE_TTL_MS });
    } else if (createIfMissing) {
      // Create folder
      const createRes = await fetchFn("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: segment,
          mimeType: "application/vnd.google-apps.folder",
          parents: [currentParentId],
        }),
      });

      if (!createRes.ok) {
        throw new Error(`Failed to create folder '${segment}': ${createRes.status}`);
      }

      const created = (await createRes.json()) as { id: string };
      currentParentId = created.id;
      folderCache.set(segmentKey, { id: currentParentId, expiresAt: Date.now() + CACHE_TTL_MS });
    } else {
      return null;
    }
  }

  folderCache.set(cacheKey, { id: currentParentId, expiresAt: Date.now() + CACHE_TTL_MS });
  return currentParentId;
}

/**
 * Locate a file by its full S3-style key within the mounted Google Drive root folder.
 */
export async function findDriveFile(
  rootFolderId: string,
  key: string,
  token: string,
  fetchFn = fetch,
): Promise<{
  id: string;
  name: string;
  size?: string;
  mimeType?: string;
  modifiedTime?: string;
  md5Checksum?: string;
} | null> {
  const parts = key.split("/");
  const fileName = parts.pop()!;
  const dirPath = parts.join("/");

  const parentFolderId = await resolveDriveFolder(rootFolderId, dirPath, false, token, fetchFn);
  if (!parentFolderId) return null;

  const q = `'${parentFolderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,mimeType,modifiedTime,md5Checksum)&pageSize=1`;

  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    files?: {
      id: string;
      name: string;
      size?: string;
      mimeType?: string;
      modifiedTime?: string;
      md5Checksum?: string;
    }[];
  };
  return data.files?.[0] || null;
}

/**
 * List objects in a Google Drive mounted bucket.
 * Implements S3 recursive or delimited listing under a prefix.
 */
export async function gdriveListObjects(
  rootFolderId: string,
  ownerId: string,
  prefix: string,
  fetchFn = fetch,
): Promise<{ key: string; size: number; etag: string; updatedAt: string; contentType: string }[]> {
  const { token } = await getValidDriveAccessToken(ownerId, fetchFn);
  const objects: {
    key: string;
    size: number;
    etag: string;
    updatedAt: string;
    contentType: string;
  }[] = [];

  // Recursive search under parent folders
  async function crawl(currentFolderId: string, currentPrefix: string) {
    let pageToken: string | undefined;
    do {
      const q = `'${currentFolderId}' in parents and trashed = false`;
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", q);
      url.searchParams.set(
        "fields",
        "nextPageToken,files(id,name,size,mimeType,modifiedTime,md5Checksum)",
      );
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;

      const data = (await res.json()) as {
        nextPageToken?: string;
        files?: {
          id: string;
          name: string;
          size?: string;
          mimeType?: string;
          modifiedTime?: string;
          md5Checksum?: string;
        }[];
      };

      pageToken = data.nextPageToken;
      for (const file of data.files || []) {
        const itemKey = currentPrefix ? `${currentPrefix}/${file.name}` : file.name;
        if (file.mimeType === "application/vnd.google-apps.folder") {
          await crawl(file.id, itemKey);
        } else {
          if (!prefix || itemKey.startsWith(prefix)) {
            objects.push({
              key: itemKey,
              size: Number(file.size || 0),
              etag: file.md5Checksum || createHash("md5").update(file.id).digest("hex"),
              updatedAt: file.modifiedTime
                ? new Date(file.modifiedTime).toISOString()
                : new Date().toISOString(),
              contentType: file.mimeType || "application/octet-stream",
            });
          }
        }
      }
    } while (pageToken);
  }

  await crawl(rootFolderId, "");
  // Match the key comparison used by listing cursors, including Unicode names.
  objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return objects;
}

/**
 * Get object content and metadata from Google Drive.
 */
export async function gdriveGetObject(
  rootFolderId: string,
  key: string,
  ownerId: string,
  rangeHeader?: string | null,
  fetchFn = fetch,
): Promise<{
  bytes: Buffer;
  contentType: string;
  size: number;
  etag: string;
  updatedAt: string;
} | null> {
  const { token } = await getValidDriveAccessToken(ownerId, fetchFn);
  const file = await findDriveFile(rootFolderId, key, token, fetchFn);
  if (!file) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (rangeHeader) {
    headers.Range = rangeHeader;
  }

  const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to download file from Google Drive: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  return {
    bytes,
    contentType: file.mimeType || "application/octet-stream",
    size: Number(file.size ?? bytes.length),
    etag: file.md5Checksum || createHash("md5").update(file.id).digest("hex"),
    updatedAt: file.modifiedTime
      ? new Date(file.modifiedTime).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Upload object to Google Drive (creates or updates).
 */
export async function gdrivePutObject(
  rootFolderId: string,
  key: string,
  bytes: Buffer,
  contentType: string,
  ownerId: string,
  mountMode: "ro" | "rw" = "rw",
  fetchFn = fetch,
): Promise<{ ok: boolean; error?: string; etag?: string; size?: number }> {
  if (mountMode === "ro") {
    return { ok: false, error: "Bucket is mounted as Read-Only. Cannot modify files." };
  }

  const { token } = await getValidDriveAccessToken(ownerId, fetchFn);

  const parts = key.split("/");
  const fileName = parts.pop()!;
  const dirPath = parts.join("/");

  const parentFolderId = await resolveDriveFolder(rootFolderId, dirPath, true, token, fetchFn);
  if (!parentFolderId) {
    return { ok: false, error: "Could not resolve or create parent folder." };
  }

  // Check if file already exists
  const existing = await findDriveFile(rootFolderId, key, token, fetchFn);

  const boundary = `-------MiddleOutBoundary${Date.now()}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = existing
    ? { mimeType: contentType }
    : { name: fileName, mimeType: contentType, parents: [parentFolderId] };

  const multipartBody = Buffer.concat([
    Buffer.from(
      delimiter +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) +
        delimiter +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(closeDelimiter),
  ]);

  const uploadUrl = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const res = await fetchFn(uploadUrl, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Google Drive upload failed: ${res.status} ${err}` };
  }

  const result = (await res.json()) as { id: string; md5Checksum?: string };
  const etag = result.md5Checksum || createHash("md5").update(bytes).digest("hex");
  return { ok: true, etag, size: bytes.length };
}

/**
 * Delete object from Google Drive.
 */
export async function gdriveDeleteObject(
  rootFolderId: string,
  key: string,
  ownerId: string,
  mountMode: "ro" | "rw" = "rw",
  fetchFn = fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (mountMode === "ro") {
    return { ok: false, error: "Bucket is mounted as Read-Only. Cannot delete files." };
  }

  const { token } = await getValidDriveAccessToken(ownerId, fetchFn);
  const file = await findDriveFile(rootFolderId, key, token, fetchFn);
  if (!file) {
    return { ok: true }; // S3 idempotency
  }

  const res = await fetchFn(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    return { ok: false, error: `Google Drive delete failed: ${res.status} ${err}` };
  }

  return { ok: true };
}
