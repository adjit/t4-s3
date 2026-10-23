import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryStore,
  T4Error,
  Workspace,
  assertSafeConsoleSql,
  cronMatches,
  deriveKey,
  duckPath,
  execute,
  isProtected,
  parseCron,
  probeStore,
  sqlLiteral,
  type ConnectionInput,
  type ListedObject,
} from "./index.js";

const SECRET = "super-secret-value";

const connection: ConnectionInput = {
  name: "lab",
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  urlStyle: "path",
  useSsl: false,
  tlsVerify: false,
  providerHint: "other",
  accessKeyId: "test-key",
  secretAccessKey: SECRET,
};

function detailsOf(row: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(row.details));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("finding details were not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return Number.NaN;
}

async function expectStatus(run: () => Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(T4Error);
    const thrown = error as T4Error;
    expect(thrown.status).toBe(status);
    if (message) expect(thrown.message).toMatch(message);
    return;
  }
  throw new Error(`expected T4Error ${status}`);
}

describe("lab fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "t4-"));
  const databasePath = join(dir, "t4.duckdb");
  const store = new MemoryStore();
  const hooks: Array<{ url: string; payload: unknown }> = [];
  let ws!: Workspace;
  let opened = false;
  let connectionId = "";
  let findings: Record<string, unknown>[] = [];
  let closed = false;

  const now = Date.now();
  const ago = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
  const recent = new Date(now);

  function put(object: Partial<ListedObject> & Pick<ListedObject, "key" | "size" | "etag" | "versionId"> & { body?: Uint8Array }): void {
    store.put({
      bucket: "lab",
      isLatest: true,
      isDeleteMarker: false,
      lastModified: recent,
      storageClass: "STANDARD",
      isMultipart: false,
      checksumAlgo: null,
      encryption: "AES256",
      replication: null,
      itAccessTier: null,
      objectLockMode: null,
      legalHold: false,
      body: Uint8Array.of(1),
      ...object,
    });
  }

  beforeAll(async () => {
    store.versioning.set("lab", true);
    put({ key: "archive/stale.txt", size: 80, etag: "s", versionId: "s1", lastModified: ago(400) });
    put({ key: "logs/new.txt", size: 50, etag: "n", versionId: "n1", lastModified: ago(1) });
    put({ key: "dup/a.txt", size: 10, etag: "abc", versionId: "a1", isMultipart: false });
    put({ key: "dup/b.txt", size: 10, etag: "abc", versionId: "b1", isMultipart: false });
    put({ key: "dup/c.txt", size: 10, etag: "abc-1", versionId: "c1", isMultipart: true });
    put({ key: "empty/zero.txt", size: 0, etag: "z", versionId: "z1" });
    put({ key: "empty/folder/", size: 0, etag: "f", versionId: "f1" });
    put({ key: "bad/ spaced.txt", size: 3, etag: "sp", versionId: "sp1" });
    put({ key: "bad/double//slash.txt", size: 4, etag: "sl", versionId: "sl1" });
    put({ key: "Case/A.txt", size: 2, etag: "c1", versionId: "ca1" });
    put({ key: "case/a.txt", size: 2, etag: "c2", versionId: "ca2" });
    put({ key: "versions/file.txt", size: 7, etag: "old", versionId: "1", isLatest: true, lastModified: ago(30) });
    put({ key: "versions/file.txt", size: 5, etag: "new", versionId: "2", isLatest: true });
    for (let index = 0; index < 20; index += 1) {
      put({ key: `tiny/f${index}.txt`, size: 100, etag: `t${index}`, versionId: `t${index}` });
    }
    put({ key: "plain/secret.txt", size: 9, etag: "sec", versionId: "sec1", encryption: "NONE" });
    put({ key: "warehouse/events/metadata/v1.metadata.json", size: 120, etag: "meta", versionId: "meta1" });
    put({ key: "warehouse/events/data/part.parquet", size: 40, etag: "part", versionId: "part1", body: new Uint8Array() });
    store.uploads.push({ bucket: "lab", key: "uploads/partial.bin", uploadId: "u1", initiated: new Date(), partsBytes: 30 });

    ws = await Workspace.open({
      dataDir: dir,
      databasePath,
      storeFor: () => store,
      webhook: async (url, payload) => {
        hooks.push({ url, payload });
      },
    });
    opened = true;
    connectionId = await ws.saveConnection(connection);
    await ws.saveBucket({ bucket: "lab", connectionId, writeEnabled: false, protectedPrefixes: [] });
    await ws.saveSchedule({
      bucket: "lab",
      kind: "analyzers",
      cron: "*/15 * * * *",
      webhookUrl: "https://example.test/hook",
      reclaimThreshold: 1,
    });
    await ws.indexBucket("lab");
    await ws.runAnalyzers("lab");
    findings = await ws.listFindings("lab");
  });

  afterAll(async () => {
    if (!closed && opened) await ws.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes latest objects and browses the bucket", async () => {
    const listed = await store.list({ bucket: "lab", versions: false });
    const listedBytes = listed.objects.reduce((sum, object) => sum + (object.size ?? 0), 0);
    expect(listedBytes).toBe(2345);
    expect(listed.objects).toHaveLength(35);

    const indexed = await ws.query(
      "SELECT count(*) AS objects, coalesce(sum(size), 0) AS bytes FROM objects WHERE bucket = 'lab' AND is_latest AND NOT is_delete_marker",
    );
    expect(num(indexed.rows[0]?.objects)).toBe(listed.objects.length);
    expect(num(indexed.rows[0]?.bytes)).toBe(2345);

    const root = await ws.query("SELECT objects, bytes, noncurrent_bytes FROM prefix_stats WHERE bucket = 'lab' AND prefix = ''");
    expect(num(root.rows[0]?.objects)).toBe(listed.objects.length);
    expect(num(root.rows[0]?.bytes)).toBe(2345);
    expect(num(root.rows[0]?.noncurrent_bytes)).toBe(7);

    const folder = await ws.query("SELECT count(*) AS n FROM objects WHERE bucket = 'lab' AND key = 'empty/folder/'");
    expect(num(folder.rows[0]?.n)).toBe(1);

    const page = await ws.browse("lab", "");
    const folders = page.folders as Array<{ prefix: string }>;
    expect(folders.some((entry) => entry.prefix === "tiny/")).toBe(true);

    const searched = await ws.search({ bucket: "lab", name: "stale" });
    const rows = searched.rows as Array<{ key: string }>;
    expect(rows.some((row) => row.key === "archive/stale.txt")).toBe(true);
  });

  it("runs the built-in analyzers against the fixture", () => {
    const old = findings.filter((row) => row.analyzer === "old-data");
    expect(old).toHaveLength(1);
    expect(old[0]?.prefix).toBe("archive/");
    expect(num(old[0]?.reclaimable_bytes)).toBe(80);

    const duplicates = findings.filter((row) => row.analyzer === "duplicates");
    expect(duplicates).toHaveLength(1);
    expect(num(duplicates[0]?.reclaimable_bytes)).toBe(10);
    const duplicateDetails = detailsOf(duplicates[0]!);
    expect(duplicateDetails.keep_key).toBe("dup/a.txt");
    expect(num(duplicateDetails.copies)).toBe(2);

    const noncurrent = findings.filter((row) => row.analyzer === "noncurrent-versions");
    expect(noncurrent).toHaveLength(1);
    expect(num(noncurrent[0]?.reclaimable_bytes)).toBe(7);

    const zero = findings.filter((row) => row.analyzer === "zero-byte");
    expect(zero).toHaveLength(1);
    expect(num(zero[0]?.reclaimable_bytes)).toBe(0);
    expect(detailsOf(zero[0]!).objects).toBe(2);

    const small = findings.filter((row) => row.analyzer === "small-files");
    const tiny = small.find((row) => row.prefix === "tiny/");
    expect(tiny).toBeTruthy();
    expect(num(tiny?.reclaimable_bytes)).toBe(0);
    expect(detailsOf(tiny!).bytes).toBe(2000);
    expect(small.filter((row) => detailsOf(row).objects === 20).map((row) => row.prefix)).toEqual(["tiny/"]);

    const hygiene = findings.filter((row) => row.analyzer === "key-hygiene");
    expect(hygiene).toHaveLength(1);
    expect(detailsOf(hygiene[0]!).count).toBe(3);

    const posture = findings.filter((row) => row.analyzer === "posture" && row.prefix === "plain/");
    expect(posture).toHaveLength(1);
    expect(num(posture[0]?.reclaimable_bytes)).toBe(0);

    const iceberg = findings.filter((row) => row.analyzer === "iceberg-health");
    expect(iceberg).toHaveLength(1);
    expect(iceberg[0]?.prefix).toBe("warehouse/events/");
    expect(num(iceberg[0]?.reclaimable_bytes)).toBe(0);
    expect(detailsOf(iceberg[0]!).small_files).toBe(2);

    const uploads = findings.filter((row) => row.analyzer === "incomplete-multipart");
    expect(uploads).toHaveLength(1);
    expect(num(uploads[0]?.reclaimable_bytes)).toBe(30);

    const lifecycle = findings.filter((row) => row.analyzer === "lifecycle-coverage");
    expect(lifecycle).toHaveLength(1);
    expect(num(lifecycle[0]?.reclaimable_bytes)).toBe(0);
    expect(detailsOf(lifecycle[0]!).uncovered_bytes).toBe(2345);

    const top = findings.filter((row) => row.analyzer === "top-consumers");
    expect(top[0]?.prefix).toBe("tiny/");
    expect(detailsOf(top[0]!).bytes).toBe(2000);
    expect(num(top[0]?.reclaimable_bytes)).toBe(0);
  });

  it("notifies the webhook when reclaimable bytes pass the threshold", () => {
    expect(hooks.length).toBeGreaterThan(0);
    const payload = hooks[0]?.payload as { reclaimableBytes?: number };
    expect(num(payload.reclaimableBytes)).toBeGreaterThanOrEqual(1);
    expect(hooks[0]?.url).toBe("https://example.test/hook");
  });

  it("blocks report-only plans, draft execution, and a bad confirmation", async () => {
    const posture = findings.find((row) => row.analyzer === "posture");
    const top = findings.find((row) => row.analyzer === "top-consumers");
    expect(posture).toBeTruthy();
    expect(top).toBeTruthy();
    await expectStatus(() => ws.createPlan("lab", [String(posture?.finding_id)], "ada"), 400);
    await expectStatus(() => ws.createPlan("lab", [String(top?.finding_id)], "ada"), 400);

    const old = findings.find((row) => row.analyzer === "old-data");
    const draftId = await ws.createPlan("lab", [String(old?.finding_id)], "ada");
    await expectStatus(() => ws.execute(draftId, "ada"), 409, /approve/i);
    expect(await store.head("lab", "archive/stale.txt")).not.toBeNull();

    const duplicates = findings.find((row) => row.analyzer === "duplicates");
    const nopeId = await ws.createPlan("lab", [String(duplicates?.finding_id)], "ada");
    await ws.dryRun(nopeId, "ada");
    await expectStatus(() => ws.approve(nopeId, "ada", "nope"), 400);
  });

  it("skips protected prefixes, changed objects, and object lock", async () => {
    await ws.updateBucket("lab", { writeEnabled: true, protectedPrefixes: ["archive/"] });
    const old = findings.find((row) => row.analyzer === "old-data");
    const protectedId = await ws.createPlan("lab", [String(old?.finding_id)], "ada");
    await ws.dryRun(protectedId, "ada");
    await ws.approve(protectedId, "ada", "lab");
    const protectedResult = await ws.execute(protectedId, "ada");
    expect(protectedResult.skipped).toBeGreaterThan(0);
    expect(protectedResult.done).toBe(0);
    const protectedPlan = await ws.getPlan(protectedId);
    const protectedItems = protectedPlan.items as Record<string, unknown>[];
    expect(protectedItems.every((item) => item.status === "skipped")).toBe(true);
    expect(protectedItems.some((item) => String(item.error).includes("Protected"))).toBe(true);
    expect(await store.head("lab", "archive/stale.txt")).not.toBeNull();

    await ws.updateBucket("lab", { writeEnabled: true, protectedPrefixes: [] });
    const duplicates = findings.find((row) => row.analyzer === "duplicates");
    const staleId = await ws.createPlan("lab", [String(duplicates?.finding_id)], "ada");
    await ws.dryRun(staleId, "ada");
    await ws.approve(staleId, "ada", "lab");
    const changed = store.objects.find((object) => object.key === "dup/b.txt" && object.isLatest);
    expect(changed).toBeTruthy();
    changed!.etag = "changed";
    const staleResult = await ws.execute(staleId, "ada");
    expect(staleResult.skipped).toBe(1);
    expect(staleResult.done).toBe(0);
    const stalePlan = await ws.getPlan(staleId);
    const staleItems = stalePlan.items as Record<string, unknown>[];
    expect(staleItems.map((item) => item.key)).toEqual(["dup/b.txt"]);
    expect(staleItems[0]?.status).toBe("skipped");
    expect(staleItems[0]?.error).toBe("Object changed since the index");
    expect(store.objects.find((object) => object.key === "dup/a.txt" && object.isLatest)?.etag).toBe("abc");
    expect(await store.head("lab", "dup/b.txt")).not.toBeNull();

    await ws.runAnalyzers("lab", "old-data", { days: 0 });
    const refreshed = await ws.listFindings("lab", "open");
    const logs = refreshed.find((row) => row.analyzer === "old-data" && row.prefix === "logs/");
    expect(logs).toBeTruthy();
    const locked = store.objects.find((object) => object.key === "logs/new.txt" && object.isLatest);
    expect(locked).toBeTruthy();
    locked!.objectLockMode = "GOVERNANCE";
    const lockId = await ws.createPlan("lab", [String(logs?.finding_id)], "ada");
    await ws.dryRun(lockId, "ada");
    await ws.approve(lockId, "ada", "lab");
    const lockResult = await ws.execute(lockId, "ada");
    expect(lockResult.skipped).toBe(1);
    const lockPlan = await ws.getPlan(lockId);
    const lockItems = lockPlan.items as Record<string, unknown>[];
    expect(lockItems.map((item) => item.key)).toEqual(["logs/new.txt"]);
    expect(lockItems[0]?.error).toBe("Object Lock or legal hold");
    expect(await store.head("lab", "logs/new.txt")).not.toBeNull();
  });

  it("refuses execution when writes are off and when the kill switch is on", async () => {
    await ws.updateBucket("lab", { writeEnabled: false, protectedPrefixes: [] });
    const duplicates = findings.find((row) => row.analyzer === "duplicates");
    const blockedId = await ws.createPlan("lab", [String(duplicates?.finding_id)], "ada");
    await ws.dryRun(blockedId, "ada");
    await ws.approve(blockedId, "ada", "lab");
    await expectStatus(() => ws.execute(blockedId, "ada"), 403, /Writes are off/);
    expect(await store.head("lab", "dup/b.txt")).not.toBeNull();
    expect(store.objects.find((object) => object.key === "dup/a.txt" && object.isLatest)?.etag).toBe("abc");

    await ws.updateBucket("lab", { writeEnabled: true, protectedPrefixes: [] });
    const killedId = await ws.createPlan("lab", [String(duplicates?.finding_id)], "ada");
    await ws.dryRun(killedId, "ada");
    await ws.approve(killedId, "ada", "lab");
    await ws.setSetting("kill_switch", "true");
    await expectStatus(() => ws.execute(killedId, "ada"), 409, /kill switch/i);
    expect(await store.head("lab", "dup/b.txt")).not.toBeNull();
    await ws.setSetting("kill_switch", "false");
  });

  it("keeps the secret out of connection and bucket rows", async () => {
    const secrets = readFileSync(join(dir, "secrets.json"), "utf8");
    expect(secrets).toContain(SECRET);
    const connections = await ws.listConnections();
    const buckets = await ws.listBuckets();
    const connectionSql = await ws.query("SELECT * FROM connections");
    const bucketSql = await ws.query("SELECT * FROM buckets");
    for (const value of [connections, buckets, connectionSql, bucketSql]) {
      expect(JSON.stringify(value)).not.toContain(SECRET);
    }
  });

  it("accepts read-only console SQL and rejects everything else", async () => {
    const selected = await ws.query("SELECT 1 AS n");
    expect(num(selected.rows[0]?.n)).toBe(1);
    await expect(ws.query("EXPLAIN SELECT 1")).resolves.toBeTruthy();
    await expect(ws.query("DESCRIBE SELECT 1 AS n")).resolves.toBeTruthy();
    await expectStatus(() => ws.query("INSERT INTO objects VALUES (1)"), 400);
    await expectStatus(() => ws.query("PRAGMA version"), 400);
    await expectStatus(() => ws.query("COPY (SELECT 1) TO 'x.csv'"), 400);
    await expectStatus(() => ws.query("SELECT 1; SELECT 2"), 400);
    await expectStatus(() => ws.query("SELECT * FROM read_csv('C:/Windows/win.ini')"), 400);
    await ws.db.read(async (conn) => {
      const safe = await assertSafeConsoleSql(conn, "SELECT 1 AS n");
      expect(safe.kind).toBe("select");
      await expect(assertSafeConsoleSql(conn, "PRAGMA version")).rejects.toBeInstanceOf(T4Error);
    });
  });

  it("loads an inventory parquet and can search the object", async () => {
    const parquet = join(dir, "inventory.parquet");
    await ws.db.write((conn) =>
      execute(
        conn,
        `COPY (
          SELECT 'inv/a.txt' AS key, 11 AS size, 'inv-etag' AS e_tag,
                 TIMESTAMP '2024-01-02 03:04:05' AS last_modified_date, true AS is_latest
        ) TO ${sqlLiteral(duckPath(parquet))} (FORMAT PARQUET)`,
      ),
    );
    await ws.saveBucket({ bucket: "inv", connectionId, writeEnabled: false, protectedPrefixes: [] });
    const loaded = await ws.indexInventory("inv", parquet, 1);
    expect(loaded.rows).toBe(1);
    const searched = await ws.search({ bucket: "inv", name: "inv/a.txt" });
    const rows = searched.rows as Array<{ key: string }>;
    expect(rows.some((row) => row.key === "inv/a.txt")).toBe(true);
  });

  it("previews a CSV object", async () => {
    const body = new TextEncoder().encode("a,b\n1,2\n");
    put({ key: "report.csv", size: body.byteLength, etag: "csv", versionId: "csv1", body });
    const preview = await ws.preview("lab", "report.csv");
    expect(preview.format).toBe("csv");
    expect(preview.rows).toHaveLength(1);
  });

  it("leaves the secret out of the duckdb file", async () => {
    await ws.db.write((conn) => execute(conn, "CHECKPOINT"));
    await ws.close();
    closed = true;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(databasePath));
    expect(text.includes(SECRET)).toBe(false);
  });
});

