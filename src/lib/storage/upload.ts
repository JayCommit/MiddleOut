import { CHUNK_BYTES, MAX_OBJECT_BYTES, formatBytes, guessType } from "@/lib/storage/pure";
import { beginUploadFn, finishUploadFn, readPartFn, writePartFn } from "@/lib/storage/api";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(blob);
  });
}

export async function uploadFile(opts: {
  bucket: string;
  key: string;
  file: Blob;
  contentType?: string;
  onProgress?: (ratio: number) => void;
}) {
  if (opts.file.size > MAX_OBJECT_BYTES) {
    return { ok: false as const, error: `Files are limited to ${formatBytes(MAX_OBJECT_BYTES)}.` };
  }
  const contentType =
    opts.contentType ||
    (opts.file instanceof File && opts.file.type ? opts.file.type : "") ||
    guessType(opts.key);
  const started = await beginUploadFn({
    data: { bucket: opts.bucket, key: opts.key, size: opts.file.size, contentType },
  });
  if (!started.ok) return started;
  if (opts.file.size === 0) {
    opts.onProgress?.(1);
    return finishUploadFn({ data: { objectId: started.id } });
  }
  const total = Math.ceil(opts.file.size / CHUNK_BYTES);
  for (let part = 0; part < total; part += 1) {
    const slice = opts.file.slice(part * CHUNK_BYTES, Math.min(opts.file.size, (part + 1) * CHUNK_BYTES));
    const data = await blobToBase64(slice);
    const wrote = await writePartFn({ data: { objectId: started.id, part, data } });
    if (!wrote.ok) return wrote;
    opts.onProgress?.((part + 1) / total);
  }
  return finishUploadFn({ data: { objectId: started.id } });
}

function b64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function downloadObject(objectId: string, partCount: number): Promise<Blob> {
  if (partCount <= 0) return new Blob([]);
  const chunks: Uint8Array[] = [];
  for (let part = 0; part < partCount; part += 1) {
    const row = await readPartFn({ data: { objectId, part } });
    if (!row.ok) throw new Error(row.error);
    chunks.push(b64ToBytes(row.data));
  }
  const parts: BlobPart[] = chunks.map((chunk) => {
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    return copy;
  });
  return new Blob(parts);
}
