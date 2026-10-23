export type CapabilityState = "supported" | "not_supported" | "not_tested" | "not_found";

export interface Capabilities {
  list_objects: CapabilityState;
  list_versions: CapabilityState;
  versioning: CapabilityState;
  versioning_enabled: boolean;
  multipart: CapabilityState;
  tagging: CapabilityState;
  lifecycle: CapabilityState;
  object_lock: CapabilityState;
  presign: CapabilityState;
  checksums: CapabilityState;
  inventory: CapabilityState;
  notes: Record<string, string>;
}

export interface ListedObject {
  key: string;
  versionId: string | null;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number | null;
  lastModified: Date | null;
  etag: string | null;
  storageClass: string | null;
  isMultipart: boolean | null;
  checksumAlgo: string | null;
  encryption: string | null;
  replication: string | null;
  itAccessTier: string | null;
  objectLockMode: string | null;
  legalHold: boolean;
}

export interface ListPage {
  objects: ListedObject[];
  commonPrefixes: string[];
  nextToken: string | null;
}

export interface ObjectHead extends ListedObject {
  tags: Record<string, string>;
  body?: Uint8Array;
}

export interface MultipartUpload {
  key: string;
  uploadId: string;
  initiated: Date | null;
  partsBytes: number;
}

export interface LifecycleRule {
  ruleId: string;
  prefix: string;
  tags: Record<string, string>;
  minSize: number | null;
  actions: unknown;
}

export interface DeleteRequest {
  key: string;
  versionId?: string | null;
}

export interface DeleteResultItem {
  key: string;
  versionId: string | null;
  deleteMarkerVersionId: string | null;
}

export interface StoreErrorItem {
  key: string;
  message: string;
}

export interface ObjectStore {
  kind: "s3" | "memory";
  list(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    token?: string | null;
    versions?: boolean;
    maxKeys?: number;
  }): Promise<ListPage>;
  head(bucket: string, key: string, versionId?: string | null): Promise<ObjectHead | null>;
  getObject(bucket: string, key: string, versionId?: string | null): Promise<Uint8Array>;
  presign(bucket: string, key: string, expiresInSeconds: number, versionId?: string | null): Promise<string>;
  deleteObjects(bucket: string, items: DeleteRequest[]): Promise<{ deleted: DeleteResultItem[]; errors: StoreErrorItem[] }>;
  putTags(bucket: string, key: string, tags: Record<string, string>, versionId?: string | null): Promise<void>;
  listMultipart(bucket: string): Promise<MultipartUpload[]>;
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
  getVersioning(bucket: string): Promise<{ enabled: boolean }>;
  getLifecycle(bucket: string): Promise<LifecycleRule[]>;
  getObjectLock(bucket: string): Promise<{ enabled: boolean }>;
  getInventory(bucket: string): Promise<string | null>;
  listBuckets(): Promise<string[]>;
  createBucket(name: string): Promise<void>;
  /** Deletes an empty bucket. S3 rejects the call when the bucket still has objects. */
  deleteBucket(name: string): Promise<void>;
  putObject(bucket: string, key: string, body: Uint8Array): Promise<void>;
  getBucketPolicy(bucket: string): Promise<string | null>;
  putBucketPolicy(bucket: string, policy: string): Promise<void>;
  deleteBucketPolicy(bucket: string): Promise<void>;
}

export class StoreFeatureError extends Error {
  constructor(
    readonly feature: string,
    readonly reason: "not_supported" | "not_tested" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "StoreFeatureError";
  }
}

export function classifyStoreError(error: unknown): "not_supported" | "not_tested" | "not_found" {
  if (error instanceof StoreFeatureError) return error.reason;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`;
  if (/NoSuchConfiguration|NoSuchInventory|InventoryConfigurationNotFound|NoSuchLifecycleConfiguration|ObjectLockConfigurationNotFound|NoSuchTagSet|NoSuchBucketPolicy/i.test(text)) {
    return "not_found";
  }
  if (/NotImplemented|NotSupported|MethodNotAllowed|Unsupported/i.test(text)) return "not_supported";
  if (/AccessDenied|InvalidAccessKey|SignatureDoesNotMatch|UnknownEndpoint|ECONNREFUSED|ENOTFOUND|NetworkingError|Timeout/i.test(text)) {
    return "not_tested";
  }
  return "not_supported";
}