describe("versioned undo", () => {
  it("deletes the latest object without a version id and undo restores it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t4-undo-"));
    const store = new MemoryStore();
    store.versioning.set("lab", true);
    const staleAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    store.put({
      bucket: "lab",
      key: "archive/stale.txt",
      versionId: "s1",
      isLatest: true,
      isDeleteMarker: false,
      size: 80,
      lastModified: staleAt,
      etag: "s",
      storageClass: "STANDARD",
      isMultipart: false,
      checksumAlgo: null,
      encryption: "AES256",
      replication: null,
      itAccessTier: null,
      objectLockMode: null,
      legalHold: false,
      body: Uint8Array.of(1),
    });
    const ws = await Workspace.open({
      dataDir: dir,
      databasePath: join(dir, "t4.duckdb"),
      storeFor: () => store,
    });
    try {
      const connectionId = await ws.saveConnection(connection);
      await ws.saveBucket({ bucket: "lab", connectionId, writeEnabled: true, protectedPrefixes: [] });
      await ws.indexBucket("lab");
      await ws.runAnalyzers("lab", "old-data");
      const findings = await ws.listFindings("lab");
      const old = findings.find((row) => row.analyzer === "old-data" && row.prefix === "archive/");
      expect(old).toBeTruthy();
      const planId = await ws.createPlan("lab", [String(old?.finding_id)], "ada");
      await ws.dryRun(planId, "ada");
      await ws.approve(planId, "ada", "lab");
      const executed = await ws.execute(planId, "ada");
      expect(executed.done).toBe(1);
      expect(await store.head("lab", "archive/stale.txt")).toBeNull();
      expect(await ws.undo(planId, "ada")).toBe(1);
      expect(await store.head("lab", "archive/stale.txt")).not.toBeNull();
      const audit = await ws.audit("lab");
      expect(audit.some((row) => row.actor === "ada")).toBe(true);
      const actions = new Set(audit.map((row) => String(row.action)));
      for (const action of ["plan.create", "plan.dry_run", "plan.approve", "plan.execute", "plan.undo"]) {
        expect(actions.has(action)).toBe(true);
      }
    } finally {
      await ws.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("store, schedule, and keys", () => {
  it("reports lifecycle as not supported", async () => {
    const store = new MemoryStore();
    store.unsupported.add("lifecycle");
    store.buckets.add("lab");
    const capabilities = await probeStore(store, "lab");
    expect(capabilities.lifecycle).toBe("not_supported");
  });

  it("discovers an analyzer directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t4-analyzers-"));
    const analyzersDir = join(dir, "analyzers");
    const folder = join(analyzersDir, "custom-bytes");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "manifest.yaml"),
      ["id: custom-bytes", "title: Custom bytes", "summary: Custom", "group: custom", "severity: low", "action: report", "params: {}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(folder, "find.sql"),
      "SELECT '' AS prefix, 'low' AS severity, 0 AS reclaimable_bytes, '{\"ok\":true}' AS details\n",
      "utf8",
    );
    const ws = await Workspace.open({
      dataDir: dir,
      databasePath: ":memory:",
      analyzersDir,
      storeFor: () => new MemoryStore(),
    });
    try {
      expect(ws.listAnalyzers().some((analyzer) => analyzer.id === "custom-bytes")).toBe(true);
    } finally {
      await ws.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses cron fields and matches UTC minutes", () => {
    expect(() => parseCron("bad")).toThrow();
    for (let minute = 0; minute < 60; minute += 1) {
      const at = new Date(Date.UTC(2024, 0, 2, 4, minute, 10));
      expect(cronMatches("*/15 * * * *", at)).toBe(minute % 15 === 0);
    }
    expect(cronMatches("0 0 * * *", new Date(Date.UTC(2024, 5, 1, 0, 0, 0)))).toBe(true);
    expect(cronMatches("0 0 * * *", new Date(Date.UTC(2024, 5, 1, 0, 30, 0)))).toBe(false);
  });

  it("derives keys and matches protected prefixes on a boundary", () => {
    const derived = deriveKey("a/b/c.TXT");
    expect(derived.parentPrefix).toBe("a/b/");
    expect(derived.name).toBe("c.TXT");
    expect(derived.ext).toBe("txt");
    expect(isProtected("archive/x", ["archive/"])).toBe(true);
    expect(isProtected("archives/x", ["archive/"])).toBe(false);
  });
});
