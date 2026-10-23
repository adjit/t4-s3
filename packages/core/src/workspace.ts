import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import {
  approvePlan,
  cancelPlan,
  createPlan,
  dryRunPlan,
  executePlan,
  undoPlan,
  type BucketPolicy,
} from "./actions/engine.js";
import { analyzerParams, loadAnalyzers, runAnalyzer, type Analyzer } from "./analyzers/runner.js";
import { Database, duckPath, execute, queryAll, queryOne, sqlLiteral } from "./duck/database.js";
import { isT4Error, T4Error } from "./errors.js";
import { crawlBucket, estimateCrawl } from "./index/crawl.js";
import { loadInventoryParquet, stageAndSwap } from "./index/ingest.js";
import { folderName } from "./keys.js";
import { asBoolean, asNumber, asString, parseJson } from "./plain.js";
import { buildFolderQuery, buildObjectQuery, type SearchFilters } from "./query/browse.js";
import { assertSafeConsoleSql, capSelect } from "./query/guard.js";
import { cronMatches, parseCron } from "./schedule.js";
import { SecretStore, type SecretMaterial } from "./secrets.js";
import { probeStore } from "./store/probe.js";
import { S3ObjectStore, normalizeEndpoint, type S3ConnectionSettings } from "./store/s3.js";
import { connectionError } from "./store/test-connection.js";
import type { Capabilities, ListedObject, ListPage, ObjectStore } from "./store/types.js";

export interface ConnectionInput {
  name: string;
  endpoint: string;
  region?: string;
  urlStyle?: "path" | "virtual";
  useSsl?: boolean;
  tlsVerify?: boolean;
  caBundlePath?: string | null;
  providerHint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  requestRatePerSec?: number | null;
}

export interface BucketInput {
  bucket: string;
  connectionId: string;
  indexMode?: "crawl" | "inventory";
  inventoryUri?: string | null;
  writeEnabled?: boolean;
  protectedPrefixes?: string[];
  staleAfterHours?: number;
}

export interface WorkspaceOptions {
  dataDir: string;
  databasePath?: string;
  memoryLimit?: string;
  threads?: string;
  analyzersDir?: string;
  storeFor?: (connection: Record<string, unknown>, role: "reader" | "writer") => ObjectStore | Promise<ObjectStore>;
  webhook?: (url: string, payload: unknown) => Promise<void>;
}

export class Workspace {
  readonly analyzers: Analyzer[];

  private constructor(
    readonly db: Database,
    private readonly secrets: SecretStore,
    private readonly options: WorkspaceOptions,
  ) {
    this.analyzers = loadAnalyzers(options.analyzersDir);
  }

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    mkdirSync(options.dataDir, { recursive: true });
    const database = await Database.open(options.databasePath ?? join(options.dataDir, "t4.duckdb"), {
      memoryLimit: options.memoryLimit,
      threads: options.threads,
      tempDirectory: join(options.dataDir, "tmp"),
    });
    return new Workspace(database, new SecretStore(join(options.dataDir, "secrets.json")), options);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async saveConnection(input: ConnectionInput, connectionId: string = randomUUID()): Promise<string> {
    const secretRef = `sec_${connectionId.replaceAll("-", "")}`;
    const secret: SecretMaterial = {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken,
    };
    this.secrets.put(secretRef, secret);
    await this.db.write((conn) =>
      execute(
        conn,
        `INSERT INTO connections
         (connection_id, name, endpoint, region, url_style, use_ssl, tls_verify, ca_bundle_path, provider_hint, reader_secret_ref, writer_secret_ref, request_rate_per_sec, created_at)
         VALUES ($id, $name, $endpoint, $region, $url_style, $use_ssl, $tls_verify, $ca, $provider, $reader, $writer, $rate, current_timestamp)
         ON CONFLICT (connection_id) DO UPDATE SET
           name = excluded.name, endpoint = excluded.endpoint, region = excluded.region,
           url_style = excluded.url_style, use_ssl = excluded.use_ssl, tls_verify = excluded.tls_verify,
           ca_bundle_path = excluded.ca_bundle_path, provider_hint = excluded.provider_hint,
           request_rate_per_sec = excluded.request_rate_per_sec`,
        {
          id: connectionId,
          name: input.name,
          endpoint: input.endpoint,
          region: input.region || "us-east-1",
          url_style: input.urlStyle ?? "path",
          use_ssl: input.useSsl ?? true,
          tls_verify: input.tlsVerify ?? true,
          ca: input.caBundlePath ?? null,
          provider: input.providerHint ?? "other",
          reader: secretRef,
          writer: secretRef,
          rate: input.requestRatePerSec ?? null,
        },
      ),
    );
    return connectionId;
  }

