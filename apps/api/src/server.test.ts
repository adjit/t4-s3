import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, Workspace } from "@t4/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "./server.js";

const token = "test-token";
const store = new MemoryStore();
const auth = { authorization: `Bearer ${token}` };

let app: FastifyInstance | undefined;
let workspace: Workspace | undefined;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "t4-api-"));
  workspace = await Workspace.open({
    dataDir: dir,
    databasePath: ":memory:",
    storeFor: () => store,
  });
  app = await buildServer({ workspace, token, dataDir: dir });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await workspace?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("GET /api/health is 200 without a token", async () => {
  const response = await server().inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
});

test("GET /api/buckets is 401 without a token and 200 with Bearer", async () => {
  const denied = await server().inject({ method: "GET", url: "/api/buckets" });
  expect(denied.statusCode).toBe(401);
  expect(denied.headers["content-type"]).toContain("application/problem+json");

  const allowed = await server().inject({ method: "GET", url: "/api/buckets", headers: auth });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json()).toEqual([]);
});

test("index a memory object and browse it", async () => {
  const connection = await server().inject({
    method: "POST",
    url: "/api/connections",
    headers: auth,
    payload: {
      name: "memory",
      endpoint: "http://127.0.0.1:9",
      region: "us-east-1",
      urlStyle: "path",
      useSsl: false,
      tlsVerify: false,
      providerHint: "other",
    },
  });
  expect(connection.statusCode).toBe(200);
  const connectionId = stringField(connection.json(), "connectionId");

  const bucket = await server().inject({
    method: "POST",
    url: "/api/buckets",
    headers: auth,
    payload: { bucket: "demo", connectionId },
  });
  expect(bucket.statusCode).toBe(200);

  store.put({
    bucket: "demo",
    key: "logs/new.txt",
    versionId: null,
    isLatest: true,
    isDeleteMarker: false,
    size: 4,
    lastModified: new Date("2026-01-02T03:04:05Z"),
    etag: "abc",
    storageClass: "STANDARD",
    isMultipart: false,
    checksumAlgo: null,
    encryption: null,
    replication: null,
    itAccessTier: null,
    objectLockMode: null,
    body: new TextEncoder().encode("demo"),
  });

  const index = await server().inject({
    method: "POST",
    url: "/api/buckets/demo/index",
    headers: auth,
    payload: {},
  });
  expect(index.statusCode).toBe(200);
  const jobId = stringField(index.json(), "jobId");

  const deadline = Date.now() + 20_000;
  let job: unknown = {};
  let status = "";
  while (Date.now() < deadline) {
    const response = await server().inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: auth });
    expect(response.statusCode).toBe(200);
    job = response.json();
    status = stringField(job, "status");
    if (status === "done" || status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(status, JSON.stringify(job)).toBe("done");

  const browse = await server().inject({ method: "GET", url: "/api/buckets/demo/browse", headers: auth });
  expect(browse.statusCode).toBe(200);
  const text = JSON.stringify(browse.json());
  expect(text.includes("logs/") || text.includes("logs/new.txt")).toBe(true);
}, 30_000);

