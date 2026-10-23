import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { DuckDBValue } from "@duckdb/node-api";
import { parse } from "yaml";
import { execute, queryAll, type Database } from "../duck/database.js";
import { asNumber, parseJson } from "../plain.js";
import type { ObjectStore } from "../store/types.js";

export type AnalyzerAction = "delete" | "abort_multipart" | "tag" | "report";

export interface AnalyzerParam {
  type?: string;
  default?: number | string;
}

export interface Analyzer {
  id: string;
  title: string;
  summary: string;
  group: string;
  severity: string;
  action: AnalyzerAction;
  prepare?: string;
  params: Record<string, AnalyzerParam>;
  findSql: string;
  itemsSql: string | null;
  directory: string;
}

export function defaultAnalyzersDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../analyzers");
}

export function loadAnalyzers(directory = defaultAnalyzersDir()): Analyzer[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadAnalyzer(join(directory, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadAnalyzer(directory: string): Analyzer {
  const manifest = parse(readFileSync(join(directory, "manifest.yaml"), "utf8")) as Analyzer;
  const itemsPath = join(directory, "items.sql");
  return {
    ...manifest,
    params: manifest.params ?? {},
    findSql: readFileSync(join(directory, "find.sql"), "utf8"),
    itemsSql: existsSync(itemsPath) ? readFileSync(itemsPath, "utf8") : null,
    directory,
  };
}

export function analyzerParams(analyzer: Analyzer, overrides?: Record<string, unknown>): Record<string, DuckDBValue> {
  const params: Record<string, DuckDBValue> = {};
  for (const [key, spec] of Object.entries(analyzer.params)) {
    const override = overrides?.[key];
    if (typeof override === "number" || typeof override === "string" || typeof override === "boolean") {
      params[key] = override;
    } else if (typeof spec?.default === "number" || typeof spec?.default === "string") {
      params[key] = spec.default;
    }
  }
  return params;
}

export async function runAnalyzer(
  db: Database,
  store: ObjectStore,
  analyzer: Analyzer,
  bucket: string,
  overrides?: Record<string, unknown>,
): Promise<{ runId: string; findings: number; reclaimableBytes: number }> {
  if (analyzer.prepare === "multipart") await replaceMultipart(db, store, bucket);
  if (analyzer.prepare === "lifecycle") await replaceLifecycle(db, store, bucket);
  const runId = randomUUID();
  const params = { bucket, ...analyzerParams(analyzer, overrides) };
  return db.write(async (conn) => {
    const found = await queryAll(conn, analyzer.findSql, params);
    const ignored = new Set(
      (await queryAll(
        conn,
        `SELECT prefix FROM findings WHERE bucket = $bucket AND analyzer = $analyzer AND status = 'ignored'`,
        { bucket, analyzer: analyzer.id },
      )).map((row) => String(row.prefix ?? "")),
    );
    await execute(
      conn,
      `DELETE FROM findings WHERE bucket = $bucket AND analyzer = $analyzer AND status = 'open'`,
      { bucket, analyzer: analyzer.id },
    );
    let findings = 0;
    let reclaimableBytes = 0;
    for (const row of found) {
      const prefix = String(row.prefix ?? "");
      if (ignored.has(prefix)) continue;
      const bytes = asNumber(row.reclaimable_bytes);
      const details = parseJson(row.details);
      details.params = overrides ?? {};
      await execute(
        conn,
        `INSERT INTO findings
         (finding_id, run_id, analyzer, bucket, prefix, severity, reclaimable_bytes, details, status, created_at)
         VALUES ($id, $run_id, $analyzer, $bucket, $prefix, $severity, $bytes, $details, 'open', CAST($created AS TIMESTAMP))`,
        {
          id: randomUUID(),
          run_id: runId,
          analyzer: analyzer.id,
          bucket,
          prefix,
          severity: String(row.severity ?? analyzer.severity),
          bytes,
          details: JSON.stringify(details),
          created: new Date(Date.now() + findings).toISOString().slice(0, 23).replace("T", " "),
        },
      );
      findings += 1;
      reclaimableBytes += bytes;
    }
    return { runId, findings, reclaimableBytes };
  });
}

async function replaceMultipart(db: Database, store: ObjectStore, bucket: string): Promise<void> {
  const uploads = await store.listMultipart(bucket);
  await db.write(async (conn) => {
    await execute(conn, "DELETE FROM multipart_uploads WHERE bucket = $bucket", { bucket });
    for (const upload of uploads) {
      await execute(
        conn,
        `INSERT INTO multipart_uploads VALUES ($bucket, $key, $upload_id, CAST($initiated AS TIMESTAMP), $parts)`,
        {
          bucket,
          key: upload.key,
          upload_id: upload.uploadId,
          initiated: upload.initiated ? upload.initiated.toISOString().slice(0, 19).replace("T", " ") : null,
          parts: upload.partsBytes,
        },
      );
    }
  });
}

async function replaceLifecycle(db: Database, store: ObjectStore, bucket: string): Promise<void> {
  const rules = await store.getLifecycle(bucket);
  await db.write(async (conn) => {
    await execute(conn, "DELETE FROM lifecycle_rules WHERE bucket = $bucket", { bucket });
    for (const rule of rules) {
      await execute(
        conn,
        `INSERT INTO lifecycle_rules VALUES ($bucket, $rule_id, $prefix, $tags, $min_size, $actions)`,
        {
          bucket,
          rule_id: rule.ruleId,
          prefix: rule.prefix,
          tags: JSON.stringify(rule.tags),
          min_size: rule.minSize,
          actions: JSON.stringify(rule.actions),
        },
      );
    }
  });
}

export function scalarParams(value: unknown): Record<string, DuckDBValue> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, DuckDBValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null || typeof item === "number" || typeof item === "string" || typeof item === "boolean") {
      out[key] = item as DuckDBValue;
    }
  }
  return out;
}

export function bindUsed(sql: string, available: Record<string, DuckDBValue>): Record<string, DuckDBValue> {
  const out: Record<string, DuckDBValue> = {};
  for (const [key, value] of Object.entries(available)) {
    if (sql.includes(`$${key}`)) out[key] = value;
  }
  return out;
}