  async listConnections(): Promise<Record<string, unknown>[]> {
    const rows = await this.db.read((conn) =>
      queryAll(
        conn,
        `SELECT connection_id, name, endpoint, region, url_style, use_ssl, tls_verify, ca_bundle_path, provider_hint, reader_secret_ref, request_rate_per_sec, created_at
         FROM connections ORDER BY name`,
      ),
    );
    return rows.map((row) => {
      const secret = this.secrets.get(String(row.reader_secret_ref));
      return {
        ...row,
        has_credentials: Boolean(secret?.accessKeyId),
        access_key_id: secret?.accessKeyId ?? null,
      };
    });
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    const refs = new Set(
      [connection.reader_secret_ref, connection.writer_secret_ref]
        .map((ref) => (ref == null ? "" : String(ref)))
        .filter((ref) => ref !== ""),
    );
    const tracked = await this.db.read((conn) =>
      queryAll(conn, "SELECT bucket FROM buckets WHERE connection_id = $id", { id: connectionId }),
    );
    const names = tracked.map((row) => String(row.bucket));
    for (const bucket of names) {
      const busy = await this.db.read((conn) =>
        queryOne(conn, "SELECT plan_id, status FROM action_plans WHERE bucket = $bucket AND status IN ('approved', 'running')", { bucket }),
      );
      if (busy) {
        throw new T4Error(
          409,
          `Plan ${String(busy.plan_id).slice(0, 8)} for ${bucket} is ${String(busy.status)}. Cancel or finish it before removing this connection.`,
        );
      }
    }
    await this.db.write(async (conn) => {
      // The connection's buckets stop being indexed here. Their index rows go too, so a later
      // connection that reuses a bucket name starts clean. Plans, jobs, and the audit log stay.
      for (const bucket of names) await purgeBucketIndex(conn, bucket);
      await execute(conn, "DELETE FROM connections WHERE connection_id = $id", { id: connectionId });
      await insertAudit(conn, "local", "connection.delete", null, { connectionId, name: connection.name }, { untracked: names });
    });
    for (const ref of refs) this.secrets.delete(ref);
  }

  /** Live listing of current objects under a prefix, plus whether this app may delete them. */
  async folderInfo(bucket: string, prefix: string): Promise<Record<string, unknown>> {
    const policy = await this.policy(bucket);
    const store = await this.storeForBucket(bucket, "reader");
    const listed = await this.storeCall(() => listCurrent(store, bucket, prefix, FOLDER_DELETE_CAP + 1));
    return {
      bucket,
      prefix,
      objects: Math.min(listed.length, FOLDER_DELETE_CAP),
      bytes: listed.slice(0, FOLDER_DELETE_CAP).reduce((sum, item) => sum + (item.size ?? 0), 0),
      truncated: listed.length > FOLDER_DELETE_CAP,
      blocked: await this.writeBlock(policy, prefix, true),
    };
  }

  async createFolder(bucket: string, prefix: string, name: string, actor: string): Promise<{ key: string }> {
    const clean = name.trim();
    if (!clean || clean === "." || clean === ".." || clean.includes("/") || /[\u0000-\u001f]/.test(clean)) {
      throw new T4Error(400, "A folder name cannot be empty or contain a slash.");
    }
    const parent = normalizePrefix(prefix);
    const key = `${parent}${clean}/`;
    const policy = await this.policy(bucket);
    const blocked = await this.writeBlock(policy, key, false);
    if (blocked) throw new T4Error(403, blocked);
    const store = await this.storeForBucket(bucket, "writer");
    const existing = await this.storeCall(() => store.list({ bucket, prefix: key, maxKeys: 1 }));
    if (existing.objects.length > 0) throw new T4Error(409, `A folder named ${clean} already exists here.`);
    await this.storeCall(() => store.putObject(bucket, key, new Uint8Array()));
    await this.db.write((conn) => insertAudit(conn, actor, "folder.create", bucket, { key }, { created: true }));
    await this.indexBucket(bucket, { prefix: key });
    return { key };
  }

  async deleteFolder(bucket: string, prefix: string, confirmation: string, actor: string): Promise<{ deleted: number; failed: number; bytes: number }> {
    const target = normalizePrefix(prefix);
    if (!target) throw new T4Error(400, "Pick a folder. The bucket root cannot be deleted from here.");
    const name = target.slice(0, -1).split("/").at(-1) ?? "";
    if (confirmation !== name) throw new T4Error(400, `Type the folder name ${name} to confirm.`);
    const policy = await this.policy(bucket);
    const blocked = await this.writeBlock(policy, target, true);
    if (blocked) throw new T4Error(403, blocked);
    const store = await this.storeForBucket(bucket, "writer");
    const listed = await this.storeCall(() => listCurrent(store, bucket, target, FOLDER_DELETE_CAP + 1));
    if (listed.length > FOLDER_DELETE_CAP) {
      throw new T4Error(413, `This folder has more than ${FOLDER_DELETE_CAP.toLocaleString("en-US")} objects. Use a plan from Maintenance for a delete this large.`);
    }
    const locked = listed.filter((item) => item.objectLockMode || item.legalHold);
    if (locked.length) throw new T4Error(409, `${locked.length} objects under ${target} are under Object Lock or legal hold. Nothing was deleted.`);
    let deleted = 0;
    let failed = 0;
    let bytes = 0;
    for (let start = 0; start < listed.length; start += 1000) {
      const batch = listed.slice(start, start + 1000);
      // Current objects only: on a versioned bucket this writes delete markers, like a plan does.
      const result = await this.storeCall(() => store.deleteObjects(bucket, batch.map((item) => ({ key: item.key }))));
      deleted += result.deleted.length;
      failed += result.errors.length;
      const done = new Set(result.deleted.map((item) => item.key));
      bytes += batch.filter((item) => done.has(item.key)).reduce((sum, item) => sum + (item.size ?? 0), 0);
    }
    await this.db.write((conn) => insertAudit(conn, actor, "folder.delete", bucket, { prefix: target }, { deleted, failed, bytes }));
    await this.indexBucket(bucket, { prefix: target });
    return { deleted, failed, bytes };
  }

