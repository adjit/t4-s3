import type { DuckDBValue } from "@duckdb/node-api";

export interface SearchFilters {
  bucket: string;
  name?: string;
  nameMode?: "substring" | "glob" | "regex";
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
  storageClass?: string;
  ext?: string;
  versionState?: "current" | "noncurrent" | "delete_marker" | "all";
  prefix?: string;
  parentPrefix?: string;
  cursor?: string;
  limit?: number;
}

export interface BuiltQuery {
  sql: string;
  params: Record<string, DuckDBValue>;
}

export function buildObjectQuery(filters: SearchFilters): BuiltQuery {
  const where = ["bucket = $bucket"];
  const params: Record<string, DuckDBValue> = {
    bucket: filters.bucket,
    cursor: filters.cursor ?? "",
    limit: filters.limit ?? 500,
  };
  const state = filters.versionState ?? "current";
  if (state === "current") where.push("is_latest AND NOT is_delete_marker");
  else if (state === "noncurrent") where.push("NOT is_latest AND NOT is_delete_marker");
  else if (state === "delete_marker") where.push("is_delete_marker");
  if (filters.parentPrefix !== undefined) {
    where.push("parent_prefix = $parent_prefix");
    params.parent_prefix = filters.parentPrefix;
  }
  if (filters.prefix) {
    where.push("starts_with(key, $prefix)");
    params.prefix = filters.prefix;
  }
  if (filters.name) {
    if (filters.nameMode === "regex") {
      where.push("regexp_matches(key, $name)");
      params.name = filters.name;
    } else if (filters.nameMode === "glob") {
      where.push("key LIKE $name ESCAPE '\\'");
      params.name = globToLike(filters.name);
    } else {
      where.push("key ILIKE $name ESCAPE '\\'");
      params.name = `%${escapeLike(filters.name)}%`;
    }
  }
  if (filters.minSize != null) {
    where.push("size >= $min_size");
    params.min_size = filters.minSize;
  }
  if (filters.maxSize != null) {
    where.push("size <= $max_size");
    params.max_size = filters.maxSize;
  }
  if (filters.modifiedAfter) {
    where.push("last_modified >= CAST($modified_after AS TIMESTAMP)");
    params.modified_after = filters.modifiedAfter;
  }
  if (filters.modifiedBefore) {
    where.push("last_modified < CAST($modified_before AS TIMESTAMP)");
    params.modified_before = filters.modifiedBefore;
  }
  if (filters.storageClass) {
    where.push("storage_class = $storage_class");
    params.storage_class = filters.storageClass;
  }
  if (filters.ext) {
    where.push("ext = $ext");
    params.ext = filters.ext.toLowerCase();
  }
  where.push("key > $cursor");
  const sql = `SELECT key, name, size, last_modified, storage_class, ext, etag, version_id, is_latest, is_delete_marker, encryption, parent_prefix
    FROM objects
    WHERE ${where.join(" AND ")}
    ORDER BY key
    LIMIT $limit`;
  return { sql, params };
}

export function buildFolderQuery(bucket: string, prefix: string): BuiltQuery {
  return {
    sql: `SELECT prefix, objects, bytes, noncurrent_objects, noncurrent_bytes, oldest, newest
      FROM prefix_stats
      WHERE bucket = $bucket AND parent_prefix = $prefix AND prefix <> $prefix
      ORDER BY prefix`,
    params: { bucket, prefix },
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function globToLike(glob: string): string {
  let out = "";
  for (const char of glob) {
    if (char === "*") out += "%";
    else if (char === "?") out += "_";
    else if (char === "%" || char === "_" || char === "\\") out += `\\${char}`;
    else out += char;
  }
  return out;
}
