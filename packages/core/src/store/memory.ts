import { randomUUID } from "node:crypto";
import {
  StoreFeatureError,
  type DeleteRequest,
  type DeleteResultItem,
  type LifecycleRule,
  type ListedObject,
  type ListPage,
  type MultipartUpload,
  type ObjectHead,
  type ObjectStore,
  type StoreErrorItem,
} from "./types.js";

export interface MemoryObject extends ListedObject {
  bucket: string;
  tags: Record<string, string>;
  body?: Uint8Array;
  sequence: number;
}

export class MemoryStore implements ObjectStore {
  readonly kind = "memory" as const;
  readonly objects: MemoryObject[] = [];
  readonly uploads: Array<MultipartUpload & { bucket: string }> = [];
  readonly lifecycle = new Map<string, LifecycleRule[]>();
  readonly versioning = new Map<string, boolean>();
  readonly objectLock = new Map<string, boolean>();
  readonly buckets = new Set<string>();
  readonly policies = new Map<string, string>();
  readonly unsupported = new Set<string>();
  inventory: string | null = null;
  private sequence = 1;

  put(object: Omit<MemoryObject, "sequence" | "tags" | "legalHold"> & { tags?: Record<string, string>; legalHold?: boolean }): void {
    this.buckets.add(object.bucket);
    if (object.isLatest) {
      for (const existing of this.objects) {
        if (existing.bucket === object.bucket && existing.key === object.key && existing.isLatest) {
          existing.isLatest = false;
        }
      }
    }
    this.objects.push({
      ...object,
      tags: object.tags ?? {},
      legalHold: object.legalHold ?? false,
      sequence: this.sequence,
    });
    this.sequence += 1;
  }

  private guard(feature: string): void {
    if (this.unsupported.has(feature)) {
      throw new StoreFeatureError(feature, "not_supported", `${feature} is not implemented by this store`);
    }
  }

