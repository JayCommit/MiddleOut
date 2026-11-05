import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

function asStr(v: unknown, maxLen = 1024): string {
  return typeof v === "string" ? v.slice(0, maxLen) : "";
}

export const fetchOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const q = await import("./queries.server");
    return q.overview(context.userId);
  });

export const createBucketFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    name: string;
    isPublic?: boolean;
    acl?: string;
    provider?: "local" | "gdrive";
    providerConfig?: Record<string, string | number | boolean | null>;
    isScratch?: boolean;
    ttlSeconds?: number;
  }) => ({
    name: asStr(input?.name, 128),
    isPublic: Boolean(input?.isPublic),
    acl: typeof input?.acl === "string" ? asStr(input.acl, 32) : undefined,
    provider: input?.provider === "gdrive" ? ("gdrive" as const) : ("local" as const),
    providerConfig: typeof input?.providerConfig === "object" && input?.providerConfig !== null ? (input.providerConfig as Record<string, string | number | boolean | null>) : undefined,
    isScratch: Boolean(input?.isScratch),
    ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.createBucket(context.userId, data.name, data.acl ?? data.isPublic, {
      provider: data.provider,
      providerConfig: data.providerConfig,
      isScratch: data.isScratch,
      ttlSeconds: data.ttlSeconds,
    });
  });

export const setBucketAccessFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; isPublic: boolean }) => ({
    name: asStr(input?.name, 128),
    isPublic: Boolean(input?.isPublic),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setBucketAccess(context.userId, data.name, data.isPublic);
  });

export const setBucketAclFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; acl: string }) => ({
    name: asStr(input?.name, 128),
    acl: asStr(input?.acl, 32),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setBucketAcl(context.userId, data.name, data.acl);
  });

export const getBucketAclFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string }) => ({
    name: asStr(input?.name, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.getBucketAcl(context.userId, data.name);
  });

export const setObjectAclFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string; acl: string }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1024),
    acl: asStr(input?.acl, 32),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setObjectAcl(context.userId, data.bucket, data.key, data.acl);
  });

export const getObjectAclFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1024),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.getObjectAcl(context.userId, data.bucket, data.key);
  });

export const getBucketCorsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string }) => ({
    name: asStr(input?.name, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.getBucketCors(context.userId, data.name);
  });

export const setBucketCorsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; corsRules: string }) => ({
    name: asStr(input?.name, 128),
    corsRules: asStr(input?.corsRules, 65536),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setBucketCors(context.userId, data.name, data.corsRules);
  });

export const updateStorageLimitsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { maxObject: number; quota: number }) => ({
    maxObject: Number(input?.maxObject),
    quota: Number(input?.quota),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.updateStorageLimits(context.userId, data.maxObject, data.quota);
  });

export const deleteBucketFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; force: boolean }) => ({
    name: asStr(input?.name, 128),
    force: Boolean(input?.force),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.deleteBucket(context.userId, data.name, data.force);
  });

export const browseFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; prefix: string; startAfter?: string }) => ({
    bucket: asStr(input?.bucket, 128),
    prefix: asStr(input?.prefix, 1024),
    startAfter: asStr(input?.startAfter, 1024),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.browse(context.userId, data.bucket, data.prefix, data.startAfter);
  });

export const beginUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string; size: number; contentType: string }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1025),
    size: typeof input?.size === "number" ? input.size : -1,
    contentType: asStr(input?.contentType, 256),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.beginUpload(context.userId, data);
  });

export const writePartFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; part: number; data: string }) => ({
    objectId: asStr(input?.objectId, 128),
    part: typeof input?.part === "number" ? input.part : -1,
    data: typeof input?.data === "string" ? input.data : "",
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.writePart(context.userId, data.objectId, data.part, data.data);
  });

export const finishUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string }) => ({
    objectId: asStr(input?.objectId, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.finishUpload(context.userId, data.objectId);
  });

export const abortUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string }) => ({
    objectId: asStr(input?.objectId, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.abortUpload(context.userId, data.objectId);
  });

export const removeObjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1025),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.removeObject(context.userId, data.bucket, data.key);
  });

export const batchDeleteFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; keys: string[] }) => ({
    bucket: asStr(input?.bucket, 128),
    keys: Array.isArray(input?.keys)
      ? input.keys.slice(0, 1001).map((k) => asStr(k, 1025))
      : [],
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.batchDeleteObjects(context.userId, data.bucket, data.keys);
  });

export const moveObjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; sourceKey: string; destKey: string }) => ({
    bucket: asStr(input?.bucket, 128),
    sourceKey: asStr(input?.sourceKey, 1025),
    destKey: asStr(input?.destKey, 1025),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.moveObject(context.userId, data.bucket, data.sourceKey, data.destKey);
  });

export const objectDetailFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1025),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.objectDetail(context.userId, data.bucket, data.key);
  });

export const readPartFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; part: number }) => ({
    objectId: asStr(input?.objectId, 128),
    part: typeof input?.part === "number" ? input.part : -1,
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.readPartForOwner(context.userId, data.objectId, data.part);
  });

export const setTagsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { bucket: string; key: string; tags: { key: string; value: string }[] }) => ({
      bucket: asStr(input?.bucket, 128),
      key: asStr(input?.key, 1025),
      tags: Array.isArray(input?.tags)
        ? input.tags.slice(0, 11).map((t) => ({
            key: asStr(t?.key, 64),
            value: asStr(t?.value, 128),
          }))
        : [],
    }),
  )
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setTags(context.userId, data.bucket, data.key, data.tags);
  });

