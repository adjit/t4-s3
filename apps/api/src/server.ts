import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  asNumber,
  connectionError,
  isT4Error,
  normalizeEndpoint,
  queryAll,
  S3ObjectStore,
  T4Error,
  testConnection,
  type BucketInput,
  type ConnectionInput,
  type SearchFilters,
  type Workspace,
} from "@t4/core";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { openApiDocument } from "./openapi.js";

const EXPORT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(csv|parquet)$/i;
const SETTING_KEYS = new Set(["kill_switch", "theme"]);

export interface BuildServerOptions {
  workspace: Workspace;
  token: string;
  webDist?: string | null;
  dataDir: string;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : { redact: ["req.headers.authorization"] },
  });
  const workspace = options.workspace;
  const stops = new Set<() => void>();
  const webRoot = existingDirectory(options.webDist);

  await app.register(cors, { origin: true });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const thrown: unknown = error;
    if (isT4Error(thrown)) {
      return sendProblem(reply, thrown.status, thrown.message);
    }
    const statusCode = httpStatus(error);
    if (statusCode >= 400 && statusCode < 500) {
      const title = statusCode === 400 ? "Bad Request" : "Request failed";
      const detail = error instanceof Error && error.message ? error.message : title;
      return sendProblem(reply, statusCode, title, detail);
    }
    request.log.error({ err: error }, "request failed");
    return sendProblem(reply, 500, "Internal Server Error");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!requiresBearer(request)) return;
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    const provided = match?.[1] ?? "";
    if (!tokenMatches(provided, options.token)) {
      reply.code(401).type("application/problem+json").send(problem(401, "Unauthorized", "Missing or invalid bearer token"));
      return;
    }
  });

  app.addHook("onClose", async () => {
    for (const stop of stops) stop();
    stops.clear();
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/metrics", async (request, reply) => sendMetrics(workspace, request, reply));
  app.get("/api/metrics", async (request, reply) => sendMetrics(workspace, request, reply));
  app.get("/api/openapi.json", async () => openApiDocument);

  app.get("/api/connections", async () => workspace.listConnections());
  app.post("/api/connections/test", async (request) => {
    const body = bodyOf(request);
    const endpoint = requireString(body, "endpoint");
    const useSsl = optionalBoolean(body, "useSsl") ?? /^https:/i.test(endpoint);
    const accessKeyId = optionalString(body, "accessKeyId");
    const secretAccessKey = optionalString(body, "secretAccessKey");
    const store = new S3ObjectStore(
      {
        endpoint: normalizeEndpoint(endpoint, useSsl),
        region: optionalString(body, "region") || "us-east-1",
        urlStyle: urlStyleOf(body) ?? "path",
        useSsl,
        tlsVerify: optionalBoolean(body, "tlsVerify") ?? true,
        caBundlePath: nullableString(body, "caBundlePath"),
        requestRatePerSec: null,
      },
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, sessionToken: optionalString(body, "sessionToken") }
        : undefined,
    );
    const bucket = optionalString(body, "bucket");
    try {
      return await testConnection(store, bucket);
    } catch (error) {
      return { ok: false, summary: connectionError(error) };
    }
  });
  app.post("/api/connections", async (request) => {
    const connectionId = await workspace.saveConnection(connectionInput(bodyOf(request)));
    return { connectionId };
  });
  app.patch("/api/connections/:connectionId", async (request) => {
    const connectionId = param(request, "connectionId");
    await workspace.saveConnection(connectionInput(bodyOf(request)), connectionId);
    return { connectionId };
  });
  app.delete("/api/connections/:connectionId", async (request) => {
    await workspace.deleteConnection(param(request, "connectionId"));
    return { removed: true };
  });
  app.get("/api/connections/:connectionId/buckets", async (request) => {
    const buckets = await workspace.listStoreBuckets(param(request, "connectionId"));
    return { buckets };
  });
  app.post("/api/connections/:connectionId/buckets", async (request) => {
    const connectionId = param(request, "connectionId");
    const bucket = requireString(bodyOf(request), "name");
    await workspace.createStoreBucket(connectionId, bucket);
    return { bucket };
  });
  app.delete("/api/connections/:connectionId/buckets/:bucket", async (request) => {
    const body = bodyOf(request);
    await workspace.deleteStoreBucket(
      param(request, "connectionId"),
      param(request, "bucket"),
      optionalString(body, "confirmation") ?? "",
      actorFrom(request, body),
    );
    return { deleted: true };
  });
  app.get("/api/buckets/:bucket/folder", async (request) => {
    return workspace.folderInfo(param(request, "bucket"), queryString(queryOf(request), "prefix") ?? "");
  });
  app.post("/api/buckets/:bucket/folders", async (request) => {
    const body = bodyOf(request);
    return workspace.createFolder(param(request, "bucket"), optionalString(body, "prefix") ?? "", requireString(body, "name"), actorFrom(request, body));
  });
  app.delete("/api/buckets/:bucket/folders", async (request) => {
    const body = bodyOf(request);
    return workspace.deleteFolder(
      param(request, "bucket"),
      requireString(body, "prefix"),
      optionalString(body, "confirmation") ?? "",
      actorFrom(request, body),
    );
  });
  app.get("/api/connections/:connectionId/buckets/:bucket/policy", async (request) => {
    const policy = await workspace.getStoreBucketPolicy(param(request, "connectionId"), param(request, "bucket"));
    return { policy };
  });
  app.put("/api/connections/:connectionId/buckets/:bucket/policy", async (request) => {
    await workspace.putStoreBucketPolicy(param(request, "connectionId"), param(request, "bucket"), policyText(bodyOf(request)));
    return { saved: true };
  });
  app.delete("/api/connections/:connectionId/buckets/:bucket/policy", async (request) => {
    await workspace.deleteStoreBucketPolicy(param(request, "connectionId"), param(request, "bucket"));
    return { removed: true };
  });

  app.get("/api/buckets", async () => workspace.listBuckets());
  app.post("/api/buckets", async (request) => {
    const input = bucketInput(bodyOf(request));
    await workspace.saveBucket(input);
    return workspace.summary(input.bucket);
  });
  app.get("/api/buckets/:bucket", async (request) => workspace.summary(param(request, "bucket")));
  app.patch("/api/buckets/:bucket", async (request) => {
    const bucket = param(request, "bucket");
    await workspace.updateBucket(bucket, bucketPatch(bodyOf(request)));
    return workspace.summary(bucket);
  });
  app.post("/api/buckets/:bucket/probe", async (request) => workspace.probe(param(request, "bucket")));
  app.post("/api/buckets/:bucket/index/estimate", async (request) => {
    const body = bodyOf(request);
    return workspace.estimateIndex(param(request, "bucket"), optionalString(body, "prefix") ?? "", optionalNumber(body, "depth") ?? 2);
  });
  app.post("/api/buckets/:bucket/index", async (request) => {
    const bucket = param(request, "bucket");
    const body = bodyOf(request);
    const prefix = optionalString(body, "prefix");
    const depth = optionalNumber(body, "depth");
    const jobId = await workspace.startJob("index", bucket, () => workspace.indexBucket(bucket, { prefix, depth }));
    return { jobId };
  });
  app.post("/api/buckets/:bucket/index-inventory", async (request) => {
    const bucket = param(request, "bucket");
    const body = bodyOf(request);
    const parquetPath = requireString(body, "parquetPath");
    const expectedRows = optionalNumber(body, "expectedRows");
    const jobId = await workspace.startJob("index-inventory", bucket, () => workspace.indexInventory(bucket, parquetPath, expectedRows));
    return { jobId };
  });

  app.get("/api/jobs", async () => (await workspace.listJobs()).map(presentJob));
  app.get("/api/jobs/:id", async (request) => presentJob(await workspace.getJob(param(request, "id"))));
  app.get("/api/jobs/:id/events", async (request, reply) => {
    const id = param(request, "id");
    await workspace.getJob(id);
    reply.hijack();
    const headers: Record<string, string | number | string[]> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (typeof value === "string" || typeof value === "number") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.map((item) => String(item));
    }
    reply.raw.writeHead(200, headers);

    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stops.delete(stop);
    };
    stops.add(stop);
    request.raw.on("close", stop);

    const started = Date.now();
    const tick = async () => {
      if (stopped || reply.raw.writableEnded || reply.raw.destroyed) return;
      try {
        const job = await workspace.getJob(id);
        if (stopped || reply.raw.destroyed) return;
        reply.raw.write(`event: job\ndata: ${JSON.stringify(presentJob(job))}\n\n`);
        const status = String(job.status);
        if (status === "done" || status === "failed" || Date.now() - started >= 60_000) {
          stop();
          reply.raw.end();
          return;
        }
      } catch (error) {
        if (!stopped && !reply.raw.destroyed) {
          const message = isT4Error(error) ? error.message : "Job stream failed";
          const status = isT4Error(error) ? error.status : 500;
          try {
            reply.raw.write(`event: error\ndata: ${JSON.stringify(problem(status, message))}\n\n`);
            reply.raw.end();
          } catch {
            // The client is already gone.
          }
        }
        stop();
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, 500);
      timer.unref();
    };
    void tick();
  });

  app.get("/api/buckets/:bucket/browse", async (request) => {
    const query = queryOf(request);
    return workspace.browse(
      param(request, "bucket"),
      queryString(query, "prefix") ?? "",
      queryString(query, "cursor") ?? "",
      queryNumber(query, "limit") ?? 500,
    );
  });
  app.get("/api/buckets/:bucket/tree", async (request) => {
    return workspace.tree(param(request, "bucket"), queryString(queryOf(request), "prefix") ?? "");
  });
  app.get("/api/buckets/:bucket/search", async (request) => {
    return workspace.search(searchFilters(param(request, "bucket"), queryOf(request)));
  });
  app.get("/api/buckets/:bucket/objects", async (request) => {
    const key = queryString(queryOf(request), "key");
    if (!key) throw new T4Error(400, "key is required");
    return workspace.objectDetail(param(request, "bucket"), key);
  });
  app.get("/api/buckets/:bucket/objects/download-url", async (request) => {
    const query = queryOf(request);
    const key = queryString(query, "key");
    if (!key) throw new T4Error(400, "key is required");
    return workspace.downloadUrl(param(request, "bucket"), key, queryNumber(query, "expires") ?? 300);
  });
  app.get("/api/buckets/:bucket/objects/preview", async (request) => {
    const key = queryString(queryOf(request), "key");
    if (!key) throw new T4Error(400, "key is required");
    return workspace.preview(param(request, "bucket"), key);
  });

  app.post("/api/query", async (request) => {
    const body = bodyOf(request);
    return workspace.query(requireString(body, "sql"), optionalNumber(body, "limit") ?? 1000);
  });
  app.post("/api/export", async (request) => {
    const body = bodyOf(request);
    const format = requireString(body, "format");
    if (format !== "csv" && format !== "parquet") throw new T4Error(400, "format must be csv or parquet");
    const exported = await workspace.exportQuery(requireString(body, "sql"), format);
    return { ...exported, url: `/api/exports/${exported.fileName}` };
  });
  app.get("/api/exports/:fileName", async (request, reply) => {
    const fileName = param(request, "fileName");
    if (fileName !== basename(fileName) || !EXPORT_NAME.test(fileName)) {
      throw new T4Error(400, "Export name must be a uuid with a csv or parquet extension");
    }
    const file = join(options.dataDir, "exports", fileName);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") throw new T4Error(404, "Export not found");
      throw error;
    }
    const type = fileName.toLowerCase().endsWith(".csv") ? "text/csv; charset=utf-8" : "application/vnd.apache.parquet";
    return reply
      .type(type)
      .header("content-length", size)
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .send(createReadStream(file));
  });

  app.get("/api/saved-queries", async () => workspace.listSavedQueries());
  app.post("/api/saved-queries", async (request) => {
    const body = bodyOf(request);
    const id = await workspace.saveQuery(requireString(body, "name"), requireString(body, "sql"));
    return { id };
  });
  app.delete("/api/saved-queries/:id", async (request) => {
    await workspace.deleteSavedQuery(param(request, "id"));
    return { ok: true };
  });

  app.get("/api/analyzers", async () => workspace.listAnalyzers());
  app.post("/api/analyzers/run", async (request) => {
    const body = bodyOf(request);
    const bucket = requireString(body, "bucket");
    const analyzerId = optionalString(body, "analyzerId");
    const overrides = optionalRecord(body, "overrides");
    const jobId = await workspace.startJob("analyze", bucket, () => workspace.runAnalyzers(bucket, analyzerId, overrides));
    return { jobId };
  });

  app.get("/api/findings", async (request) => {
    const query = queryOf(request);
    return workspace.listFindings(queryString(query, "bucket"), queryString(query, "status"));
  });
  app.patch("/api/findings/:id", async (request) => {
    await workspace.patchFinding(param(request, "id"), requireString(bodyOf(request), "status"));
    return { ok: true };
  });

  app.post("/api/plans", async (request) => {
    const body = bodyOf(request);
    const findingIds = stringArray(body, "findingIds");
    if (findingIds.length === 0) throw new T4Error(400, "Select at least one finding");
    const planId = await workspace.createPlan(requireString(body, "bucket"), findingIds, actorFrom(request, body));
    return { planId };
  });
  app.get("/api/plans", async (request) => workspace.listPlans(queryString(queryOf(request), "bucket")));
  app.get("/api/plans/:id", async (request) => workspace.getPlan(param(request, "id")));
  app.post("/api/plans/:id/dry-run", async (request) => workspace.dryRun(param(request, "id"), actorFrom(request, bodyOf(request))));
  app.post("/api/plans/:id/approve", async (request) => {
    const body = bodyOf(request);
    const confirmation = body.confirmation;
    if (typeof confirmation !== "string") throw new T4Error(400, "confirmation is required");
    await workspace.approve(param(request, "id"), actorFrom(request, body), confirmation);
    return { ok: true };
  });
  app.post("/api/plans/:id/execute", async (request) => {
    return workspace.execute(param(request, "id"), actorFrom(request, bodyOf(request)));
  });
  app.post("/api/plans/:id/cancel", async (request) => {
    await workspace.cancel(param(request, "id"), actorFrom(request, bodyOf(request)));
    return { ok: true };
  });
  app.post("/api/plans/:id/undo", async (request) => {
    const undone = await workspace.undo(param(request, "id"), actorFrom(request, bodyOf(request)));
    return { undone };
  });

  app.get("/api/audit", async (request) => workspace.audit(queryString(queryOf(request), "bucket")));
  app.get("/api/tables", async (request) => {
    const bucket = queryString(queryOf(request), "bucket");
    if (!bucket) throw new T4Error(400, "bucket is required");
    return workspace.listTables(bucket);
  });

  app.get("/api/schedules", async () => workspace.listSchedules());
  app.post("/api/schedules", async (request) => {
    const body = bodyOf(request);
    const cron = requireString(body, "cron");
    if (cron.trim().split(/\s+/).length !== 5) throw new T4Error(400, "Cron expressions need five fields: minute hour day month weekday");
    const bucket = body.bucket;
    if (bucket != null && typeof bucket !== "string") throw new T4Error(400, "bucket must be a string");
    const id = await workspace.saveSchedule({
      bucket: typeof bucket === "string" ? bucket : null,
      kind: requireString(body, "kind"),
      cron,
      enabled: optionalBoolean(body, "enabled"),
      webhookUrl: nullableString(body, "webhookUrl"),
      reclaimThreshold: nullableNumber(body, "reclaimThreshold"),
    });
    return { id };
  });

  app.get("/api/settings/:key", async (request) => {
    const key = settingKey(param(request, "key"));
    return { key, value: await workspace.getSetting(key) };
  });
  app.put("/api/settings/:key", async (request) => {
    const key = settingKey(param(request, "key"));
    const value = settingValue(bodyOf(request));
    await workspace.setSetting(key, value);
    return { key, value };
  });

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = requestPath(request);
    if (webRoot && request.method === "GET" && !isApiPath(path) && !isMetricsPath(path)) {
      return reply.sendFile("index.html");
    }
    return sendProblem(reply, 404, "Not Found");
  });

  return app;
}