  /** Deletes an empty bucket from the store. Non-empty buckets are refused, never emptied. */
  async deleteStoreBucket(connectionId: string, bucket: string, confirmation: string, actor: string): Promise<void> {
    assertBucketName(bucket);
    if (confirmation !== bucket) throw new T4Error(400, `Type the bucket name ${bucket} to confirm.`);
    const tracked = await this.db.read((conn) => queryOne(conn, "SELECT * FROM buckets WHERE bucket = $bucket", { bucket }));
    if (tracked) {
      // A bucket this app indexes (through any connection) keeps its write toggle and protection.
      const blocked = await this.writeBlock(await this.policy(bucket), "", false);
      if (blocked) throw new T4Error(403, blocked);
    }
    await this.withStore(connectionId, async (store) => {
      const current = await store.list({ bucket, maxKeys: 1 });
      let remaining = current.objects.length + current.commonPrefixes.length;
      if (remaining === 0) {
        try {
          const versions = await store.list({ bucket, maxKeys: 1, versions: true });
          remaining = versions.objects.length;
        } catch {
          /* stores without version listing: rely on DeleteBucket refusing a non-empty bucket */
        }
      }
      if (remaining > 0) {
        throw new T4Error(409, `${bucket} is not empty. Delete its folders and files first; this app never empties a bucket in one step.`);
      }
      await store.deleteBucket(bucket);
    });
    await this.db.write(async (conn) => {
      if (tracked) await purgeBucketIndex(conn, bucket);
      await insertAudit(conn, actor, "bucket.delete", bucket, { connectionId }, { deleted: true });
    });
  }

  private async writeBlock(policy: BucketPolicy, prefix: string, includeChildren: boolean): Promise<string | null> {
    const killed = await this.db.read((conn) => queryOne(conn, "SELECT value FROM settings WHERE key = 'kill_switch'"));
    if (String(killed?.value ?? "") === "true") return "The kill switch is on. All changes to stores are paused.";
    if (!policy.writeEnabled) return `Writes are turned off for ${policy.bucket}. Turn on "Allow plans to change this bucket" in Settings to create or delete folders.`;
    const hit = policy.protectedPrefixes.find(
      (item) => item !== "" && (prefix.startsWith(item) || (includeChildren && item.startsWith(prefix))),
    );
    if (hit) return `${hit} is a protected prefix for ${policy.bucket}. Remove it in Settings first.`;
    return null;
  }

