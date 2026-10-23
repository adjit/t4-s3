import { readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { createRequire } from "node:module";
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  GetBucketInventoryConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SecretMaterial } from "../secrets.js";
import {
  classifyStoreError,
  StoreFeatureError,
  type DeleteRequest,
  type LifecycleRule,
  type ListedObject,
  type ListPage,
  type MultipartUpload,
  type ObjectHead,
  type ObjectStore,
} from "./types.js";

export interface S3ConnectionSettings {
  endpoint: string;
  region: string;
  urlStyle: "path" | "virtual";
  useSsl: boolean;
  tlsVerify: boolean;
  caBundlePath?: string | null;
  requestRatePerSec?: number | null;
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private nextAt = 0;

  constructor(
    private readonly settings: S3ConnectionSettings,
    secret: SecretMaterial | undefined,
  ) {
    const endpoint = normalizeEndpoint(settings.endpoint, settings.useSsl);
    const config: S3ClientConfig = {
      region: settings.region || "us-east-1",
      endpoint,
      forcePathStyle: settings.urlStyle !== "virtual",
      requestHandler: nodeHttpHandler({
        httpAgent: new HttpAgent({ keepAlive: true }),
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          rejectUnauthorized: settings.tlsVerify,
          ca: settings.caBundlePath ? readFileSync(settings.caBundlePath) : undefined,
        }),
      }),
    };
    if (secret?.accessKeyId && secret.secretAccessKey) {
      config.credentials = {
        accessKeyId: secret.accessKeyId,
        secretAccessKey: secret.secretAccessKey,
        sessionToken: secret.sessionToken,
      };
    }
    this.client = new S3Client(config);
  }

  private async pace(): Promise<void> {
    const rate = this.settings.requestRatePerSec;
    if (!rate || rate <= 0) return;
    const gap = 1000 / rate;
    const wait = this.nextAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextAt = Date.now() + gap;
  }

  private async send<T>(command: { constructor: { name: string } }): Promise<T> {
    await this.pace();
    return this.client.send(command as never) as Promise<T>;
  }

  async list(input: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    token?: string | null;
    versions?: boolean;
    maxKeys?: number;
  }): Promise<ListPage> {
    if (input.versions) {
      const page = await this.send<{
        Versions?: Array<Record<string, unknown>>;
        DeleteMarkers?: Array<Record<string, unknown>>;
        CommonPrefixes?: Array<{ Prefix?: string }>;
        NextKeyMarker?: string;
        IsTruncated?: boolean;
      }>(
        new ListObjectVersionsCommand({
          Bucket: input.bucket,
          Prefix: input.prefix,
          Delimiter: input.delimiter,
          KeyMarker: input.token ?? undefined,
          MaxKeys: input.maxKeys,
        }),
      );
      const objects = [
        ...(page.Versions ?? []).map((item) => fromVersion(item, false)),
        ...(page.DeleteMarkers ?? []).map((item) => fromVersion(item, true)),
      ];
      return {
        objects,
        commonPrefixes: (page.CommonPrefixes ?? []).map((item) => item.Prefix ?? "").filter(Boolean),
        nextToken: page.IsTruncated ? page.NextKeyMarker ?? null : null,
      };
    }
    const page = await this.send<{
      Contents?: Array<Record<string, unknown>>;
      CommonPrefixes?: Array<{ Prefix?: string }>;
      NextContinuationToken?: string;
      IsTruncated?: boolean;
    }>(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        ContinuationToken: input.token ?? undefined,
        MaxKeys: input.maxKeys,
      }),
    );
    return {
      objects: (page.Contents ?? []).map(fromContent),
      commonPrefixes: (page.CommonPrefixes ?? []).map((item) => item.Prefix ?? "").filter(Boolean),
      nextToken: page.IsTruncated ? page.NextContinuationToken ?? null : null,
    };
  }

  async head(bucket: string, key: string, versionId?: string | null): Promise<ObjectHead | null> {
    try {
      const response = await this.send<Record<string, unknown>>(
        new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined }),
      );
      const tags = await this.tags(bucket, key, versionId).catch(() => ({}));
      return {
        key,
        versionId: stringOrNull(response.VersionId) ?? versionId ?? null,
        isLatest: true,
        isDeleteMarker: response.DeleteMarker === true,
        size: numberOrNull(response.ContentLength),
        lastModified: response.LastModified instanceof Date ? response.LastModified : null,
        etag: stripEtag(stringOrNull(response.ETag)),
        storageClass: stringOrNull(response.StorageClass),
        isMultipart: isMultipartEtag(stringOrNull(response.ETag)),
        checksumAlgo: checksumOf(response),
        encryption: stringOrNull(response.ServerSideEncryption),
        replication: stringOrNull(response.ReplicationStatus),
        itAccessTier: null,
        objectLockMode: stringOrNull(response.ObjectLockMode),
        legalHold: response.ObjectLockLegalHoldStatus === "ON",
        tags,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async tags(bucket: string, key: string, versionId?: string | null): Promise<Record<string, string>> {
    const response = await this.send<{ TagSet?: Array<{ Key?: string; Value?: string }> }>(
      new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined }),
    );
    const tags: Record<string, string> = {};
    for (const tag of response.TagSet ?? []) {
      if (tag.Key) tags[tag.Key] = tag.Value ?? "";
    }
    return tags;
  }

  async getObject(bucket: string, key: string, versionId?: string | null): Promise<Uint8Array> {
    const response = await this.send<{ Body?: { transformToByteArray: () => Promise<Uint8Array> } }>(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined }),
    );
    if (!response.Body) return new Uint8Array();
    return response.Body.transformToByteArray();
  }

  async presign(bucket: string, key: string, expiresInSeconds: number, versionId?: string | null): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObjects(bucket: string, items: DeleteRequest[]) {
    const response = await this.send<{
      Deleted?: Array<{ Key?: string; VersionId?: string; DeleteMarkerVersionId?: string }>;
      Errors?: Array<{ Key?: string; Message?: string }>;
    }>(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: items.map((item) => ({ Key: item.key, VersionId: item.versionId ?? undefined })),
          Quiet: false,
        },
      }),
    );
    return {
      deleted: (response.Deleted ?? []).map((item) => ({
        key: item.Key ?? "",
        versionId: item.VersionId ?? null,
        deleteMarkerVersionId: item.DeleteMarkerVersionId ?? null,
      })),
      errors: (response.Errors ?? []).map((item) => ({ key: item.Key ?? "", message: item.Message ?? "Delete failed" })),
    };
  }

  async putTags(bucket: string, key: string, tags: Record<string, string>, versionId?: string | null): Promise<void> {
    await this.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId ?? undefined,
        Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
  }

  async listMultipart(bucket: string): Promise<MultipartUpload[]> {
    const response = await this.send<{
      Uploads?: Array<{ Key?: string; UploadId?: string; Initiated?: Date }>;
    }>(new ListMultipartUploadsCommand({ Bucket: bucket }));
    const uploads: MultipartUpload[] = [];
    for (const upload of response.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      let partsBytes = 0;
      try {
        const parts = await this.send<{ Parts?: Array<{ Size?: number }> }>(
          new ListPartsCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId }),
        );
        partsBytes = (parts.Parts ?? []).reduce((sum, part) => sum + (part.Size ?? 0), 0);
      } catch (error) {
        if (classifyStoreError(error) === "not_tested") throw error;
      }
      uploads.push({
        key: upload.Key,
        uploadId: upload.UploadId,
        initiated: upload.Initiated ?? null,
        partsBytes,
      });
    }
    return uploads;
  }

  async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  }

  async getVersioning(bucket: string): Promise<{ enabled: boolean }> {
    const response = await this.send<{ Status?: string }>(new GetBucketVersioningCommand({ Bucket: bucket }));
    return { enabled: response.Status === "Enabled" };
  }

  async getLifecycle(bucket: string): Promise<LifecycleRule[]> {
    try {
      const response = await this.send<{
        Rules?: Array<{
          ID?: string;
          Filter?: { Prefix?: string };
          Prefix?: string;
          AbortIncompleteMultipartUpload?: unknown;
          Expiration?: unknown;
          Transitions?: unknown;
        }>;
      }>(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      return (response.Rules ?? []).map((rule, index) => ({
        ruleId: rule.ID || `rule-${index + 1}`,
        prefix: rule.Filter?.Prefix ?? rule.Prefix ?? "",
        tags: {},
        minSize: null,
        actions: {
          expiration: rule.Expiration ?? null,
          transitions: rule.Transitions ?? null,
          abortIncompleteMultipartUpload: rule.AbortIncompleteMultipartUpload ?? null,
        },
      }));
    } catch (error) {
      if (classifyStoreError(error) === "not_found") return [];
      throw error;
    }
  }

  async getObjectLock(bucket: string): Promise<{ enabled: boolean }> {
    try {
      const response = await this.send<{ ObjectLockConfiguration?: { ObjectLockEnabled?: string } }>(
        new GetObjectLockConfigurationCommand({ Bucket: bucket }),
      );
      return { enabled: response.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled" };
    } catch (error) {
      if (classifyStoreError(error) === "not_found") return { enabled: false };
      throw error;
    }
  }

  async getInventory(bucket: string): Promise<string | null> {
    try {
      await this.send(new GetBucketInventoryConfigurationCommand({ Bucket: bucket, Id: "t4" }));
      return "t4";
    } catch (error) {
      const reason = classifyStoreError(error);
      if (reason === "not_found") return null;
      throw new StoreFeatureError("inventory", reason, error instanceof Error ? error.message : "Inventory probe failed");
    }
  }

  async listBuckets(): Promise<string[]> {
    const response = await this.send<{ Buckets?: Array<{ Name?: string }> }>(new ListBucketsCommand({}));
    return (response.Buckets ?? []).map((bucket) => bucket.Name ?? "").filter(Boolean);
  }

  async createBucket(name: string): Promise<void> {
    const region = this.settings.region || "us-east-1";
    await this.send(
      new CreateBucketCommand({
        Bucket: name,
        CreateBucketConfiguration: region === "us-east-1" ? undefined : { LocationConstraint: region as never },
      }),
    );
  }

  async deleteBucket(name: string): Promise<void> {
    await this.send(new DeleteBucketCommand({ Bucket: name }));
  }

  async putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
    await this.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength }));
  }

  async getBucketPolicy(bucket: string): Promise<string | null> {
    try {
      const response = await this.send<{ Policy?: string }>(new GetBucketPolicyCommand({ Bucket: bucket }));
      return response.Policy ?? null;
    } catch (error) {
      if (classifyStoreError(error) === "not_found") return null;
      throw error;
    }
  }

  async putBucketPolicy(bucket: string, policy: string): Promise<void> {
    await this.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
  }

  async deleteBucketPolicy(bucket: string): Promise<void> {
    try {
      await this.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    } catch (error) {
      if (classifyStoreError(error) === "not_found") return;
      throw error;
    }
  }
}