export async function renderMetrics(workspace: Workspace): Promise<string> {
  const row = await workspace.db.read(async (conn) => {
    const rows = await queryAll(
      conn,
      `SELECT
         (SELECT count(*) FROM buckets) AS buckets,
         (SELECT count(*) FROM objects WHERE is_latest AND NOT is_delete_marker) AS objects,
         (SELECT coalesce(sum(size), 0) FROM objects WHERE is_latest AND NOT is_delete_marker) AS bytes,
         (SELECT coalesce(sum(reclaimable_bytes), 0) FROM findings WHERE status = 'open') AS reclaimable_bytes,
         (SELECT count(*) FROM findings WHERE status = 'open') AS open_findings,
         (SELECT count(*) FROM jobs WHERE status = 'running') AS jobs_running`,
    );
    return rows[0] ?? {};
  });
  return [
    gauge("t4_buckets", row.buckets),
    gauge("t4_objects", row.objects),
    gauge("t4_bytes", row.bytes),
    gauge("t4_reclaimable_bytes", row.reclaimable_bytes),
    gauge("t4_open_findings", row.open_findings),
    gauge("t4_jobs_running", row.jobs_running),
  ].join("");
}

async function sendMetrics(workspace: Workspace, request: FastifyRequest, reply: FastifyReply) {
  return reply
    .header("cache-control", "no-store")
    .header("x-request-id", request.id)
    .type("text/plain; charset=utf-8")
    .send(await renderMetrics(workspace));
}

