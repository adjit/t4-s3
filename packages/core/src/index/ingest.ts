import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { Database, duckPath, execute, queryAll, queryOne, sqlLiteral } from "../duck/database.js";
import { T4Error } from "../errors.js";
import { asNumber } from "../plain.js";
import type { RawObject } from "./crawl.js";

export async function stageAndSwap(
  db: Database,
  input: {
    bucket: string;
    runId: string;
    mode: string;
    prefix: string;
    rows: RawObject[];
    stagingDir: string;
    sourceManifest?: string | null;
    listRequests?: number;
    expectedRows?: number;
    expectedBytes?: number;
  },
): Promise<{ rows: number; bytes: number }> {
  const safe = safeId(input.runId);
  mkdirSync(input.stagingDir, { recursive: true });
  const parquet = duckPath(join(input.stagingDir, `${safe}.parquet`));
  try {
    return await db.write(async (conn) => {
      await execute(
        conn,
        `INSERT INTO index_runs (run_id, bucket, mode, source_manifest, started_at, status, list_requests)
         VALUES ($run_id, $bucket, $mode, $source, current_timestamp, 'running', $lists)`,
        {
          run_id: input.runId,
          bucket: input.bucket,
          mode: input.mode,
          source: input.sourceManifest ?? null,
          lists: input.listRequests ?? 0,
        },
      );
      if (input.rows.length > 0) {
        await execute(conn, "DELETE FROM ingest_batch");
        for (const row of input.rows) {
          await execute(
            conn,
            `INSERT INTO ingest_batch VALUES (
              $bucket, $key, $version_id, $is_latest, $is_delete_marker, $size,
              CAST($last_modified AS TIMESTAMP), $etag, $storage_class, $is_multipart,
              $checksum_algo, $encryption, $replication, $it_access_tier, $object_lock_mode
            )`,
            rawParams(row),
          );
        }
        await execute(conn, `COPY ingest_batch TO ${sqlLiteral(parquet)} (FORMAT PARQUET)`);
        await execute(conn, "DELETE FROM ingest_batch");
      }
      const stage = `objects_stage_${safe}`;
      await execute(conn, `DROP TABLE IF EXISTS ${stage}`);
      if (input.rows.length === 0) {
        await execute(conn, `CREATE TABLE ${stage} AS SELECT * FROM objects WHERE false`);
      } else {
        await execute(conn, derivedSelect(stage, parquet, input.runId));
      }
      const stats = await queryOne(
        conn,
        `SELECT count(*) AS rows, coalesce(sum(size), 0) AS bytes, count(*) FILTER (WHERE key IS NULL OR key = '') AS null_keys FROM ${stage}`,
      );
      const rows = asNumber(stats?.rows);
      const bytes = asNumber(stats?.bytes);
      const nullKeys = asNumber(stats?.null_keys);
      if (nullKeys > 0) throw new T4Error(422, "Index stage contained null keys");
      if (input.expectedRows != null && rows !== input.expectedRows) {
        throw new T4Error(422, `Index row count ${rows} did not match the listing ${input.expectedRows}`);
      }
      if (input.expectedBytes != null && bytes !== input.expectedBytes) {
        throw new T4Error(422, `Index bytes ${bytes} did not match the listing ${input.expectedBytes}`);
      }
      await execute(conn, "BEGIN TRANSACTION");
      try {
        if (input.prefix) {
          await execute(conn, "DELETE FROM objects WHERE bucket = $bucket AND starts_with(key, $prefix)", {
            bucket: input.bucket,
            prefix: input.prefix,
          });
        } else {
          await execute(conn, "DELETE FROM objects WHERE bucket = $bucket", { bucket: input.bucket });
        }
        await execute(conn, `INSERT INTO objects SELECT * FROM ${stage} ORDER BY bucket, key`);
        await rebuildPrefixStats(conn, input.bucket);
        await discoverIceberg(conn, input.bucket);
        await refreshMetrics(conn, input.bucket);
        await execute(
          conn,
          `UPDATE index_runs
           SET status = 'done', finished_at = current_timestamp, rows = $rows, bytes = $bytes
           WHERE run_id = $run_id`,
          { rows, bytes, run_id: input.runId },
        );
        await execute(
          conn,
          `UPDATE buckets SET last_indexed_at = current_timestamp, last_run_id = $run_id WHERE bucket = $bucket`,
          { run_id: input.runId, bucket: input.bucket },
        );
        await execute(conn, "COMMIT");
      } catch (error) {
        await execute(conn, "ROLLBACK");
        throw error;
      }
      await execute(conn, `DROP TABLE IF EXISTS ${stage}`);
      return { rows, bytes };
    });
  } catch (error) {
    await db.write(async (conn) => {
      await execute(
        conn,
        `UPDATE index_runs SET status = 'failed', finished_at = current_timestamp, error = $error WHERE run_id = $run_id AND status = 'running'`,
        { error: error instanceof Error ? error.message : String(error), run_id: input.runId },
      );
    }).catch(() => undefined);
    throw error;
  } finally {
    rmSync(parquet, { force: true });
  }
}