test("rejects SQL that is not a console query", async () => {
  const response = await server().inject({
    method: "POST",
    url: "/api/query",
    headers: auth,
    payload: { sql: "INSERT INTO objects VALUES (1)" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.headers["content-type"]).toContain("application/problem+json");
});

test("connection test requires an endpoint and does not save one", async () => {
  const before = await server().inject({ method: "GET", url: "/api/connections", headers: auth });
  const missing = await server().inject({
    method: "POST",
    url: "/api/connections/test",
    headers: auth,
    payload: { accessKeyId: "only-a-key" },
  });
  expect(missing.statusCode).toBe(400);

  const after = await server().inject({ method: "GET", url: "/api/connections", headers: auth });
  expect(after.json()).toEqual(before.json());
});

test("add, use, and remove an S3 connection", async () => {
  const created = await server().inject({
    method: "POST",
    url: "/api/connections",
    headers: auth,
    payload: {
      name: "lab",
      endpoint: "http://127.0.0.1:9",
      region: "us-east-1",
      urlStyle: "path",
      useSsl: false,
      tlsVerify: false,
      accessKeyId: "lab-key",
      secretAccessKey: "lab-secret",
    },
  });
  expect(created.statusCode).toBe(200);
  const connectionId = stringField(created.json(), "connectionId");

  const listed = await server().inject({ method: "GET", url: "/api/connections", headers: auth });
  expect(JSON.stringify(listed.json())).toContain("lab-key");

  const badName = await server().inject({
    method: "POST",
    url: `/api/connections/${connectionId}/buckets`,
    headers: auth,
    payload: { name: "Bad_Name" },
  });
  expect(badName.statusCode).toBe(400);

  const made = await server().inject({
    method: "POST",
    url: `/api/connections/${connectionId}/buckets`,
    headers: auth,
    payload: { name: "widgets" },
  });
  expect(made.statusCode).toBe(200);

  const buckets = await server().inject({ method: "GET", url: `/api/connections/${connectionId}/buckets`, headers: auth });
  expect(buckets.statusCode).toBe(200);
  expect(buckets.json()).toMatchObject({ buckets: expect.arrayContaining(["widgets"]) });

  const missingPolicy = await server().inject({
    method: "GET",
    url: `/api/connections/${connectionId}/buckets/widgets/policy`,
    headers: auth,
  });
  expect(missingPolicy.statusCode).toBe(200);
  expect(missingPolicy.json()).toEqual({ policy: null });

  const saved = await server().inject({
    method: "PUT",
    url: `/api/connections/${connectionId}/buckets/widgets/policy`,
    headers: auth,
    payload: { policy: { Version: "2012-10-17", Statement: [] } },
  });
  expect(saved.statusCode).toBe(200);

  const policy = await server().inject({
    method: "GET",
    url: `/api/connections/${connectionId}/buckets/widgets/policy`,
    headers: auth,
  });
  expect(policy.statusCode).toBe(200);
  expect(JSON.parse(String((policy.json() as { policy: string }).policy)).Version).toBe("2012-10-17");

  const cleared = await server().inject({
    method: "DELETE",
    url: `/api/connections/${connectionId}/buckets/widgets/policy`,
    headers: auth,
  });
  expect(cleared.statusCode).toBe(200);

  const removed = await server().inject({ method: "DELETE", url: `/api/connections/${connectionId}`, headers: auth });
  expect(removed.statusCode).toBe(200);
  const after = await server().inject({ method: "GET", url: "/api/connections", headers: auth });
  expect(JSON.stringify(after.json())).not.toContain(connectionId);

  const gone = await server().inject({ method: "GET", url: `/api/connections/${connectionId}/buckets`, headers: auth });
  expect(gone.statusCode).toBe(404);
});

test("create and delete folders with write, protection, and name checks", async () => {
  const created = await server().inject({
    method: "POST",
    url: "/api/connections",
    headers: auth,
    payload: { name: "shelf-store", endpoint: "http://127.0.0.1:9", useSsl: false, tlsVerify: false },
  });
  const connectionId = stringField(created.json(), "connectionId");
  expect((await server().inject({ method: "POST", url: `/api/connections/${connectionId}/buckets`, headers: auth, payload: { name: "shelf" } })).statusCode).toBe(200);
  expect((await server().inject({ method: "POST", url: "/api/buckets", headers: auth, payload: { bucket: "shelf", connectionId } })).statusCode).toBe(200);

  const readOnly = await server().inject({ method: "POST", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "", name: "reports" } });
  expect(readOnly.statusCode).toBe(403);
  expect(readOnly.body).toContain("Writes are turned off");

  await server().inject({ method: "PATCH", url: "/api/buckets/shelf", headers: auth, payload: { writeEnabled: true } });
  const slash = await server().inject({ method: "POST", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "", name: "a/b" } });
  expect(slash.statusCode).toBe(400);
  const made = await server().inject({ method: "POST", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "", name: "reports" } });
  expect(made.statusCode).toBe(200);
  expect(made.json()).toEqual({ key: "reports/" });
  expect(store.objects.some((object) => object.bucket === "shelf" && object.key === "reports/")).toBe(true);
  const again = await server().inject({ method: "POST", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "", name: "reports" } });
  expect(again.statusCode).toBe(409);

  const browse = await server().inject({ method: "GET", url: "/api/buckets/shelf/browse", headers: auth });
  expect(JSON.stringify(browse.json())).toContain("reports/");

  await store.putObject("shelf", "reports/q1.csv", new TextEncoder().encode("a,b\n1,2\n"));
  const info = await server().inject({ method: "GET", url: "/api/buckets/shelf/folder?prefix=reports/", headers: auth });
  expect(info.json()).toMatchObject({ objects: 2, bytes: 8, blocked: null });

  await server().inject({ method: "PATCH", url: "/api/buckets/shelf", headers: auth, payload: { protectedPrefixes: ["reports/q"] } });
  const guarded = await server().inject({ method: "DELETE", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "reports/", confirmation: "reports" } });
  expect(guarded.statusCode).toBe(403);
  expect(guarded.body).toContain("protected prefix");
  await server().inject({ method: "PATCH", url: "/api/buckets/shelf", headers: auth, payload: { protectedPrefixes: [] } });

  const wrongName = await server().inject({ method: "DELETE", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "reports/", confirmation: "report" } });
  expect(wrongName.statusCode).toBe(400);
  const removed = await server().inject({ method: "DELETE", url: "/api/buckets/shelf/folders", headers: auth, payload: { prefix: "reports/", confirmation: "reports" } });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toMatchObject({ deleted: 2, failed: 0, bytes: 8 });
  expect(store.objects.some((object) => object.bucket === "shelf" && object.key.startsWith("reports/") && object.isLatest)).toBe(false);
  const after = await server().inject({ method: "GET", url: "/api/buckets/shelf/browse", headers: auth });
  expect(JSON.stringify(after.json())).not.toContain("reports/");

  // Bucket delete refuses a non-empty bucket and needs the exact name.
  await store.putObject("shelf", "left.txt", new TextEncoder().encode("x"));
  const notEmpty = await server().inject({ method: "DELETE", url: `/api/connections/${connectionId}/buckets/shelf`, headers: auth, payload: { confirmation: "shelf" } });
  expect(notEmpty.statusCode).toBe(409);
  expect(notEmpty.body).toContain("not empty");
  store.objects.splice(0, store.objects.length, ...store.objects.filter((object) => object.bucket !== "shelf"));
  const wrongBucket = await server().inject({ method: "DELETE", url: `/api/connections/${connectionId}/buckets/shelf`, headers: auth, payload: { confirmation: "shel" } });
  expect(wrongBucket.statusCode).toBe(400);
  const dropped = await server().inject({ method: "DELETE", url: `/api/connections/${connectionId}/buckets/shelf`, headers: auth, payload: { confirmation: "shelf" } });
  expect(dropped.statusCode).toBe(200);
  expect(store.buckets.has("shelf")).toBe(false);
  const registered = await server().inject({ method: "GET", url: "/api/buckets", headers: auth });
  expect(JSON.stringify(registered.json())).not.toContain("\"shelf\"");

  // Removing a connection stops tracking its buckets and clears their index rows.
  await server().inject({ method: "POST", url: "/api/buckets", headers: auth, payload: { bucket: "scratch", connectionId } });
  const gone = await server().inject({ method: "DELETE", url: `/api/connections/${connectionId}`, headers: auth });
  expect(gone.statusCode).toBe(200);
  const remaining = await server().inject({ method: "GET", url: "/api/buckets", headers: auth });
  expect(JSON.stringify(remaining.json())).not.toContain("scratch");
}, 30_000);

test("empty findingIds is 400 and openapi lists plans", async () => {
  const response = await server().inject({
    method: "POST",
    url: "/api/plans",
    headers: auth,
    payload: { bucket: "demo", findingIds: [] },
  });
  expect(response.statusCode).toBe(400);

  const spec = await server().inject({ method: "GET", url: "/api/openapi.json", headers: auth });
  expect(spec.statusCode).toBe(200);
  expect(spec.body).toContain("/api/plans");
  expect(spec.body).toContain("/api/connections/test");
  expect(spec.body).toContain("/api/connections/{connectionId}/buckets");
});

function server(): FastifyInstance {
  if (!app) throw new Error("server was not started");
  return app;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing ${key}`);
  const field = Object.fromEntries(Object.entries(value))[key];
  if (typeof field !== "string" || field === "") throw new Error(`missing ${key}`);
  return field;
}
