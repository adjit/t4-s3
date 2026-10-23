import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryAll, Workspace } from "@t4/core";
import { buildServer } from "./server.js";

// pnpm runs this file with cwd apps/api. Use the workspace data/ directory unless T4_DATA_DIR is set.
const dataDir = process.env.T4_DATA_DIR || join(workspaceRoot(), "data");
const port = numberEnv("PORT", 8080);
const host = process.env.HOST || "0.0.0.0";

mkdirSync(dataDir, { recursive: true });
const token = resolveToken(dataDir);
const workspace = await Workspace.open({
  dataDir,
  memoryLimit: process.env.T4_DUCKDB_MEMORY,
  threads: process.env.T4_DUCKDB_THREADS,
});
await workspace.ensureBootstrap(process.env);

const app = await buildServer({
  workspace,
  token,
  webDist: process.env.T4_WEB_DIST || null,
  dataDir,
});

await app.listen({ port, host });

const timer = setInterval(() => {
  void runDueSchedules(workspace).catch((error: unknown) => {
    console.error("schedule tick failed", error instanceof Error ? error.message : error);
  });
}, 60_000);
timer.unref();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.close();
  await workspace.close();
}

process.on("SIGINT", () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.on("SIGTERM", () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

function resolveToken(dir: string): string {
  const configured = process.env.T4_TOKEN?.trim();
  if (configured) return configured;
  const tokenPath = join(dir, "dev-token.txt");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const generated = randomBytes(24).toString("hex");
  try {
    writeFileSync(tokenPath, `${generated}\n`, { flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") return readFileSync(tokenPath, "utf8").trim();
    throw error;
  }
  console.log(`Dev token written to ${tokenPath}`);
  return generated;
}

async function runDueSchedules(current: Workspace): Promise<void> {
  const due = await current.dueSchedules();
  const running = await current.db.read((conn) => queryAll(conn, "SELECT kind, bucket FROM jobs WHERE status = 'running'"));
  const active = new Set(running.map((job) => `${String(job.kind)}\0${job.bucket == null ? "" : String(job.bucket)}`));
  for (const schedule of due) {
    const kind = String(schedule.kind);
    if (kind !== "index" && kind !== "analyze") continue;
    if (schedule.bucket == null || schedule.bucket === "") continue;
    const bucket = String(schedule.bucket);
    const key = `${kind}\0${bucket}`;
    if (active.has(key)) continue;
    if (kind === "index") {
      await current.startJob("index", bucket, () => current.indexBucket(bucket));
    } else {
      await current.startJob("analyze", bucket, () => current.runAnalyzers(bucket));
    }
    active.add(key);
  }
}

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