  async list(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    token?: string | null;
    versions?: boolean;
    maxKeys?: number;
  }): Promise<ListPage> {
    this.guard(input.versions ? "list_versions" : "list_objects");
    const prefix = input.prefix ?? "";
    const rows = this.objects
      .filter((object) => object.bucket === input.bucket && object.key.startsWith(prefix))
      .filter((object) => (input.versions ? true : object.isLatest && !object.isDeleteMarker))
      .sort((a, b) => a.key.localeCompare(b.key) || (a.versionId ?? "").localeCompare(b.versionId ?? ""));
    const start = input.token ? rows.findIndex((row) => row.key > input.token!) : 0;
    const slice = rows.slice(Math.max(0, start));
    if (!input.delimiter) {
      const objects = slice.map(toListed);
      return { objects: input.maxKeys ? objects.slice(0, input.maxKeys) : objects, commonPrefixes: [], nextToken: null };
    }
    const objects: ListedObject[] = [];
    const prefixes = new Set<string>();
    for (const object of slice) {
      const rest = object.key.slice(prefix.length);
      const slash = rest.indexOf(input.delimiter);
      if (slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
      else objects.push(toListed(object));
    }
    return {
      objects: input.maxKeys ? objects.slice(0, input.maxKeys) : objects,
      commonPrefixes: [...prefixes].sort(),
      nextToken: null,
    };
  }

  async head(bucket: string, key: string, versionId?: string | null): Promise<ObjectHead | null> {
    const match = this.objects.find((object) => {
      if (object.bucket !== bucket || object.key !== key) return false;
      if (versionId) return object.versionId === versionId;
      return object.isLatest;
    });
    if (!match || (match.isDeleteMarker && !versionId)) return null;
    return { ...match, tags: { ...match.tags } };
  }

  async getObject(bucket: string, key: string, versionId?: string | null): Promise<Uint8Array> {
    const head = await this.head(bucket, key, versionId);
    if (!head?.body) throw new StoreFeatureError("get_object", "not_found", "Object has no body");
    return head.body;
  }

  async presign(bucket: string, key: string, expiresInSeconds: number, versionId?: string | null): Promise<string> {
    this.guard("presign");
    const version = versionId ? `&versionId=${encodeURIComponent(versionId)}` : "";
    return `memory://${bucket}/${encodeURIComponent(key)}?expires=${expiresInSeconds}${version}`;
  }

  async deleteObjects(
    bucket: string,
    items: DeleteRequest[],
  ): Promise<{ deleted: DeleteResultItem[]; errors: StoreErrorItem[] }> {
    this.guard("delete");
    const deleted: DeleteResultItem[] = [];
    const errors: StoreErrorItem[] = [];
    for (const item of items) {
      const versions = this.objects.filter((object) => object.bucket === bucket && object.key === item.key);
      const target = item.versionId
        ? versions.find((object) => object.versionId === item.versionId)
        : versions.find((object) => object.isLatest);
      if (!target) {
        errors.push({ key: item.key, message: "Not found" });
        continue;
      }
      if (target.objectLockMode || target.legalHold) {
        errors.push({ key: item.key, message: "Object Lock or legal hold" });
        continue;
      }
      if (item.versionId) {
        const index = this.objects.indexOf(target);
        this.objects.splice(index, 1);
        const remaining = this.objects
          .filter((object) => object.bucket === bucket && object.key === item.key)
          .sort((a, b) => a.sequence - b.sequence);
        for (const object of remaining) object.isLatest = false;
        if (remaining.length > 0) remaining[remaining.length - 1]!.isLatest = true;
        deleted.push({ key: item.key, versionId: item.versionId, deleteMarkerVersionId: null });
        continue;
      }
      if (this.versioning.get(bucket)) {
        for (const object of versions) object.isLatest = false;
        const markerId = `dm-${randomUUID()}`;
        this.objects.push({
          bucket,
          key: item.key,
          versionId: markerId,
          isLatest: true,
          isDeleteMarker: true,
          size: 0,
          lastModified: new Date(),
          etag: null,
          storageClass: null,
          isMultipart: false,
          checksumAlgo: null,
          encryption: null,
          replication: null,
          itAccessTier: null,
          objectLockMode: null,
          legalHold: false,
          tags: {},
          sequence: this.sequence,
        });
        this.sequence += 1;
        deleted.push({ key: item.key, versionId: target.versionId, deleteMarkerVersionId: markerId });
        continue;
      }
      for (const object of [...versions]) {
        this.objects.splice(this.objects.indexOf(object), 1);
      }
      deleted.push({ key: item.key, versionId: target.versionId, deleteMarkerVersionId: null });
    }
    return { deleted, errors };
  }

  async putTags(bucket: string, key: string, tags: Record<string, string>, versionId?: string | null): Promise<void> {
    this.guard("tagging");
    const head = this.objects.find((object) => object.bucket === bucket && object.key === key && (versionId ? object.versionId === versionId : object.isLatest));
    if (!head) throw new StoreFeatureError("tagging", "not_found", "Object not found");
    head.tags = { ...tags };
  }

  async listMultipart(bucket: string): Promise<MultipartUpload[]> {
    this.guard("multipart");
    return this.uploads.filter((upload) => upload.bucket === bucket).map(({ key, uploadId, initiated, partsBytes }) => ({
      key,
      uploadId,
      initiated,
      partsBytes,
    }));
  }

  async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
    this.guard("multipart");
    const index = this.uploads.findIndex((upload) => upload.bucket === bucket && upload.key === key && upload.uploadId === uploadId);
    if (index >= 0) this.uploads.splice(index, 1);
  }

  async getVersioning(bucket: string): Promise<{ enabled: boolean }> {
    this.guard("versioning");
    return { enabled: this.versioning.get(bucket) === true };
  }

  async getLifecycle(bucket: string): Promise<LifecycleRule[]> {
    this.guard("lifecycle");
    return this.lifecycle.get(bucket) ?? [];
  }

  async getObjectLock(bucket: string): Promise<{ enabled: boolean }> {
    this.guard("object_lock");
    return { enabled: this.objectLock.get(bucket) === true };
  }

  async getInventory(): Promise<string | null> {
    this.guard("inventory");
    return this.inventory;
  }

  async listBuckets(): Promise<string[]> {
    this.guard("list_buckets");
    return [...this.buckets].sort();
  }

  async createBucket(name: string): Promise<void> {
    this.guard("create_bucket");
    this.buckets.add(name);
  }

  async deleteBucket(name: string): Promise<void> {
    this.guard("delete_bucket");
    if (!this.buckets.has(name)) throw new StoreFeatureError("delete_bucket", "not_found", "NoSuchBucket");
    if (this.objects.some((object) => object.bucket === name)) throw new Error("BucketNotEmpty: The bucket you tried to delete is not empty");
    this.buckets.delete(name);
    this.policies.delete(name);
  }

  async putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
    this.guard("put_object");
    if (!this.buckets.has(bucket)) throw new StoreFeatureError("put_object", "not_found", "NoSuchBucket");
    this.put({
      bucket,
      key,
      versionId: this.versioning.get(bucket) ? randomUUID() : null,
      isLatest: true,
      isDeleteMarker: false,
      size: body.byteLength,
      lastModified: new Date(),
      etag: randomUUID().replaceAll("-", ""),
      storageClass: "STANDARD",
      isMultipart: false,
      checksumAlgo: null,
      encryption: null,
      replication: null,
      itAccessTier: null,
      objectLockMode: null,
      body,
    });
  }

  async getBucketPolicy(bucket: string): Promise<string | null> {
    this.guard("bucket_policy");
    if (!this.buckets.has(bucket)) throw new StoreFeatureError("bucket_policy", "not_found", "NoSuchBucket");
    return this.policies.get(bucket) ?? null;
  }

  async putBucketPolicy(bucket: string, policy: string): Promise<void> {
    this.guard("bucket_policy");
    if (!this.buckets.has(bucket)) throw new StoreFeatureError("bucket_policy", "not_found", "NoSuchBucket");
    this.policies.set(bucket, policy);
  }

  async deleteBucketPolicy(bucket: string): Promise<void> {
    this.guard("bucket_policy");
    if (!this.buckets.has(bucket)) throw new StoreFeatureError("bucket_policy", "not_found", "NoSuchBucket");
    this.policies.delete(bucket);
  }
}

function toListed(object: MemoryObject): ListedObject {
  return {
    key: object.key,
    versionId: object.versionId,
    isLatest: object.isLatest,
    isDeleteMarker: object.isDeleteMarker,
    size: object.size,
    lastModified: object.lastModified,
    etag: object.etag,
    storageClass: object.storageClass,
    isMultipart: object.isMultipart,
    checksumAlgo: object.checksumAlgo,
    encryption: object.encryption,
    replication: object.replication,
    itAccessTier: object.itAccessTier,
    objectLockMode: object.objectLockMode,
    legalHold: object.legalHold,
  };
}