// Loaded from the S3 client install. @smithy/node-http-handler is not hoisted for this package.
function nodeHttpHandler(options: { httpAgent: HttpAgent; httpsAgent: HttpsAgent }): S3ClientConfig["requestHandler"] {
  const require = createRequire(import.meta.url);
  const fromS3 = createRequire(require.resolve("@aws-sdk/client-s3/package.json"));
  const smithy = fromS3("@smithy/node-http-handler") as {
    NodeHttpHandler: new (options: { httpAgent: HttpAgent; httpsAgent: HttpsAgent }) => S3ClientConfig["requestHandler"];
  };
  return new smithy.NodeHttpHandler(options);
}

export function normalizeEndpoint(endpoint: string, useSsl: boolean): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${useSsl ? "https" : "http"}://${endpoint}`;
}

function fromContent(item: Record<string, unknown>): ListedObject {
  const etag = stripEtag(stringOrNull(item.ETag));
  return {
    key: String(item.Key ?? ""),
    versionId: null,
    isLatest: true,
    isDeleteMarker: false,
    size: numberOrNull(item.Size),
    lastModified: item.LastModified instanceof Date ? item.LastModified : null,
    etag,
    storageClass: stringOrNull(item.StorageClass),
    isMultipart: isMultipartEtag(etag),
    checksumAlgo: checksumOf(item),
    encryption: null,
    replication: null,
    itAccessTier: null,
    objectLockMode: null,
    legalHold: false,
  };
}

