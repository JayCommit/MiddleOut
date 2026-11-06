import { listForS3 } from "./queries.server.ts";

/** Search complete object keys recursively, consuming every listing page. */
export async function searchBucket(ownerId: string, bucket: string, query: string) {
  const results: { bucket: string; key: string; size: number; etag: string; updatedAt: string }[] =
    [];
  let cursor = "";
  const needle = query.toLowerCase();
  for (;;) {
    const page = await listForS3(ownerId, bucket, "", "", 1000, cursor);
    if ("error" in page) throw new Error(page.error);
    for (const object of page.contents) {
      if (object.key.toLowerCase().includes(needle)) results.push({ bucket, ...object });
    }
    if (!page.truncated) break;
    if (!page.nextStart || page.nextStart <= cursor)
      throw new Error("Object listing did not advance.");
    cursor = page.nextStart;
  }
  return results;
}
