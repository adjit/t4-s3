import { randomUUID } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { execute, queryAll, queryOne, type Database } from "../duck/database.js";
import { T4Error } from "../errors.js";
import { isProtected } from "../keys.js";
import { asNumber, asString, parseJson } from "../plain.js";
import type { Analyzer } from "../analyzers/runner.js";
import { bindUsed, scalarParams } from "../analyzers/runner.js";
import type { ObjectStore } from "../store/types.js";

export interface BucketPolicy {
  bucket: string;
  writeEnabled: boolean;
  protectedPrefixes: string[];
  planSizeCap: number;
  confirmMin: number;
}

const transitions: Record<string, string[]> = {
  draft: ["dry_run", "cancelled"],
  dry_run: ["approved", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["done", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

export async function createPlan(
  db: Database,
  analyzers: Analyzer[],
  input: { bucket: string; findingIds: string[]; actor: string; policy: BucketPolicy },
): Promise<string> {
  return db.write(async (conn) => {
    if (input.findingIds.length === 0) throw new T4Error(400, "Select at least one finding");
    const findings = (await queryAll(conn, `SELECT * FROM findings WHERE bucket = $bucket`, { bucket: input.bucket }))
      .filter((row) => input.findingIds.includes(String(row.finding_id)));
    if (findings.length !== input.findingIds.length) throw new T4Error(404, "One or more findings were not found");
    const analyzerIds = new Set(findings.map((row) => String(row.analyzer)));
    const selected = analyzers.filter((analyzer) => analyzerIds.has(analyzer.id));
    const actions = new Set(selected.map((analyzer) => analyzer.action));
    if (actions.size !== 1) throw new T4Error(400, "Select findings that use the same action");
    const action = [...actions][0]!;
    if (action === "report") throw new T4Error(400, "These findings are report only");
    const items: Array<Record<string, unknown>> = [];
    for (const finding of findings) {
      const analyzer = selected.find((item) => item.id === String(finding.analyzer));
      if (!analyzer?.itemsSql) throw new T4Error(400, `${finding.analyzer} has no action items`);
      const details = parseJson(finding.details);
      const available = bindUsed(analyzer.itemsSql, {
        bucket: input.bucket,
        prefix: String(finding.prefix ?? ""),
        ...scalarParams(details),
        ...scalarParams(details.params),
      });
      items.push(...(await queryAll(conn, analyzer.itemsSql, available)));
    }
    if (items.length > input.policy.planSizeCap) {
      throw new T4Error(400, `This plan has ${items.length} objects, above the cap of ${input.policy.planSizeCap}`);
    }
    const planId = randomUUID();
    await execute(
      conn,
      `INSERT INTO action_plans
       (plan_id, bucket, created_by, action_type, params, status, object_count, bytes, created_at)
       VALUES ($plan_id, $bucket, $actor, $action, $params, 'draft', $count, 0, current_timestamp)`,
      {
        plan_id: planId,
        bucket: input.bucket,
        actor: input.actor,
        action,
        params: JSON.stringify({ findingIds: input.findingIds }),
        count: items.length,
      },
    );
    for (const item of items) {
      await execute(
        conn,
        `INSERT INTO action_plan_items
         (item_id, plan_id, bucket, key, version_id, upload_id, expected_etag, expected_last_modified, size, status)
         VALUES ($item_id, $plan_id, $bucket, $key, $version_id, $upload_id, $etag, CAST($modified AS TIMESTAMP), $size, 'pending')`,
        {
          item_id: randomUUID(),
          plan_id: planId,
          bucket: input.bucket,
          key: String(item.key),
          version_id: asString(item.version_id),
          upload_id: asString(item.upload_id),
          etag: asString(item.etag),
          modified: asString(item.last_modified),
          size: item.size == null ? null : asNumber(item.size),
        },
      );
    }
    await audit(conn, input.actor, "plan.create", input.bucket, { planId, action, objects: items.length }, { status: "draft" });
    return planId;
  });
}

export async function dryRunPlan(db: Database, planId: string, actor: string): Promise<Record<string, unknown>> {
  return db.write(async (conn) => {
    const plan = await mustPlan(conn, planId);
    assertTransition(String(plan.status), "dry_run");
    const items = await queryAll(conn, "SELECT * FROM action_plan_items WHERE plan_id = $plan_id", { plan_id: planId });
    const bytes = items.reduce((sum, item) => sum + asNumber(item.size), 0);
    const requests = String(plan.action_type) === "abort_multipart" ? items.length : Math.ceil(items.length / 1000);
    const sample = items.slice(0, 8).map((item) => ({
      key: item.key,
      size: item.size,
      versionId: item.version_id,
    }));
    await execute(
      conn,
      `UPDATE action_plans
       SET status = 'dry_run', object_count = $count, bytes = $bytes, sample = $sample,
           request_estimate = $requests, dry_run_at = current_timestamp
       WHERE plan_id = $plan_id`,
      { count: items.length, bytes, sample: JSON.stringify(sample), requests, plan_id: planId },
    );
    await audit(conn, actor, "plan.dry_run", String(plan.bucket), { planId }, { objects: items.length, bytes, requests });
    return { objects: items.length, bytes, requests, sample };
  });
}

export async function approvePlan(
  db: Database,
  planId: string,
  actor: string,
  confirmation: string,
  policy: BucketPolicy,
): Promise<void> {
  await db.write(async (conn) => {
    const plan = await mustPlan(conn, planId);
    assertTransition(String(plan.status), "approved");
    const count = asNumber(plan.object_count);
    const action = String(plan.action_type);
    const needsName = action === "delete" || action === "abort_multipart" || count > policy.confirmMin;
    if (needsName && confirmation !== policy.bucket) {
      throw new T4Error(400, "Type the bucket name to approve this plan");
    }
    await execute(
      conn,
      `UPDATE action_plans SET status = 'approved', approved_by = $actor, approved_at = current_timestamp WHERE plan_id = $plan_id`,
      { actor, plan_id: planId },
    );
    await audit(conn, actor, "plan.approve", policy.bucket, { planId, confirmation: "matched" }, { status: "approved" });
  });
}

export async function cancelPlan(db: Database, planId: string, actor: string): Promise<void> {
  await db.write(async (conn) => {
    const plan = await mustPlan(conn, planId);
    assertTransition(String(plan.status), "cancelled");
    await execute(conn, `UPDATE action_plans SET status = 'cancelled' WHERE plan_id = $plan_id`, { plan_id: planId });
    await audit(conn, actor, "plan.cancel", String(plan.bucket), { planId }, { status: "cancelled" });
  });
}

export async function executePlan(
  db: Database,
  store: ObjectStore,
  planId: string,
  actor: string,
  policy: BucketPolicy,
): Promise<{ done: number; skipped: number; failed: number }> {
  const plan = await db.read((conn) => mustPlan(conn, planId));
  const status = String(plan.status);
  if (status !== "approved" && status !== "running") {
    throw new T4Error(409, `Cannot execute a plan from ${status}. Dry-run and approve it first.`);
  }
  if (!policy.writeEnabled) throw new T4Error(403, "Writes are off for this bucket. Enable them in Settings first.");
  const killed = await db.read((conn) => queryOne(conn, "SELECT value FROM settings WHERE key = 'kill_switch'"));
  if (killed?.value === "true") throw new T4Error(409, "The kill switch is on. Execution is stopped.");
  await db.write(async (conn) => {
    await execute(conn, `UPDATE action_plans SET status = 'running' WHERE plan_id = $plan_id`, { plan_id: planId });
  });
  const items = await db.read((conn) =>
    queryAll(conn, `SELECT * FROM action_plan_items WHERE plan_id = $plan_id AND status = 'pending'`, { plan_id: planId }),
  );
  let done = 0;
  let skipped = 0;
  let failed = 0;
  try {
    if (String(plan.action_type) === "abort_multipart") {
      for (const item of items) {
        const key = String(item.key);
        if (isProtected(key, policy.protectedPrefixes)) {
          await mark(db, String(item.item_id), "skipped", "Protected prefix");
          skipped += 1;
          continue;
        }
        await store.abortMultipart(policy.bucket, key, String(item.upload_id ?? ""));
        await mark(db, String(item.item_id), "done", null, { aborted: true });
        done += 1;
      }
    } else {
      const ready: Array<Record<string, unknown>> = [];
      for (const item of items) {
        const key = String(item.key);
        if (isProtected(key, policy.protectedPrefixes)) {
          await mark(db, String(item.item_id), "skipped", "Protected prefix");
          skipped += 1;
          continue;
        }
        const head = await store.head(policy.bucket, key, asString(item.version_id));
        if (!head) {
          await mark(db, String(item.item_id), "skipped", "Object is gone");
          skipped += 1;
          continue;
        }
        if (head.objectLockMode || head.legalHold) {
          await mark(db, String(item.item_id), "skipped", "Object Lock or legal hold");
          skipped += 1;
          continue;
        }
        if (!sameEtag(asString(item.expected_etag), head.etag) || !sameTime(asString(item.expected_last_modified), head.lastModified)) {
          await mark(db, String(item.item_id), "skipped", "Object changed since the index");
          skipped += 1;
          continue;
        }
        ready.push(item);
      }
      for (let offset = 0; offset < ready.length; offset += 1000) {
        const batch = ready.slice(offset, offset + 1000);
        const result = await store.deleteObjects(
          policy.bucket,
          batch.map((item) => ({ key: String(item.key), versionId: asString(item.version_id) })),
        );
        const deletedByKey = new Map(result.deleted.map((item) => [`${item.key}\0${item.versionId ?? ""}`, item]));
        for (const item of batch) {
          const version = asString(item.version_id) ?? "";
          const deleted = result.deleted.find((entry) => entry.key === String(item.key) && (entry.versionId ?? "") === version)
            ?? deletedByKey.get(`${item.key}\0${version}`)
            ?? result.deleted.find((entry) => entry.key === String(item.key));
          const error = result.errors.find((entry) => entry.key === String(item.key));
          if (deleted && !error) {
            await mark(db, String(item.item_id), "done", null, { deleteMarkerVersionId: deleted.deleteMarkerVersionId });
            done += 1;
          } else {
            await mark(db, String(item.item_id), "failed", error?.message ?? "Delete failed");
            failed += 1;
          }
        }
        await db.write((conn) =>
          audit(conn, actor, "plan.execute.batch", policy.bucket, { planId, offset, count: batch.length }, {
            deleted: result.deleted.length,
            errors: result.errors,
          }),
        );
      }
    }
    await db.write(async (conn) => {
      await execute(conn, `UPDATE action_plans SET status = 'done' WHERE plan_id = $plan_id`, { plan_id: planId });
      await audit(conn, actor, "plan.execute", policy.bucket, { planId }, { done, skipped, failed });
    });
    return { done, skipped, failed };
  } catch (error) {
    await db.write(async (conn) => {
      await execute(
        conn,
        `UPDATE action_plans SET status = 'failed', error = $error WHERE plan_id = $plan_id`,
        { plan_id: planId, error: error instanceof Error ? error.message : String(error) },
      );
    });
    throw error;
  }
}

export async function undoPlan(db: Database, store: ObjectStore, planId: string, actor: string, policy: BucketPolicy): Promise<number> {
  if (!policy.writeEnabled) throw new T4Error(403, "Writes are off for this bucket");
  const plan = await db.read((conn) => mustPlan(conn, planId));
  if (String(plan.status) !== "done" || String(plan.action_type) !== "delete") {
    throw new T4Error(409, "Undo is available after a delete plan finishes");
  }
  const items = await db.read((conn) =>
    queryAll(conn, `SELECT * FROM action_plan_items WHERE plan_id = $plan_id AND status = 'done'`, { plan_id: planId }),
  );
  const markers = items.flatMap((item) => {
    const marker = asString(parseJson(item.result).deleteMarkerVersionId);
    return marker ? [{ key: String(item.key), versionId: marker, itemId: String(item.item_id) }] : [];
  });
  if (markers.length === 0) throw new T4Error(409, "This plan did not record delete markers, so it cannot be undone");
  const result = await store.deleteObjects(
    policy.bucket,
    markers.map((item) => ({ key: item.key, versionId: item.versionId })),
  );
  await db.write(async (conn) => {
    await audit(conn, actor, "plan.undo", policy.bucket, { planId }, { removedMarkers: result.deleted.length, errors: result.errors });
  });
  return result.deleted.length;
}

async function mustPlan(conn: DuckDBConnection, planId: string) {
  const plan = await queryOne(conn, "SELECT * FROM action_plans WHERE plan_id = $plan_id", { plan_id: planId });
  if (!plan) throw new T4Error(404, "Plan not found");
  return plan;
}

function assertTransition(from: string, to: string): void {
  if (!transitions[from]?.includes(to)) throw new T4Error(409, `Cannot move a plan from ${from} to ${to}`);
}

async function mark(db: Database, itemId: string, status: string, error: string | null, result?: Record<string, unknown>): Promise<void> {
  await db.write((conn) =>
    execute(
      conn,
      `UPDATE action_plan_items
       SET status = $status, error = $error, result = $result, executed_at = current_timestamp
       WHERE item_id = $item_id`,
      { status, error, result: result ? JSON.stringify(result) : null, item_id: itemId },
    ),
  );
}

async function audit(
  conn: DuckDBConnection,
  actor: string,
  action: string,
  bucket: string,
  params: unknown,
  result: unknown,
): Promise<void> {
  await execute(
    conn,
    `INSERT INTO audit_log (id, ts, actor, action, bucket, params, result)
     VALUES ($id, current_timestamp, $actor, $action, $bucket, $params, $result)`,
    {
      id: randomUUID(),
      actor,
      action,
      bucket,
      params: JSON.stringify(params),
      result: JSON.stringify(result),
    },
  );
}

function sameEtag(expected: string | null, actual: string | null): boolean {
  if (!expected) return true;
  return expected.replaceAll('"', "") === (actual ?? "").replaceAll('"', "");
}

function sameTime(expected: string | null, actual: Date | null): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const left = Date.parse(expected.includes("T") ? expected : `${expected.replace(" ", "T")}Z`);
  return Math.abs(left - actual.getTime()) < 2000;
}