export async function loadInventoryParquet(
  db: Database,
  input: {
    bucket: string;
    runId: string;
    parquetPath: string;
    stagingDir: string;
    sourceManifest?: string | null;
    expectedRows?: number;
  },
): Promise<{ rows: number; bytes: number }> {
  const safe = safeId(input.runId);
  const source = duckPath(input.parquetPath);
  return db.write(async (conn) => {
    await execute(
      conn,
      `INSERT INTO index_runs (run_id, bucket, mode, source_manifest, started_at, status, list_requests)
       VALUES ($run_id, $bucket, 'inventory', $source, current_timestamp, 'running', 0)`,
      { run_id: input.runId, bucket: input.bucket, source: input.sourceManifest ?? source },
    );
    const described = await queryAll(conn, `DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(source)})`);
    const columns = new Set(described.map((row) => String(row.column_name ?? row.columnName ?? "")));
    const stage = `objects_stage_${safe}`;
    await execute(conn, `DROP TABLE IF EXISTS ${stage}`);
    await execute(conn, inventorySelect(stage, source, input.runId, input.bucket, columns));
    const stats = await queryOne(conn, `SELECT count(*) AS rows, coalesce(sum(size), 0) AS bytes FROM ${stage}`);
    const rows = asNumber(stats?.rows);
    const bytes = asNumber(stats?.bytes);
    if (input.expectedRows != null && rows !== input.expectedRows) {
      throw new T4Error(422, `Inventory row count ${rows} did not match the manifest ${input.expectedRows}`);
    }
    await execute(conn, "BEGIN TRANSACTION");
    try {
      await execute(conn, "DELETE FROM objects WHERE bucket = $bucket", { bucket: input.bucket });
      await execute(conn, `INSERT INTO objects SELECT * FROM ${stage} ORDER BY bucket, key`);
      await rebuildPrefixStats(conn, input.bucket);
      await discoverIceberg(conn, input.bucket);
      await refreshMetrics(conn, input.bucket);
      await execute(
        conn,
        `UPDATE index_runs SET status = 'done', finished_at = current_timestamp, rows = $rows, bytes = $bytes WHERE run_id = $run_id`,
        { rows, bytes, run_id: input.runId },
      );
      await execute(
        conn,
        `UPDATE buckets SET last_indexed_at = current_timestamp, last_run_id = $run_id, index_mode = 'inventory' WHERE bucket = $bucket`,
        { run_id: input.runId, bucket: input.bucket },
      );
      await execute(conn, "COMMIT");
    } catch (error) {
      await execute(conn, "ROLLBACK");
      throw error;
    }
    await execute(conn, `DROP TABLE IF EXISTS ${stage}`);
    return { rows, bytes };
  });
}