function gauge(name: string, value: unknown): string {
  const n = asNumber(value);
  const safe = Number.isFinite(n) ? n : 0;
  return `# TYPE ${name} gauge\n${name} ${safe}\n`;
}

function problem(status: number, title: string, detail = title) {
  return { type: "about:blank", title, status, detail };
}

function sendProblem(reply: FastifyReply, status: number, title: string, detail = title) {
  return reply.code(status).type("application/problem+json").send(problem(status, title, detail));
}

function httpStatus(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

function tokenMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? request.url;
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function isMetricsPath(path: string): boolean {
  return path === "/metrics" || path.startsWith("/metrics/");
}

function requiresBearer(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") return false;
  const path = requestPath(request);
  if (!isApiPath(path)) return false;
  return !(request.method === "GET" && path === "/api/health");
}

function existingDirectory(path: string | null | undefined): string | null {
  if (!path) return null;
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return null;
  return resolved;
}

function presentJob(job: Record<string, unknown>): Record<string, unknown> {
  return { ...job, result: parseJsonValue(job.result), log: parseJsonValue(job.log) };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text !== "null" && !text.startsWith("{") && !text.startsWith("[")) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body == null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new T4Error(400, "JSON object required");
  return Object.fromEntries(Object.entries(body));
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query = request.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return {};
  return Object.fromEntries(Object.entries(query));
}

