import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBValue,
} from "@duckdb/node-api";
import { plainRow } from "../plain.js";

const schemaSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "schema.sql"),
  "utf8",
);

export type SqlParams = Record<string, DuckDBValue> | DuckDBValue[];

export class Database {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly writeConn: DuckDBConnection,
  ) {}

  static async open(
    path: string,
    options?: { memoryLimit?: string; threads?: string; tempDirectory?: string },
  ): Promise<Database> {
    const config: Record<string, string> = {
      memory_limit: options?.memoryLimit ?? "2GB",
      threads: options?.threads ?? "4",
    };
    if (options?.tempDirectory) config.temp_directory = options.tempDirectory;
    const instance = await DuckDBInstance.create(path, config);
    const writeConn = await instance.connect();
    await writeConn.run("SET preserve_insertion_order = false");
    const database = new Database(instance, writeConn);
    await database.write(async (conn) => {
      await execScript(conn, schemaSql);
    });
    return database;
  }

  write<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const run = this.writeChain.then(() => fn(this.writeConn));
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const conn = await this.instance.connect();
    try {
      return await fn(conn);
    } finally {
      conn.closeSync();
    }
  }

  async close(): Promise<void> {
    await this.writeChain;
    this.writeConn.closeSync();
    this.instance.closeSync();
  }
}

export async function execScript(conn: DuckDBConnection, script: string): Promise<void> {
  const extracted = await conn.extractStatements(script);
  for (let index = 0; index < extracted.count; index += 1) {
    const prepared = await extracted.prepare(index);
    await prepared.run();
  }
}

export async function queryAll(
  conn: DuckDBConnection,
  sql: string,
  params?: SqlParams,
): Promise<Record<string, unknown>[]> {
  const reader = params
    ? await conn.runAndReadAll(sql, params)
    : await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS().map((row) => plainRow(row));
}

export async function queryOne(
  conn: DuckDBConnection,
  sql: string,
  params?: SqlParams,
): Promise<Record<string, unknown> | null> {
  const rows = await queryAll(conn, sql, params);
  return rows[0] ?? null;
}

export async function execute(
  conn: DuckDBConnection,
  sql: string,
  params?: SqlParams,
): Promise<void> {
  if (params) await conn.run(sql, params);
  else await conn.run(sql);
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function duckPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
