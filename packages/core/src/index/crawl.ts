import type { ListedObject, ObjectStore } from "../store/types.js";

export interface RawObject {
  bucket: string;
  key: string;
  versionId: string | null;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number | null;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
  isMultipart: boolean | null;
  checksumAlgo: string | null;
  encryption: string | null;
  replication: string | null;
  itAccessTier: string | null;
  objectLockMode: string | null;
}

export function toRaw(bucket: string, object: ListedObject): RawObject {
  return {
    bucket,
    key: object.key,
    versionId: object.versionId,
    isLatest: object.isLatest,
    isDeleteMarker: object.isDeleteMarker,
    size: object.size,
    lastModified: object.lastModified ? toTimestamp(object.lastModified) : null,
    etag: object.etag,
    storageClass: object.storageClass,
    isMultipart: object.isMultipart,
    checksumAlgo: object.checksumAlgo,
    encryption: object.encryption,
    replication: object.replication,
    itAccessTier: object.itAccessTier,
    objectLockMode: object.objectLockMode,
  };
}

export function toTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function estimateCrawl(
  store: ObjectStore,
  bucket: string,
  prefix: string,
  depth: number,
): Promise<{ listRequests: number; shards: number }> {
  let listRequests = 0;
  let shards = 0;
  async function walk(current: string, remaining: number): Promise<void> {
    listRequests += 1;
    shards += 1;
    if (remaining <= 0) return;
    const page = await store.list({ bucket, prefix: current, delimiter: "/" });
    for (const child of page.commonPrefixes) await walk(child, remaining - 1);
  }
  await walk(prefix, depth);
  return { listRequests, shards };
}

export async function crawlBucket(
  store: ObjectStore,
  bucket: string,
  prefix: string,
  depth: number,
  onList?: () => void,
): Promise<{ rows: RawObject[]; listRequests: number }> {
  let versioning = false;
  try {
    versioning = (await store.getVersioning(bucket)).enabled;
  } catch {
    versioning = false;
  }
  const rows: RawObject[] = [];
  let listRequests = 0;

  async function collect(current: string): Promise<void> {
    let token: string | null = null;
    do {
      const page = await store.list({ bucket, prefix: current, token, versions: versioning });
      listRequests += 1;
      onList?.();
      for (const object of page.objects) rows.push(toRaw(bucket, object));
      token = page.nextToken;
    } while (token);
  }

  async function walk(current: string, remaining: number): Promise<void> {
    if (remaining <= 0) {
      await collect(current);
      return;
    }
    const seen = new Set<string>();
    let token: string | null = null;
    const prefixes: string[] = [];
    const here: ListedObject[] = [];
    do {
      const page = await store.list({ bucket, prefix: current, delimiter: "/", token, versions: versioning });
      listRequests += 1;
      onList?.();
      here.push(...page.objects);
      for (const child of page.commonPrefixes) {
        if (!seen.has(child)) {
          seen.add(child);
          prefixes.push(child);
        }
      }
      token = page.nextToken;
    } while (token);
    for (const object of here) rows.push(toRaw(bucket, object));
    if (prefixes.length === 0 && here.length === 0) return;
    for (const child of prefixes) await walk(child, remaining - 1);
  }

  await walk(prefix, depth);
  return { rows, listRequests };
}