function fromVersion(item: Record<string, unknown>, isDeleteMarker: boolean): ListedObject {
  const etag = stripEtag(stringOrNull(item.ETag));
  return {
    key: String(item.Key ?? ""),
    versionId: stringOrNull(item.VersionId),
    isLatest: item.IsLatest === true,
    isDeleteMarker,
    size: numberOrNull(item.Size),
    lastModified: item.LastModified instanceof Date ? item.LastModified : null,
    etag,
    storageClass: stringOrNull(item.StorageClass),
    isMultipart: isMultipartEtag(etag),
    checksumAlgo: checksumOf(item),
    encryption: null,
    replication: null,
    itAccessTier: null,
    objectLockMode: null,
    legalHold: false,
  };
}

function stripEtag(etag: string | null): string | null {
  if (!etag) return null;
  return etag.replaceAll('"', "");
}

function isMultipartEtag(etag: string | null): boolean {
  return !!etag && /-\d+$/.test(etag);
}

function checksumOf(item: Record<string, unknown>): string | null {
  if (item.ChecksumCRC32) return "CRC32";
  if (item.ChecksumCRC32C) return "CRC32C";
  if (item.ChecksumSHA1) return "SHA1";
  if (item.ChecksumSHA256) return "SHA256";
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isNotFound(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return name === "NotFound" || name === "NoSuchKey" || /Not Found|NoSuchKey|404/.test(error instanceof Error ? error.message : "");
}