function param(request: FastifyRequest, name: string): string {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new T4Error(400, `${name} is required`);
  const value = Object.fromEntries(Object.entries(params))[name];
  if (typeof value !== "string" || value === "") throw new T4Error(400, `${name} is required`);
  return value;
}

function queryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw;
}

function queryNumber(query: Record<string, unknown>, key: string): number | undefined {
  const raw = queryString(query, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new T4Error(400, `${key} must be a number`);
  return n;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new T4Error(400, `${key} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body) || body[key] == null) return undefined;
  const value = body[key];
  if (typeof value !== "string") throw new T4Error(400, `${key} must be a string`);
  return value;
}

function nullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new T4Error(400, `${key} must be a string`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in body) || body[key] == null) return undefined;
  const value = body[key];
  if (typeof value !== "boolean") throw new T4Error(400, `${key} must be a boolean`);
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  if (!(key in body) || body[key] == null) return undefined;
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new T4Error(400, `${key} must be a number`);
  return value;
}

function nullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in body)) return undefined;
  if (body[key] == null) return null;
  return optionalNumber(body, key);
}

function optionalRecord(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!(key in body) || body[key] == null) return undefined;
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new T4Error(400, `${key} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new T4Error(400, `${key} must be an array of strings`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new T4Error(400, `${key} must be an array of strings`);
    items.push(item);
  }
  return items;
}

function urlStyleOf(body: Record<string, unknown>): ConnectionInput["urlStyle"] {
  const urlStyle = optionalString(body, "urlStyle");
  if (urlStyle === undefined) return undefined;
  if (urlStyle === "path" || urlStyle === "virtual") return urlStyle;
  throw new T4Error(400, "urlStyle must be path or virtual");
}

function indexModeOf(body: Record<string, unknown>): BucketInput["indexMode"] {
  const indexMode = optionalString(body, "indexMode");
  if (indexMode === undefined) return undefined;
  if (indexMode === "crawl" || indexMode === "inventory") return indexMode;
  throw new T4Error(400, "indexMode must be crawl or inventory");
}

function policyText(body: Record<string, unknown>): string {
  const value = body.policy;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  throw new T4Error(400, "policy is required");
}

function connectionInput(body: Record<string, unknown>): ConnectionInput {
  return {
    name: requireString(body, "name"),
    endpoint: requireString(body, "endpoint"),
    region: optionalString(body, "region"),
    urlStyle: urlStyleOf(body),
    useSsl: optionalBoolean(body, "useSsl"),
    tlsVerify: optionalBoolean(body, "tlsVerify"),
    caBundlePath: nullableString(body, "caBundlePath"),
    providerHint: optionalString(body, "providerHint"),
    accessKeyId: optionalString(body, "accessKeyId"),
    secretAccessKey: optionalString(body, "secretAccessKey"),
    sessionToken: optionalString(body, "sessionToken"),
    requestRatePerSec: nullableNumber(body, "requestRatePerSec"),
  };
}

function bucketInput(body: Record<string, unknown>): BucketInput {
  return {
    bucket: requireString(body, "bucket"),
    connectionId: requireString(body, "connectionId"),
    indexMode: indexModeOf(body),
    inventoryUri: nullableString(body, "inventoryUri"),
    writeEnabled: optionalBoolean(body, "writeEnabled"),
    protectedPrefixes: optionalStringArray(body, "protectedPrefixes"),
    staleAfterHours: optionalNumber(body, "staleAfterHours"),
  };
}

function bucketPatch(body: Record<string, unknown>): {
  writeEnabled?: boolean;
  protectedPrefixes?: string[];
  staleAfterHours?: number;
  indexMode?: string;
  inventoryUri?: string | null;
} {
  return {
    writeEnabled: optionalBoolean(body, "writeEnabled"),
    protectedPrefixes: optionalStringArray(body, "protectedPrefixes"),
    staleAfterHours: optionalNumber(body, "staleAfterHours"),
    indexMode: indexModeOf(body),
    inventoryUri: nullableString(body, "inventoryUri"),
  };
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in body) || body[key] == null) return undefined;
  return stringArray(body, key);
}