  private async storeCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isT4Error(error)) throw error;
      throw new T4Error(502, connectionError(error));
    }
  }

  async listStoreBuckets(connectionId: string): Promise<string[]> {
    return this.withStore(connectionId, (store) => store.listBuckets());
  }

  async createStoreBucket(connectionId: string, bucket: string): Promise<void> {
    assertBucketName(bucket);
    await this.withStore(connectionId, (store) => store.createBucket(bucket));
  }

  async getStoreBucketPolicy(connectionId: string, bucket: string): Promise<string | null> {
    assertBucketName(bucket);
    return this.withStore(connectionId, (store) => store.getBucketPolicy(bucket));
  }

  async putStoreBucketPolicy(connectionId: string, bucket: string, policy: string): Promise<void> {
    assertBucketName(bucket);
    const document = assertPolicyDocument(policy);
    await this.withStore(connectionId, (store) => store.putBucketPolicy(bucket, document));
  }

  async deleteStoreBucketPolicy(connectionId: string, bucket: string): Promise<void> {
    assertBucketName(bucket);
    await this.withStore(connectionId, (store) => store.deleteBucketPolicy(bucket));
  }

  private async withStore<T>(connectionId: string, run: (store: ObjectStore) => Promise<T>): Promise<T> {
    try {
      return await run(await this.storeForConnection(connectionId));
    } catch (error) {
      if (isT4Error(error)) throw error;
      throw new T4Error(502, connectionError(error));
    }
  }

  async saveBucket(input: BucketInput): Promise<void> {
    await this.db.write((conn) =>
      execute(
        conn,
        `INSERT INTO buckets (bucket, connection_id, index_mode, inventory_uri, write_enabled, protected_prefixes, stale_after_hours)
         VALUES ($bucket, $connection_id, $mode, $inventory, $write_enabled, $protected, $stale)
         ON CONFLICT (bucket) DO UPDATE SET
           connection_id = excluded.connection_id,
           index_mode = excluded.index_mode,
           inventory_uri = excluded.inventory_uri,
           write_enabled = excluded.write_enabled,
           protected_prefixes = excluded.protected_prefixes,
           stale_after_hours = excluded.stale_after_hours`,
        {
          bucket: input.bucket,
          connection_id: input.connectionId,
          mode: input.indexMode ?? "crawl",
          inventory: input.inventoryUri ?? null,
          write_enabled: input.writeEnabled ?? false,
          protected: JSON.stringify(input.protectedPrefixes ?? []),
          stale: input.staleAfterHours ?? 48,
        },
      ),
    );
  }

  async updateBucket(bucket: string, patch: { writeEnabled?: boolean; protectedPrefixes?: string[]; staleAfterHours?: number; indexMode?: string; inventoryUri?: string | null }): Promise<void> {
    const current = await this.getBucketRow(bucket);
    await this.saveBucket({
      bucket,
      connectionId: String(current.connection_id),
      indexMode: (patch.indexMode as "crawl" | "inventory" | undefined) ?? (String(current.index_mode) as "crawl" | "inventory"),
      inventoryUri: patch.inventoryUri === undefined ? asString(current.inventory_uri) : patch.inventoryUri,
      writeEnabled: patch.writeEnabled ?? asBoolean(current.write_enabled),
      protectedPrefixes: patch.protectedPrefixes ?? (JSON.parse(String(current.protected_prefixes || "[]")) as string[]),
      staleAfterHours: patch.staleAfterHours ?? asNumber(current.stale_after_hours),
    });
  }

  async listBuckets(): Promise<Record<string, unknown>[]> {
    const rows = await this.db.read((conn) => queryAll(conn, "SELECT * FROM buckets ORDER BY bucket"));
    return rows.map((row) => this.presentBucket(row));
  }

  async probe(bucket: string): Promise<Capabilities> {
    const store = await this.storeForBucket(bucket, "reader");
    const capabilities = await probeStore(store, bucket);
    await this.db.write((conn) =>
      execute(conn, "UPDATE buckets SET capabilities = $capabilities WHERE bucket = $bucket", {
        capabilities: JSON.stringify(capabilities),
        bucket,
      }),
    );
    return capabilities;
  }

  async estimateIndex(bucket: string, prefix = "", depth = 2): Promise<{ listRequests: number; shards: number }> {
    const store = await this.storeForBucket(bucket, "reader");
    return estimateCrawl(store, bucket, prefix, depth);
  }

  async indexBucket(bucket: string, options?: { prefix?: string; depth?: number }): Promise<{ rows: number; bytes: number; runId: string; listRequests: number }> {
    const store = await this.storeForBucket(bucket, "reader");
    const prefix = options?.prefix ?? "";
    const crawled = await crawlBucket(store, bucket, prefix, options?.depth ?? 2);
    const runId = randomUUID();
    const bytes = crawled.rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
    const swapped = await stageAndSwap(this.db, {
      bucket,
      runId,
      mode: prefix ? "crawl-prefix" : "crawl",
      prefix,
      rows: crawled.rows,
      stagingDir: join(this.options.dataDir, "staging"),
      listRequests: crawled.listRequests,
      expectedRows: crawled.rows.length,
      expectedBytes: bytes,
    });
    return { ...swapped, runId, listRequests: crawled.listRequests };
  }

  async indexInventory(bucket: string, parquetPath: string, expectedRows?: number): Promise<{ rows: number; bytes: number; runId: string }> {
    const runId = randomUUID();
    const swapped = await loadInventoryParquet(this.db, {
      bucket,
      runId,
      parquetPath,
      stagingDir: join(this.options.dataDir, "staging"),
      expectedRows,
    });
    return { ...swapped, runId };
  }

  async browse(bucket: string, prefix = "", cursor = "", limit = 500): Promise<Record<string, unknown>> {
    const meta = await this.getBucketRow(bucket);
    const folders = buildFolderQuery(bucket, prefix);
    const files = buildObjectQuery({ bucket, parentPrefix: prefix, cursor, limit });
    const [folderRows, fileRows, iceberg] = await this.db.read(async (conn) => {
      const folderResult = await queryAll(conn, folders.sql, folders.params);
      const fileResult = await queryAll(conn, files.sql, files.params);
      const tables = await queryAll(conn, "SELECT location FROM iceberg_tables WHERE bucket = $bucket", { bucket });
      return [folderResult, fileResult, tables] as const;
    });
    const locations = new Set(iceberg.map((row) => String(row.location)));
    return {
      prefix,
      folders: folderRows.map((row) => ({
        ...row,
        name: folderName(String(row.prefix)),
        iceberg: locations.has(String(row.prefix)),
      })),
      files: fileRows,
      nextCursor: fileRows.length === limit ? fileRows[fileRows.length - 1]?.key ?? null : null,
      sql: { folders: folders.sql, files: files.sql },
      ...this.indexStatus(meta),
    };
  }

  async tree(bucket: string, prefix = ""): Promise<Record<string, unknown>[]> {
    const query = buildFolderQuery(bucket, prefix);
    return this.db.read((conn) => queryAll(conn, query.sql, query.params));
  }

  async search(filters: SearchFilters): Promise<Record<string, unknown>> {
    const meta = await this.getBucketRow(filters.bucket);
    const built = buildObjectQuery(filters);
    const rows = await this.db.read((conn) => queryAll(conn, built.sql, built.params));
    const limit = filters.limit ?? 500;
    return {
      rows,
      nextCursor: rows.length === limit ? rows[rows.length - 1]?.key ?? null : null,
      sql: built.sql,
      params: built.params,
      ...this.indexStatus(meta),
    };
  }

  async objectDetail(bucket: string, key: string): Promise<Record<string, unknown>> {
    const store = await this.storeForBucket(bucket, "reader");
    const indexed = await this.db.read((conn) =>
      queryAll(conn, "SELECT * FROM objects WHERE bucket = $bucket AND key = $key ORDER BY is_latest DESC", { bucket, key }),
    );
    const latest = indexed.find((row) => row.is_latest === true) ?? indexed[0] ?? null;
    const head = await store.head(bucket, key, asString(latest?.version_id));
    return {
      key,
      index: latest,
      versions: indexed,
      head,
      missing: Boolean(latest) && !head,
    };
  }

  async downloadUrl(bucket: string, key: string, expiresInSeconds = 300): Promise<{ url: string; expiresIn: number }> {
    const store = await this.storeForBucket(bucket, "reader");
    const url = await store.presign(bucket, key, expiresInSeconds);
    return { url, expiresIn: expiresInSeconds };
  }

  async preview(bucket: string, key: string, maxBytes = 32_000_000): Promise<Record<string, unknown>> {
    const format = detectFormat(key);
    if (!format) throw new T4Error(400, "Preview supports Parquet, CSV, JSON, and JSONL files");
    const store = await this.storeForBucket(bucket, "reader");
    const head = await store.head(bucket, key);
    const size = head?.size ?? 0;
    const limit = format === "parquet" ? Math.max(maxBytes, 200_000_000) : maxBytes;
    if (size > limit) throw new T4Error(400, `This ${format} file is ${size} bytes, above the preview limit of ${limit}`);
    const body = await store.getObject(bucket, key);
    const dir = join(this.options.dataDir, "preview");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}-${key.split("/").at(-1)}`);
    writeFileSync(file, body);
    const path = duckPath(file);
    const reader = format === "jsonl" ? "read_json" : format === "json" ? "read_json_auto" : format === "csv" ? "read_csv_auto" : "read_parquet";
    const options = format === "jsonl" ? ", format = 'newline_delimited'" : "";
    return this.db.read(async (conn) => {
      const relation = `${reader}(${sqlLiteral(path)}${options})`;
      const columns = await queryAll(conn, `DESCRIBE SELECT * FROM ${relation}`);
      let rowCount: number | null = null;
      if (format === "parquet") {
        try {
          const meta = await queryOne(conn, `SELECT sum(num_rows) AS rows FROM parquet_file_metadata(${sqlLiteral(path)})`);
          rowCount = asNumber(meta?.rows);
        } catch {
          const count = await queryOne(conn, `SELECT count(*) AS rows FROM ${relation}`);
          rowCount = asNumber(count?.rows);
        }
      }
      const rows = await queryAll(conn, `SELECT * FROM ${relation} LIMIT 100`);
      return { format, columns, rowCount, rows, truncated: rows.length === 100 };
    });
  }

  async query(sql: string, limit = 1000): Promise<{ columns: string[]; rows: Record<string, unknown>[]; sql: string }> {
    return this.db.read(async (conn) => {
      const safe = await assertSafeConsoleSql(conn, sql);
      const capped = capSelect(safe, limit);
      const rows = await queryAll(conn, capped);
      return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, sql: capped };
    });
  }

  async exportQuery(sql: string, format: "csv" | "parquet"): Promise<{ id: string; fileName: string }> {
    const id = randomUUID();
    const fileName = `${id}.${format}`;
    const file = duckPath(join(this.options.dataDir, "exports", fileName));
    mkdirSync(join(this.options.dataDir, "exports"), { recursive: true });
    const safe = await this.db.read((conn) => assertSafeConsoleSql(conn, sql));
    if (safe.kind !== "select") throw new T4Error(400, "Only SELECT queries can be exported");
    await this.db.write((conn) =>
      execute(conn, `COPY (${capSelect(safe, 100_000)}) TO ${sqlLiteral(file)} (FORMAT ${format === "csv" ? "CSV" : "PARQUET"}, HEADER true)`),
    );
    return { id, fileName };
  }

  async saveQuery(name: string, sql: string): Promise<string> {
    const id = randomUUID();
    await this.db.write((conn) =>
      execute(conn, `INSERT INTO saved_queries VALUES ($id, $name, $sql, current_timestamp)`, { id, name, sql }),
    );
    return id;
  }

  async listSavedQueries(): Promise<Record<string, unknown>[]> {
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM saved_queries ORDER BY created_at DESC"));
  }

  async deleteSavedQuery(id: string): Promise<void> {
    await this.db.write((conn) => execute(conn, "DELETE FROM saved_queries WHERE query_id = $id", { id }));
  }

  listAnalyzers(): Array<Record<string, unknown>> {
    return this.analyzers.map((analyzer) => ({
      id: analyzer.id,
      title: analyzer.title,
      summary: analyzer.summary,
      group: analyzer.group,
      action: analyzer.action,
      params: analyzer.params,
    }));
  }

  async runAnalyzers(bucket: string, analyzerId?: string, overrides?: Record<string, unknown>): Promise<{ reclaimableBytes: number; findings: number; runs: Array<{ id: string; findings: number; reclaimableBytes: number }> }> {
    const store = await this.storeForBucket(bucket, "reader");
    const selected = analyzerId ? this.analyzers.filter((analyzer) => analyzer.id === analyzerId) : this.analyzers;
    if (selected.length === 0) throw new T4Error(404, "Analyzer not found");
    const runs = [];
    let reclaimableBytes = 0;
    let findings = 0;
    for (const analyzer of selected) {
      const result = await runAnalyzer(this.db, store, analyzer, bucket, overrides);
      runs.push({ id: analyzer.id, findings: result.findings, reclaimableBytes: result.reclaimableBytes });
      reclaimableBytes += result.reclaimableBytes;
      findings += result.findings;
    }
    await this.notify(bucket, reclaimableBytes);
    return { reclaimableBytes, findings, runs };
  }

  async listFindings(bucket?: string, status?: string): Promise<Record<string, unknown>[]> {
    const where = ["1 = 1"];
    const params: Record<string, DuckDBValue> = {};
    if (bucket) {
      where.push("bucket = $bucket");
      params.bucket = bucket;
    }
    if (status) {
      where.push("status = $status");
      params.status = status;
    }
    return this.db.read((conn) =>
      queryAll(
        conn,
        `SELECT * FROM findings WHERE ${where.join(" AND ")} ORDER BY reclaimable_bytes DESC, created_at ASC, prefix`,
        params,
      ),
    );
  }

  async patchFinding(id: string, status: string): Promise<void> {
    if (!["open", "ignored", "planned", "resolved"].includes(status)) throw new T4Error(400, "Unknown finding status");
    await this.db.write((conn) => execute(conn, "UPDATE findings SET status = $status WHERE finding_id = $id", { status, id }));
  }

  async createPlan(bucket: string, findingIds: string[], actor: string): Promise<string> {
    return createPlan(this.db, this.analyzers, { bucket, findingIds, actor, policy: await this.policy(bucket) });
  }

  dryRun(planId: string, actor: string): Promise<Record<string, unknown>> {
    return dryRunPlan(this.db, planId, actor);
  }

  async approve(planId: string, actor: string, confirmation: string): Promise<void> {
    const plan = await this.getPlan(planId);
    await approvePlan(this.db, planId, actor, confirmation, await this.policy(String(plan.bucket)));
  }

  async execute(planId: string, actor: string): Promise<{ done: number; skipped: number; failed: number }> {
    const plan = await this.getPlan(planId);
    const store = await this.storeForBucket(String(plan.bucket), "writer");
    return executePlan(this.db, store, planId, actor, await this.policy(String(plan.bucket)));
  }

  cancel(planId: string, actor: string): Promise<void> {
    return cancelPlan(this.db, planId, actor);
  }

  async undo(planId: string, actor: string): Promise<number> {
    const plan = await this.getPlan(planId);
    const store = await this.storeForBucket(String(plan.bucket), "writer");
    return undoPlan(this.db, store, planId, actor, await this.policy(String(plan.bucket)));
  }

  async getPlan(planId: string): Promise<Record<string, unknown>> {
    const plan = await this.db.read(async (conn) => {
      const row = await queryOne(conn, "SELECT * FROM action_plans WHERE plan_id = $plan_id", { plan_id: planId });
      if (!row) throw new T4Error(404, "Plan not found");
      const items = await queryAll(conn, "SELECT * FROM action_plan_items WHERE plan_id = $plan_id ORDER BY key LIMIT 200", { plan_id: planId });
      return { ...row, items };
    });
    return plan;
  }

  async listPlans(bucket?: string): Promise<Record<string, unknown>[]> {
    if (!bucket) return this.db.read((conn) => queryAll(conn, "SELECT * FROM action_plans ORDER BY created_at DESC"));
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM action_plans WHERE bucket = $bucket ORDER BY created_at DESC", { bucket }));
  }

  async listTables(bucket: string): Promise<Record<string, unknown>[]> {
    return this.db.read((conn) =>
      queryAll(
        conn,
        `SELECT t.location, t.latest_metadata, t.format_version,
                coalesce(s.objects, 0) AS objects, coalesce(s.bytes, 0) AS bytes, s.newest
         FROM iceberg_tables t
         LEFT JOIN prefix_stats s ON s.bucket = t.bucket AND s.prefix = t.location
         WHERE t.bucket = $bucket
         ORDER BY t.location`,
        { bucket },
      ),
    );
  }

  async metrics(bucket?: string): Promise<Record<string, unknown>[]> {
    if (!bucket) return this.db.read((conn) => queryAll(conn, "SELECT * FROM metrics_daily ORDER BY day, bucket"));
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM metrics_daily WHERE bucket = $bucket ORDER BY day", { bucket }));
  }

  async audit(bucket?: string): Promise<Record<string, unknown>[]> {
    if (!bucket) return this.db.read((conn) => queryAll(conn, "SELECT * FROM audit_log ORDER BY ts DESC LIMIT 500"));
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM audit_log WHERE bucket = $bucket ORDER BY ts DESC LIMIT 500", { bucket }));
  }

  async summary(bucket: string): Promise<Record<string, unknown>> {
    const meta = await this.getBucketRow(bucket);
    const totals = await this.db.read((conn) =>
      queryOne(
        conn,
        `SELECT coalesce(sum(bytes), 0) AS bytes, coalesce(sum(objects), 0) AS objects
         FROM prefix_stats WHERE bucket = $bucket AND prefix = ''`,
        { bucket },
      ),
    );
    const findings = await this.db.read((conn) =>
      queryOne(
        conn,
        `SELECT count(*) AS open_findings, coalesce(sum(reclaimable_bytes), 0) AS reclaimable_bytes
         FROM findings WHERE bucket = $bucket AND status = 'open'`,
        { bucket },
      ),
    );
    return { ...this.presentBucket(meta), totals, findings };
  }

  async startJob(kind: string, bucket: string | null, work: () => Promise<unknown>): Promise<string> {
    const jobId = randomUUID();
    await this.db.write((conn) =>
      execute(
        conn,
        `INSERT INTO jobs (job_id, kind, bucket, status, progress, message, log, created_at, updated_at)
         VALUES ($id, $kind, $bucket, 'running', 0, 'Started', '[]', current_timestamp, current_timestamp)`,
        { id: jobId, kind, bucket },
      ),
    );
    void work()
      .then(async (result) => {
        await this.db.write((conn) =>
          execute(
            conn,
            `UPDATE jobs SET status = 'done', progress = 1, message = 'Done', result = $result, updated_at = current_timestamp WHERE job_id = $id`,
            { id: jobId, result: JSON.stringify(result ?? null) },
          ),
        );
      })
      .catch(async (error: unknown) => {
        await this.db.write((conn) =>
          execute(
            conn,
            `UPDATE jobs SET status = 'failed', error = $error, message = $error, updated_at = current_timestamp WHERE job_id = $id`,
            { id: jobId, error: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
    return jobId;
  }

  async getJob(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.db.read((conn) => queryOne(conn, "SELECT * FROM jobs WHERE job_id = $id", { id: jobId }));
    if (!job) throw new T4Error(404, "Job not found");
    return job;
  }

  async listJobs(): Promise<Record<string, unknown>[]> {
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200"));
  }

  async saveSchedule(input: { bucket?: string | null; kind: string; cron: string; enabled?: boolean; webhookUrl?: string | null; reclaimThreshold?: number | null }): Promise<string> {
    parseCron(input.cron);
    const id = randomUUID();
    await this.db.write((conn) =>
      execute(
        conn,
        `INSERT INTO schedules (schedule_id, bucket, kind, cron, enabled, webhook_url, reclaim_threshold)
         VALUES ($id, $bucket, $kind, $cron, $enabled, $webhook, $threshold)`,
        {
          id,
          bucket: input.bucket ?? null,
          kind: input.kind,
          cron: input.cron,
          enabled: input.enabled ?? true,
          webhook: input.webhookUrl ?? null,
          threshold: input.reclaimThreshold ?? null,
        },
      ),
    );
    return id;
  }

  async listSchedules(): Promise<Record<string, unknown>[]> {
    return this.db.read((conn) => queryAll(conn, "SELECT * FROM schedules ORDER BY cron"));
  }

  async dueSchedules(now = new Date()): Promise<Record<string, unknown>[]> {
    const rows = await this.listSchedules();
    return rows.filter((row) => row.enabled === true && cronMatches(String(row.cron), now));
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.write((conn) =>
      execute(
        conn,
        `INSERT INTO settings (key, value) VALUES ($key, $value)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        { key, value },
      ),
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.read((conn) => queryOne(conn, "SELECT value FROM settings WHERE key = $key", { key }));
    return asString(row?.value);
  }

  async ensureBootstrap(env: NodeJS.ProcessEnv): Promise<void> {
    const endpoint = env.T4_S3_ENDPOINT;
    const bucketName = env.T4_S3_BUCKET;
    if (!endpoint || !bucketName) return;
    const existing = await this.listConnections();
    const name = env.T4_S3_NAME || "default";
    const found = existing.find((row) => row.name === name);
    const connectionId = found ? String(found.connection_id) : await this.saveConnection({
      name,
      endpoint,
      region: env.T4_S3_REGION || "us-east-1",
      urlStyle: env.T4_S3_URL_STYLE === "virtual" ? "virtual" : "path",
      useSsl: env.T4_S3_USE_SSL !== "false",
      tlsVerify: env.T4_S3_TLS_VERIFY !== "false",
      caBundlePath: env.T4_S3_CA_BUNDLE || null,
      providerHint: env.T4_S3_PROVIDER || "other",
      accessKeyId: env.T4_S3_ACCESS_KEY_ID,
      secretAccessKey: env.T4_S3_SECRET_ACCESS_KEY,
      requestRatePerSec: env.T4_S3_RATE ? Number(env.T4_S3_RATE) : null,
    });
    if (found) {
      await this.saveConnection({
        name,
        endpoint,
        region: env.T4_S3_REGION || "us-east-1",
        urlStyle: env.T4_S3_URL_STYLE === "virtual" ? "virtual" : "path",
        useSsl: env.T4_S3_USE_SSL !== "false",
        tlsVerify: env.T4_S3_TLS_VERIFY !== "false",
        caBundlePath: env.T4_S3_CA_BUNDLE || null,
        providerHint: env.T4_S3_PROVIDER || "other",
        accessKeyId: env.T4_S3_ACCESS_KEY_ID,
        secretAccessKey: env.T4_S3_SECRET_ACCESS_KEY,
        requestRatePerSec: env.T4_S3_RATE ? Number(env.T4_S3_RATE) : null,
      }, connectionId);
    }
    const buckets = await this.db.read((conn) => queryAll(conn, "SELECT bucket FROM buckets WHERE bucket = $bucket", { bucket: bucketName }));
    if (buckets.length === 0) {
      await this.saveBucket({ bucket: bucketName, connectionId, indexMode: "crawl" });
    }
  }

  private async notify(bucket: string, reclaimableBytes: number): Promise<void> {
    if (!this.options.webhook || reclaimableBytes <= 0) return;
    const schedules = await this.listSchedules();
    for (const schedule of schedules) {
      if (schedule.bucket !== bucket || !schedule.webhook_url) continue;
      const threshold = asNumber(schedule.reclaim_threshold);
      if (reclaimableBytes >= threshold) {
        await this.options.webhook(String(schedule.webhook_url), { bucket, reclaimableBytes });
      }
    }
  }

  private async policy(bucket: string): Promise<BucketPolicy> {
    const row = await this.getBucketRow(bucket);
    return {
      bucket,
      writeEnabled: asBoolean(row.write_enabled),
      protectedPrefixes: JSON.parse(String(row.protected_prefixes || "[]")) as string[],
      planSizeCap: asNumber(row.plan_size_cap) || 1_000_000,
      confirmMin: asNumber(row.plan_confirm_min_objects) || 100,
    };
  }

  private async getBucketRow(bucket: string): Promise<Record<string, unknown>> {
    const row = await this.db.read((conn) => queryOne(conn, "SELECT * FROM buckets WHERE bucket = $bucket", { bucket }));
    if (!row) throw new T4Error(404, `Bucket ${bucket} is not registered`);
    return row;
  }

  private presentBucket(row: Record<string, unknown>): Record<string, unknown> {
    return {
      ...row,
      protected_prefixes: JSON.parse(String(row.protected_prefixes || "[]")),
      capabilities: row.capabilities ? parseJson(row.capabilities) : null,
      ...this.indexStatus(row),
    };
  }

  private indexStatus(row: Record<string, unknown>): { indexAgeSeconds: number | null; stale: boolean; indexedAt: unknown } {
    const indexedAt = row.last_indexed_at;
    if (!indexedAt) return { indexAgeSeconds: null, stale: true, indexedAt: null };
    const age = Math.max(0, Math.round((Date.now() - Date.parse(String(indexedAt))) / 1000));
    const staleAfter = (asNumber(row.stale_after_hours) || 48) * 3600;
    return { indexAgeSeconds: age, stale: age > staleAfter, indexedAt };
  }

  private async getConnection(connectionId: string): Promise<Record<string, unknown>> {
    const connection = await this.db.read((conn) =>
      queryOne(conn, "SELECT * FROM connections WHERE connection_id = $id", { id: connectionId }),
    );
    if (!connection) throw new T4Error(404, "Connection not found");
    return connection;
  }

  private async storeForConnection(connectionId: string, role: "reader" | "writer" = "reader"): Promise<ObjectStore> {
    const connection = await this.getConnection(connectionId);
    if (this.options.storeFor) return this.options.storeFor(connection, role);
    const ref = String(role === "writer" && connection.writer_secret_ref ? connection.writer_secret_ref : connection.reader_secret_ref);
    const settings: S3ConnectionSettings = {
      endpoint: normalizeEndpoint(String(connection.endpoint), asBoolean(connection.use_ssl)),
      region: String(connection.region || "us-east-1"),
      urlStyle: connection.url_style === "virtual" ? "virtual" : "path",
      useSsl: asBoolean(connection.use_ssl),
      tlsVerify: asBoolean(connection.tls_verify),
      caBundlePath: asString(connection.ca_bundle_path),
      requestRatePerSec: connection.request_rate_per_sec == null ? null : asNumber(connection.request_rate_per_sec),
    };
    return new S3ObjectStore(settings, this.secrets.get(ref));
  }

  private async storeForBucket(bucket: string, role: "reader" | "writer"): Promise<ObjectStore> {
    const row = await this.getBucketRow(bucket);
    return this.storeForConnection(String(row.connection_id), role);
  }
}

