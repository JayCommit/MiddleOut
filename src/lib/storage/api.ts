import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

export const fetchOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const q = await import("./queries.server");
    return q.overview(context.userId);
  });

export const createBucketFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; isPublic: boolean }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.createBucket(context.userId, data.name, Boolean(data.isPublic));
  });

export const setBucketAccessFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; isPublic: boolean }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setBucketAccess(context.userId, data.name, Boolean(data.isPublic));
  });

export const deleteBucketFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; force: boolean }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.deleteBucket(context.userId, data.name, Boolean(data.force));
  });

export const browseFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; prefix: string; startAfter?: string }) => ({
    bucket: input.bucket,
    prefix: input.prefix ?? "",
    startAfter: input.startAfter ?? "",
  }))
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.browse(context.userId, data.bucket, data.prefix, data.startAfter);
  });

export const beginUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string; size: number; contentType: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.beginUpload(context.userId, data);
  });

export const writePartFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; part: number; data: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.writePart(context.userId, data.objectId, data.part, data.data);
  });

export const finishUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.finishUpload(context.userId, data.objectId);
  });

export const abortUploadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.abortUpload(context.userId, data.objectId);
  });

export const removeObjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.removeObject(context.userId, data.bucket, data.key);
  });

export const batchDeleteFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; keys: string[] }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.batchDeleteObjects(context.userId, data.bucket, data.keys);
  });

export const moveObjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; sourceKey: string; destKey: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.moveObject(context.userId, data.bucket, data.sourceKey, data.destKey);
  });

export const objectDetailFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.objectDetail(context.userId, data.bucket, data.key);
  });

export const readPartFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; part: number }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.readPartForOwner(context.userId, data.objectId, data.part);
  });

export const setTagsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { bucket: string; key: string; tags: { key: string; value: string }[] }) => input,
  )
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setTags(context.userId, data.bucket, data.key, data.tags ?? []);
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
    (input: { label: string; permission?: "full" | "read-only"; bucketScope?: string | null }) =>
      input,
  )
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.createKey(
      context.userId,
      data.label ?? "",
      data.permission ?? "full",
      data.bucketScope ?? null,
    );
  });

export const revokeKeyFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.revokeKey(context.userId, data.id);
  });

export const listAuditFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { offset?: number; search?: string } = {}) => ({
    search: typeof input.search === "string" ? input.search.slice(0, 200) : "",
    offset: Number.isSafeInteger(input.offset) && input.offset! >= 0 ? input.offset! : 0,
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
  .validator((input: { region: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.setRegion(context.userId, data.region);
  });

export const createLinkFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string; key: string; seconds: number }) => input)
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
  .validator((input: { token: string }) => input)
  .handler(async ({ context, data }) => {
    const q = await import("./queries.server");
    return q.revokeShare(context.userId, data.token);
  });

export const publicListingFn = createServerFn({ method: "POST" })
  .validator((input: { bucket: string; prefix: string; startAfter?: string }) => ({
    bucket: input.bucket,
    prefix: input.prefix ?? "",
    startAfter: input.startAfter ?? "",
  }))
  .handler(async ({ data }) => {
    const q = await import("./queries.server");
    return q.publicListing(data.bucket, data.prefix, data.startAfter);
  });

export const accessHintFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { bucket: string }) => input)
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