function derivedSelect(stage: string, parquet: string, runId: string): string {
  return `CREATE TABLE ${stage} AS
    SELECT
      bucket,
      key,
      version_id,
      COALESCE(is_latest, true) AS is_latest,
      COALESCE(is_delete_marker, false) AS is_delete_marker,
      size,
      last_modified,
      etag,
      storage_class,
      is_multipart,
      checksum_algo,
      encryption,
      replication,
      it_access_tier,
      object_lock_mode,
      regexp_replace(key, '[^/]*$', '') AS parent_prefix,
      regexp_extract(key, '[^/]*$') AS name,
      NULLIF(lower(regexp_extract(key, '\\.([^.]+)$', 1)), '') AS ext,
      CAST(length(regexp_replace(key, '[^/]*$', '')) - length(replace(regexp_replace(key, '[^/]*$', ''), '/', '')) AS SMALLINT) AS depth,
      ${sqlLiteral(runId)} AS run_id
    FROM read_parquet(${sqlLiteral(parquet)})
    WHERE key IS NOT NULL AND key <> ''
    ORDER BY bucket, key`;
}

function inventorySelect(
  stage: string,
  parquet: string,
  runId: string,
  bucket: string,
  columns: Set<string>,
): string {
  const pick = (names: string[], fallback: string) => {
    const found = names.find((name) => columns.has(name));
    return found ? `"${found}"` : fallback;
  };
  const bucketExpr = columns.has("bucket") ? `"bucket"` : sqlLiteral(bucket);
  return `CREATE TABLE ${stage} AS
    SELECT
      ${bucketExpr} AS bucket,
      ${pick(["key"], "NULL")} AS key,
      ${pick(["version_id", "versionid"], "NULL")} AS version_id,
      COALESCE(${pick(["is_latest", "islatest"], "true")}, true) AS is_latest,
      COALESCE(${pick(["is_delete_marker", "isdeletemarker"], "false")}, false) AS is_delete_marker,
      CAST(${pick(["size"], "NULL")} AS BIGINT) AS size,
      CAST(${pick(["last_modified", "last_modified_date"], "NULL")} AS TIMESTAMP) AS last_modified,
      CAST(${pick(["etag", "e_tag"], "NULL")} AS VARCHAR) AS etag,
      CAST(${pick(["storage_class"], "NULL")} AS VARCHAR) AS storage_class,
      CAST(${pick(["is_multipart", "is_multipart_uploaded"], "NULL")} AS BOOLEAN) AS is_multipart,
      CAST(${pick(["checksum_algo", "checksum_algorithm"], "NULL")} AS VARCHAR) AS checksum_algo,
      CAST(${pick(["encryption", "encryption_status"], "NULL")} AS VARCHAR) AS encryption,
      CAST(${pick(["replication", "replication_status"], "NULL")} AS VARCHAR) AS replication,
      CAST(${pick(["it_access_tier", "intelligent_tiering_access_tier"], "NULL")} AS VARCHAR) AS it_access_tier,
      CAST(${pick(["object_lock_mode"], "NULL")} AS VARCHAR) AS object_lock_mode,
      regexp_replace(CAST(${pick(["key"], "''")} AS VARCHAR), '[^/]*$', '') AS parent_prefix,
      regexp_extract(CAST(${pick(["key"], "''")} AS VARCHAR), '[^/]*$') AS name,
      NULLIF(lower(regexp_extract(CAST(${pick(["key"], "''")} AS VARCHAR), '\\.([^.]+)$', 1)), '') AS ext,
      CAST(length(regexp_replace(CAST(${pick(["key"], "''")} AS VARCHAR), '[^/]*$', '')) - length(replace(regexp_replace(CAST(${pick(["key"], "''")} AS VARCHAR), '[^/]*$', ''), '/', '')) AS SMALLINT) AS depth,
      ${sqlLiteral(runId)} AS run_id
    FROM read_parquet(${sqlLiteral(parquet)})
    WHERE ${pick(["key"], "NULL")} IS NOT NULL
    ORDER BY 1, 2`;
}