export function detectFormat(key: string): "parquet" | "csv" | "json" | "jsonl" | null {
  const lower = key.toLowerCase();
  if (lower.endsWith(".parquet")) return "parquet";
  if (lower.endsWith(".csv") || lower.endsWith(".csv.gz") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson") || lower.endsWith(".jsonl.gz")) return "jsonl";
  if (lower.endsWith(".json") || lower.endsWith(".json.gz")) return "json";
  return null;
}

export function analyzerDefaults(analyzer: Analyzer): Record<string, unknown> {
  return analyzerParams(analyzer);
}

/** Folder deletes from Browse stop here; anything bigger goes through a reviewed plan. */
const FOLDER_DELETE_CAP = 100_000;

async function listCurrent(store: ObjectStore, bucket: string, prefix: string, limit: number): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  let token: string | null = null;
  do {
    const page: ListPage = await store.list({ bucket, prefix, token, maxKeys: 1000 });
    out.push(...page.objects.filter((item) => !item.isDeleteMarker));
    token = page.nextToken;
  } while (token && out.length < limit);
  return out;
}

function normalizePrefix(prefix: string): string {
  const clean = prefix.replace(/^\/+/, "");
  if (!clean) return "";
  return clean.endsWith("/") ? clean : `${clean}/`;
}