function versionStateOf(value: string | undefined): SearchFilters["versionState"] {
  if (value === undefined) return undefined;
  if (value === "current" || value === "noncurrent" || value === "delete_marker" || value === "all") return value;
  throw new T4Error(400, "versionState must be current, noncurrent, delete_marker, or all");
}

function searchFilters(bucket: string, query: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {
    bucket,
    prefix: queryString(query, "prefix"),
    minSize: queryNumber(query, "minSize"),
    maxSize: queryNumber(query, "maxSize"),
    modifiedAfter: queryString(query, "modifiedAfter"),
    modifiedBefore: queryString(query, "modifiedBefore"),
    storageClass: queryString(query, "storageClass"),
    ext: queryString(query, "ext"),
    versionState: versionStateOf(queryString(query, "versionState")),
    cursor: queryString(query, "cursor"),
    limit: queryNumber(query, "limit"),
  };
  const regex = queryString(query, "regex");
  const glob = queryString(query, "glob");
  const q = queryString(query, "q");
  if (regex) {
    filters.name = regex;
    filters.nameMode = "regex";
  } else if (glob) {
    filters.name = glob;
    filters.nameMode = "glob";
  } else if (q) {
    filters.name = q;
    filters.nameMode = "substring";
  }
  return filters;
}

function actorFrom(request: FastifyRequest, body: Record<string, unknown>): string {
  const header = request.headers["x-t4-actor"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === "string" && fromHeader.trim() !== "") return fromHeader.trim();
  if (typeof body.actor === "string" && body.actor.trim() !== "") return body.actor.trim();
  return process.env.T4_ACTOR?.trim() || "local";
}

function settingKey(key: string): string {
  if (!SETTING_KEYS.has(key)) throw new T4Error(400, "Unknown setting");
  return key;
}

function settingValue(body: Record<string, unknown>): string {
  if (!("value" in body)) throw new T4Error(400, "value is required");
  const value = body.value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new T4Error(400, "value must be a string, boolean, or number");
}