export const listKeysFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const q = await import("./queries.server");
    return q.listKeys(context.userId);
  });

export const createKeyFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { label: string; permission?: "full" | "read-only"; bucketScope?: string | null }) => ({
      label: asStr(input?.label, 64),
      permission: (input?.permission === "read-only" ? "read-only" : "full") as
        | "full"
        | "read-only",
      bucketScope: input?.bucketScope ? asStr(input.bucketScope, 128) : null,
    }),
  )
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.createKey(
      context.userId,
      data.label,
      data.permission,
      data.bucketScope,
    );
  });

export const revokeKeyFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => ({
    id: asStr(input?.id, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.revokeKey(context.userId, data.id);
  });

export const listAuditFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { offset?: number; search?: string } = {}) => ({
    search: typeof input?.search === "string" ? input.search.slice(0, 200) : "",
    offset: Number.isSafeInteger(input?.offset) && input.offset! >= 0 ? input.offset! : 0,
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.listAudit(context.userId, data.offset, data.search);
  });

export const settingsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const q = await import("./queries.server");
    return q.getSettings(context.userId);
  });

export const setRegionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { region: string }) => ({
    region: asStr(input?.region, 64),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setRegion(context.userId, data.region);
  });

export const createLinkFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string; seconds: number }) => ({
    bucket: asStr(input?.bucket, 128),
    key: asStr(input?.key, 1025),
    seconds: typeof input?.seconds === "number" ? input.seconds : -1,
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.createLink(context.userId, data.bucket, data.key, data.seconds);
  });

export const listSharesFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const q = await import("./queries.server");
    return q.listShares(context.userId);
  });

export const revokeShareFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { token: string }) => ({
    token: asStr(input?.token, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.revokeShare(context.userId, data.token);
  });

export const publicListingFn = createServerFn({ method: "POST" })
  .validator((input: { bucket: string; prefix: string; startAfter?: string }) => ({
    bucket: asStr(input?.bucket, 128),
    prefix: asStr(input?.prefix, 1024),
    startAfter: asStr(input?.startAfter, 1024),
  }))
  .handler(async ({ data }) => {
    const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
    assertSameSiteRequest();
    const q = await import("./queries.server");
    return q.publicListing(data.bucket, data.prefix, data.startAfter);
  });

export const accessHintFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string }) => ({
    bucket: asStr(input?.bucket, 128),
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.accessHint(context.userId, data.bucket);
  });

export const cleanupExpiredFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const q = await import("./queries.server");
    return q.cleanupExpired();
  });

// --- Google Drive Cloud Integration Functions ---

export const getDriveCredentialsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getDriveCredentials } = await import("./gdrive.server");
    const creds = await getDriveCredentials(context.userId);
    if (!creds) return null;
    return {
      id: creds.id,
      provider: creds.provider,
      authType: creds.authType,
      clientId: creds.clientId,
      hasRefreshToken: Boolean(creds.refreshToken),
      hasServiceAccount: Boolean(creds.serviceAccountJson),
      email: creds.metadata?.email,
      totalBytes: creds.metadata?.totalBytes,
      usedBytes: creds.metadata?.usedBytes,
      lastTested: creds.metadata?.lastTested,
    };
  });

export const saveDriveCredentialsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    authType: "oauth" | "service_account";
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    serviceAccountJson?: string;
  }) => ({
    authType: input.authType === "service_account" ? ("service_account" as const) : ("oauth" as const),
    clientId: asStr(input.clientId, 256),
    clientSecret: asStr(input.clientSecret, 256),
    refreshToken: asStr(input.refreshToken, 1024),
    serviceAccountJson: asStr(input.serviceAccountJson, 65536),
  }))
  .handler(async ({ context, data }) => {
    const { saveDriveCredentials } = await import("./gdrive.server");
    return saveDriveCredentials(context.userId, data);
  });

export const deleteDriveCredentialsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { deleteDriveCredentials } = await import("./gdrive.server");
    return deleteDriveCredentials(context.userId);
  });

export const testDriveConnectionFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { testDriveConnection } = await import("./gdrive.server");
    return testDriveConnection(context.userId);
  });

export const listDriveFoldersFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { parentFolderId?: string }) => ({
    parentFolderId: asStr(input?.parentFolderId || "root", 256),
  }))
  .handler(async ({ context, data }) => {
    const { listDriveFolders } = await import("./gdrive.server");
    return listDriveFolders(context.userId, data.parentFolderId);
  });

// --- AI Agent Token Management Functions ---

export const listAgentTokensFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { listAgentTokens } = await import("./agents.server");
    return listAgentTokens(context.userId);
  });

export const createAgentTokenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    name: string;
    permissions?: "read" | "write" | "read-write" | "admin";
    bucketScope?: string;
    ttlDays?: number;
  }) => ({
    name: asStr(input?.name, 128),
    permissions: input?.permissions || "read-write",
    bucketScope: asStr(input?.bucketScope || "*", 256),
    ttlDays: typeof input?.ttlDays === "number" ? input.ttlDays : undefined,
  }))
  .handler(async ({ context, data }) => {
    const { createAgentToken } = await import("./agents.server");
    return createAgentToken(context.userId, data);
  });

export const revokeAgentTokenFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { tokenId: string }) => ({
    tokenId: asStr(input?.tokenId, 128),
  }))
  .handler(async ({ context, data }) => {
    const { revokeAgentToken } = await import("./agents.server");
    return revokeAgentToken(context.userId, data.tokenId);
  });