async function purgeBucketIndex(conn: DuckDBConnection, bucket: string): Promise<void> {
  for (const table of ["objects", "prefix_stats", "multipart_uploads", "lifecycle_rules", "iceberg_tables", "iceberg_files", "buckets"]) {
    await execute(conn, `DELETE FROM ${table} WHERE bucket = $bucket`, { bucket });
  }
  await execute(conn, "DELETE FROM findings WHERE bucket = $bucket AND status = 'open'", { bucket });
}

async function insertAudit(conn: DuckDBConnection, actor: string, action: string, bucket: string | null, params: unknown, result: unknown): Promise<void> {
  await execute(
    conn,
    `INSERT INTO audit_log (id, ts, actor, action, bucket, params, result)
     VALUES ($id, current_timestamp, $actor, $action, $bucket, $params, $result)`,
    { id: randomUUID(), actor, action, bucket, params: JSON.stringify(params), result: JSON.stringify(result) },
  );
}

function assertBucketName(name: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) || name.includes("..")) {
    throw new T4Error(400, "Bucket names are 3 to 63 characters: lowercase letters, numbers, dots, and hyphens.");
  }
}

function assertPolicyDocument(policy: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(policy);
  } catch {
    throw new T4Error(400, "Policy must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new T4Error(400, "Policy must be a JSON object.");
  }
  return JSON.stringify(parsed);
}