export async function rebuildPrefixStats(conn: DuckDBConnection, bucket: string): Promise<void> {
  await execute(conn, "DELETE FROM prefix_stats WHERE bucket = $bucket", { bucket });
  await execute(
    conn,
    `INSERT INTO prefix_stats
     WITH RECURSIVE chain AS (
       SELECT bucket, key, size, last_modified, is_latest, is_delete_marker,
              regexp_replace(key, '[^/]*$', '') AS prefix
       FROM objects
       WHERE bucket = $bucket
       UNION ALL
       SELECT bucket, key, size, last_modified, is_latest, is_delete_marker,
              regexp_replace(prefix, '[^/]+/*$', '') AS prefix
       FROM chain
       WHERE prefix <> ''
         AND length(regexp_replace(prefix, '[^/]+/*$', '')) < length(prefix)
     )
     SELECT
       bucket,
       prefix,
       CASE WHEN prefix = '' THEN '' ELSE regexp_replace(prefix, '[^/]+/*$', '') END AS parent_prefix,
       CAST(length(prefix) - length(replace(prefix, '/', '')) AS SMALLINT) AS depth,
       count(*) FILTER (WHERE is_latest AND NOT is_delete_marker) AS objects,
       coalesce(sum(size) FILTER (WHERE is_latest AND NOT is_delete_marker), 0) AS bytes,
       count(*) FILTER (WHERE NOT is_latest OR is_delete_marker) AS noncurrent_objects,
       coalesce(sum(size) FILTER (WHERE NOT is_latest AND NOT is_delete_marker), 0) AS noncurrent_bytes,
       min(last_modified) FILTER (WHERE is_latest AND NOT is_delete_marker) AS oldest,
       max(last_modified) FILTER (WHERE is_latest AND NOT is_delete_marker) AS newest
     FROM chain
     GROUP BY bucket, prefix`,
    { bucket },
  );
}

async function discoverIceberg(conn: DuckDBConnection, bucket: string): Promise<void> {
  await execute(conn, "DELETE FROM iceberg_tables WHERE bucket = $bucket", { bucket });
  await execute(
    conn,
    `INSERT INTO iceberg_tables (bucket, location, latest_metadata, format_version)
     SELECT bucket,
            regexp_replace(key, 'metadata/[^/]*\\.metadata\\.json$', '') AS location,
            key,
            TRY_CAST(regexp_extract(key, 'v([0-9]+)\\.metadata\\.json$', 1) AS INTEGER)
     FROM objects
     WHERE bucket = $bucket
       AND is_latest
       AND NOT is_delete_marker
       AND regexp_matches(key, 'metadata/[^/]+\\.metadata\\.json$')`,
    { bucket },
  );
}

async function refreshMetrics(conn: DuckDBConnection, bucket: string): Promise<void> {
  await execute(conn, "DELETE FROM metrics_daily WHERE bucket = $bucket AND day = current_date", { bucket });
  await execute(
    conn,
    `INSERT INTO metrics_daily
     SELECT current_date, bucket, coalesce(storage_class, 'STANDARD'), count(*), coalesce(sum(size), 0)
     FROM objects
     WHERE bucket = $bucket AND is_latest AND NOT is_delete_marker
     GROUP BY 1, 2, 3`,
    { bucket },
  );
}

function rawParams(row: RawObject): Record<string, DuckDBValue> {
  return {
    bucket: row.bucket,
    key: row.key,
    version_id: row.versionId,
    is_latest: row.isLatest,
    is_delete_marker: row.isDeleteMarker,
    size: row.size,
    last_modified: row.lastModified,
    etag: row.etag,
    storage_class: row.storageClass,
    is_multipart: row.isMultipart,
    checksum_algo: row.checksumAlgo,
    encryption: row.encryption,
    replication: row.replication,
    it_access_tier: row.itAccessTier,
    object_lock_mode: row.objectLockMode,
  };
}

function safeId(id: string): string {
  const safe = id.replaceAll("-", "");
  if (!/^[a-f0-9]+$/i.test(safe)) throw new T4Error(400, "Run id is not safe to use as a table name");
  return safe;
}
