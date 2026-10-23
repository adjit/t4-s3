import type { ObjectStore } from "./types.js";

export async function testConnection(store: ObjectStore, bucket?: string): Promise<{ ok: true; summary: string }> {
  if (bucket) {
    const page = await store.list({ bucket, maxKeys: 5 });
    const names = [...page.commonPrefixes, ...page.objects.map((object) => object.key)].slice(0, 5);
    const summary = names.length
      ? `Reached bucket ${bucket}. Sample: ${names.join(", ")}`
      : `Reached bucket ${bucket}. It is empty.`;
    return { ok: true, summary };
  }
  const buckets = await store.listBuckets();
  const summary = buckets.length
    ? `Reached the store. Buckets: ${buckets.join(", ")}`
    : "Reached the store. It has no buckets.";
  return { ok: true, summary };
}

export function connectionError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${name}${error.message}`;
  }
  return String(error);
}
