import type { DuckDBConnection } from "@duckdb/node-api";
import { T4Error } from "../errors.js";

const SELECT_TYPE = 1;
const EXPLAIN_TYPE = 4;
const ALLOWED_START = /^(select|with|describe|explain|summarize)\b/i;
const FORBIDDEN_CALL =
  /\b(read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_json_objects|read_json_objects_auto|read_ndjson|read_ndjson_auto|read_text|read_blob|glob|parquet_scan|parquet_metadata|parquet_file_metadata|parquet_schema|iceberg_scan|iceberg_metadata|iceberg_snapshots|query_table)\s*\(/i;
const FROM_PATH = /\bfrom\s+['"]/i;

export interface SafeSql {
  sql: string;
  kind: "select" | "explain" | "describe";
}

export function stripSqlComments(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      out += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      out += char;
      index += 1;
      while (index < sql.length) {
        out += sql[index]!;
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out += sql[index + 1]!;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export async function assertSafeConsoleSql(conn: DuckDBConnection, sql: string): Promise<SafeSql> {
  const stripped = stripSqlComments(sql).trim().replace(/;+\s*$/u, "").trim();
  if (!stripped) throw new T4Error(400, "SQL is empty");
  if (!ALLOWED_START.test(stripped)) {
    throw new T4Error(400, "Only a single SELECT, DESCRIBE, EXPLAIN, or SUMMARIZE statement is allowed");
  }
  if (FORBIDDEN_CALL.test(stripped) || FROM_PATH.test(stripped)) {
    throw new T4Error(400, "Console queries cannot read local files or external data sources");
  }
  const extracted = await conn.extractStatements(stripped);
  if (extracted.count !== 1) throw new T4Error(400, "Exactly one statement is allowed");
  let statementType = 0;
  try {
    const prepared = await extracted.prepare(0);
    statementType = prepared.statementType;
  } catch (error) {
    throw new T4Error(400, error instanceof Error ? error.message : "SQL was rejected");
  }
  if (statementType !== SELECT_TYPE && statementType !== EXPLAIN_TYPE) {
    throw new T4Error(400, "Only SELECT and EXPLAIN statements are allowed");
  }
  const kind = statementType === EXPLAIN_TYPE ? "explain" : /^(describe|summarize)\b/i.test(stripped) ? "describe" : "select";
  return { sql: stripped, kind };
}

export function capSelect(safe: SafeSql, limit: number): string {
  const bounded = Math.max(1, Math.min(100_000, Math.floor(limit)));
  if (safe.kind !== "select") return safe.sql;
  return `SELECT * FROM (${safe.sql}) AS t4_q LIMIT ${bounded}`;
}
