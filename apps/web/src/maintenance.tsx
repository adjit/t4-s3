import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "./api";
import { go, openInQuery, useBucket } from "./ctx";
import {
  asArray,
  asRecord,
  durationWords,
  elapsed,
  formatBytes,
  formatCount,
  num,
  plural,
  relativeDate,
  sqlString,
  text,
  type Row,
} from "./format";
import { Icon } from "./icons";
import { Crumbs, Empty, ErrorText, StatusBadge } from "./ui";

interface Analyzer { id: string; title: string; summary: string; group: string; action: string }

function useAnalyzers() {
  return useQuery({
    queryKey: ["analyzers"],
    queryFn: async () => (await api<Row[]>("/api/analyzers")).map((row): Analyzer => ({
      id: text(row.id),
      title: text(row.title),
      summary: text(row.summary),
      group: text(row.group),
      action: text(row.action),
    })),
    staleTime: Infinity,
  });
}

const GROUP_LABEL: Record<string, string> = { space: "Space", iceberg: "Iceberg", posture: "Posture", custom: "Custom" };

function affected(details: Row): string {
  for (const [key, word] of [["objects", "object"], ["uncovered_objects", "object"], ["versions", "version"], ["uploads", "upload"], ["keys", "key"], ["count", "item"], ["files", "file"]] as const) {
    if (details[key] != null) return plural(num(details[key]), word);
  }
  return "—";
}

function findingLine(row: Row, details: Row): string {
  const where = text(row.prefix) || "Whole bucket";
  const bits: string[] = [];
  if (details.days != null) bits.push(`no writes in ${formatCount(details.days)} days`);
  if (details.newest != null && details.days == null) bits.push(`last write ${relativeDate(details.newest).toLowerCase()}`);
  if (details.versions != null) bits.push(`${formatCount(details.versions)} older versions`);
  if (details.delete_markers != null && num(details.delete_markers) > 0) bits.push(`${formatCount(details.delete_markers)} delete markers`);
  if (details.median_size != null) bits.push(`median size ${formatBytes(details.median_size)}`);
  if (details.uncovered_bytes != null) bits.push(`${formatBytes(details.uncovered_bytes)} not covered by a lifecycle rule`);
  if (details.bytes != null && details.objects != null && bits.length === 0) bits.push(formatBytes(details.bytes));
  return [where, ...bits].join(" · ");
}

export function Maintenance(): ReactNode {
  const { bucket } = useBucket();
  const client = useQueryClient();
  const analyzers = useAnalyzers();
  const [picked, setPicked] = useState<string[]>([]);
  const [tab, setTab] = useState<string>("all");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const all = useQuery({
    queryKey: ["findings", bucket, "all"],
    queryFn: () => api<Row[]>(`/api/findings?bucket=${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
  const summary = useQuery({
    queryKey: ["summary", bucket],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });

  if (!bucket) return <div className="page"><div className="card"><Empty title="Connect a store in Settings" action="Open Settings" href="/settings" /></div></div>;

  const byId = new Map((analyzers.data ?? []).map((analyzer) => [analyzer.id, analyzer]));
  const rows = all.data ?? [];
  const open = rows.filter((row) => text(row.status) === "open");
  const ignored = rows.filter((row) => text(row.status) === "ignored");
  const groupOf = (row: Row): string => byId.get(text(row.analyzer))?.group ?? "space";
  const groups = [...new Set(open.map(groupOf))].sort();
  const visible = tab === "all" ? open : tab === "ignored" ? ignored : open.filter((row) => groupOf(row) === tab);
  const reclaimable = open.reduce((sum, row) => sum + num(row.reclaimable_bytes), 0);
  const lastRun = rows.reduce<string | null>((latest, row) => {
    const at = text(row.created_at);
    return !latest || at > latest ? at : latest;
  }, null);
  const pickedRows = open.filter((row) => picked.includes(text(row.finding_id)));
  const pickedBytes = pickedRows.reduce((sum, row) => sum + num(row.reclaimable_bytes), 0);
  const totals = asRecord(summary.data?.totals);

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ["findings", bucket] });
    await client.invalidateQueries({ queryKey: ["summary", bucket] });
  };
  const run = async (): Promise<void> => {
    setError(null);
    try {
      const job = await api<{ jobId: string }>("/api/analyzers/run", { method: "POST", body: JSON.stringify({ bucket }) });
      setNote(`Analyzers are running as a background job (${job.jobId.slice(0, 8)}). Findings refresh when it finishes.`);
      window.setTimeout(() => void refresh(), 1500);
      window.setTimeout(() => void refresh(), 5000);
    } catch (caught) {
      setError(caught);
    }
  };
  const setStatus = async (id: string, status: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/findings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setPicked((current) => current.filter((item) => item !== id));
      await refresh();
    } catch (caught) {
      setError(caught);
    }
  };
  const plan = async (): Promise<void> => {
    setError(null);
    try {
      const created = await api<{ planId: string }>("/api/plans", { method: "POST", body: JSON.stringify({ bucket, findingIds: picked }) });
      setPicked([]);
      await client.invalidateQueries({ queryKey: ["plans"] });
      go(`/plans/${created.planId}`);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Maintenance</h1>
          <p>{lastRun ? `Last analyzed ${relativeDate(lastRun).toLowerCase()} for ${bucket}.` : `Not analyzed yet for ${bucket}.`}</p>
          <p className="lede">Analyzers read the local index and flag space you could reclaim: old data, old versions, duplicates, unfinished uploads. Select findings to build a plan; nothing changes until you approve it.</p>
        </div>
        <button className="btn" type="button" onClick={() => void run()}>{lastRun ? "Analyze again" : "Run analyzers"}</button>
      </div>

      <div className="kpis">
        <div className="card kpi hot"><span>Space you could reclaim</span><strong>{formatBytes(reclaimable)}</strong></div>
        <div className="card kpi"><span>Open findings</span><strong>{formatCount(open.length)}</strong></div>
        <div className="card kpi"><span>Total storage</span><strong>{formatBytes(totals.bytes)}</strong></div>
        <div className="card kpi">
          <span>Index last updated</span>
          <strong>{summary.data?.indexedAt ? (num(summary.data.indexAgeSeconds) < 90 ? "Just now" : `${durationWords(num(summary.data.indexAgeSeconds))} ago`) : "Not indexed"}</strong>
        </div>
      </div>

      {note ? <p className="note info"><span>{note}</span></p> : null}
      <ErrorText error={error ?? all.error} />

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : undefined} onClick={() => setTab("all")}>All ({open.length})</button>
        {groups.map((group) => (
          <button key={group} type="button" role="tab" aria-selected={tab === group} className={tab === group ? "on" : undefined} onClick={() => setTab(group)}>
            {GROUP_LABEL[group] ?? group} ({open.filter((row) => groupOf(row) === group).length})
          </button>
        ))}
        <button type="button" role="tab" aria-selected={tab === "ignored"} className={tab === "ignored" ? "on" : undefined} onClick={() => setTab("ignored")}>Ignored ({ignored.length})</button>
      </div>

      {picked.length > 0 ? (
        <div className="selbar">
          <span><strong>{plural(picked.length, "finding")} selected</strong>, freeing about {formatBytes(pickedBytes)}</span>
          <div className="row">
            <button className="btn" type="button" onClick={() => setPicked([])}>Clear selection</button>
            <button className="btn pri" type="button" onClick={() => void plan()}>Create plan from selection</button>
          </div>
        </div>
      ) : null}

      <section className="card">
        {all.isLoading ? (
          <div className="empty">Loading…</div>
        ) : visible.length === 0 ? (
          tab === "ignored" ? (
            <Empty title="No ignored findings" />
          ) : (
            <Empty
              title={lastRun ? "Nothing to clean up right now" : "Run analyzers to look for reclaimable space"}
              body="Analyzers read the index and live listings. They never change anything in the bucket."
              action={lastRun ? "Analyze again" : "Run analyzers"}
              onClick={() => void run()}
            />
          )
        ) : (
          <div className="tw">
            <table className="tbl tall">
              <colgroup>
                <col style={{ width: 64 }} />
                <col />
                <col style={{ width: 110 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr>
                  <th><span className="sr-only">Select</span></th>
                  <th>Finding</th>
                  <th>Type</th>
                  <th className="num">Affected</th>
                  <th className="num">Could free</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.flatMap((row) => {
                  const id = text(row.finding_id);
                  const analyzer = byId.get(text(row.analyzer));
                  const details = asRecord(row.details);
                  const reportOnly = analyzer ? analyzer.action === "report" : num(row.reclaimable_bytes) === 0;
                  const isPicked = picked.includes(id);
                  const group = analyzer?.group ?? "space";
                  const lines = [
                    <tr key={id} className={isPicked ? "on" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${analyzer?.title ?? text(row.analyzer)}`}
                          disabled={reportOnly || tab === "ignored"}
                          checked={isPicked}
                          onChange={() => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
                        />
                      </td>
                      <td>
                        <div className="ti">
                          <strong>{analyzer?.title ?? text(row.analyzer)}</strong>
                          <span>{findingLine(row, details)}{reportOnly ? " · report only" : ""}</span>
                        </div>
                      </td>
                      <td><span className={`badge ${group === "iceberg" ? "b-ice" : group === "posture" ? "b-warn" : "b-n"}`}>{GROUP_LABEL[group] ?? group}</span></td>
                      <td className="num">{affected(details)}</td>
                      <td className="num sv">{reportOnly ? "Not applicable" : formatBytes(row.reclaimable_bytes)}</td>
                      <td>
                        <div className="row" style={{ justifyContent: "flex-end", gap: 14, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                          <button className="link" type="button" onClick={() => setExpanded(expanded === id ? null : id)}>{expanded === id ? "Hide details" : "See details"}</button>
                          {tab === "ignored"
                            ? <button className="link" type="button" onClick={() => void setStatus(id, "open")}>Restore</button>
                            : <button className="link" type="button" onClick={() => void setStatus(id, "ignored")}>Ignore</button>}
                        </div>
                      </td>
                    </tr>,
                  ];
                  if (expanded === id) {
                    lines.push(
                      <tr key={`${id}-details`} className={isPicked ? "on" : undefined}>
                        <td />
                        <td colSpan={5} style={{ paddingBottom: 16 }}>
                          <div className="stack">
                            {analyzer?.summary ? <p className="mut">{analyzer.summary}</p> : null}
                            <pre className="sql">{JSON.stringify(details, null, 2)}</pre>
                            {text(row.prefix) ? (
                              <div className="row">
                                <button
                                  className="btn sm"
                                  type="button"
                                  onClick={() => openInQuery(`SELECT key, size, last_modified, storage_class\nFROM objects\nWHERE bucket = ${sqlString(bucket)}\n  AND starts_with(key, ${sqlString(text(row.prefix))})\nORDER BY size DESC\nLIMIT 1000`)}
                                >
                                  Open in Query
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>,
                    );
                  }
                  return lines;
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="small">Report-only findings contribute zero bytes and cannot be planned. Nothing is deleted until a plan is approved and run.</p>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  delete: "Delete objects",
  delete_versions: "Delete old versions",
  abort_multipart: "Abort incomplete uploads",
};

function actionLabel(action: unknown): string {
  const value = text(action);
  return ACTION_LABEL[value] ?? (value ? value.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase()) : "Plan");
}

export function Plans(): ReactNode {
  const { bucket } = useBucket();
  const plans = useQuery({
    queryKey: ["plans", bucket],
    queryFn: () => api<Row[]>(`/api/plans?bucket=${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
  if (!bucket) return <div className="page"><div className="card"><Empty title="Connect a store in Settings" action="Open Settings" href="/settings" /></div></div>;
  const rows = plans.data ?? [];
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Plans</h1>
          <p>A plan is a list of changes built from findings. It goes through a dry run (count only), your approval (type the bucket name), then the run. Every step is audited.</p>
        </div>
        <button className="btn" type="button" onClick={() => go("/maintenance")}>New plan from findings</button>
      </div>
      <ErrorText error={plans.error} />
      <section className="card">
        {plans.isLoading ? <div className="empty">Loading…</div> : rows.length === 0 ? (
          <Empty title="No plans yet" body="Create one from Maintenance. A plan is a dry run until you approve it." action="Open Maintenance" href="/maintenance" />
        ) : (
          <div className="tw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Status</th>
                  <th className="num">Objects</th>
                  <th className="num">Data</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const id = text(row.plan_id);
                  return (
                    <tr key={id} className="click" onClick={() => go(`/plans/${id}`)}>
                      <td>
                        <div className="nm">
                          <Icon name="list" />
                          <div className="ti">
                            <a className="name" href={`/plans/${id}`} onClick={(event) => { event.preventDefault(); go(`/plans/${id}`); }}>{actionLabel(row.action_type)}</a>
                            <span>by {text(row.created_by) || "unknown"} · {id.slice(0, 8)}</span>
                          </div>
                        </div>
                      </td>
                      <td><StatusBadge status={row.status} /></td>
                      <td className="num">{formatCount(row.object_count)}</td>
                      <td className="num">{formatBytes(row.bytes)}</td>
                      <td>{relativeDate(row.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const STEPS = ["Select findings", "Dry run", "Approve", "Run", "Review results"];

export function PlanDetail({ id }: { id: string }): ReactNode {
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const plan = useQuery({ queryKey: ["plan", id], queryFn: () => api<Row>(`/api/plans/${encodeURIComponent(id)}`), enabled: Boolean(id) });
  const status = text(plan.data?.status);
  const bucket = text(plan.data?.bucket);
  const bucketRow = useQuery({
    queryKey: ["summary", bucket],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
  // Step index of the step the user is on now.
  const step = status === "draft" ? 1 : status === "dry_run" ? 2 : status === "approved" ? 3 : status === "running" ? 3 : 4;
  const terminal = ["done", "failed", "cancelled"].includes(status);
  const nameOk = confirmation === bucket && bucket !== "";
  const action = text(plan.data?.action_type);
  const permanent = action !== "abort_multipart";
  const params = asRecord(plan.data?.params);
  const sample = asArray(plan.data?.sample);
  const items = asArray(plan.data?.items);
  const sampleRows = sample.length ? sample : items.slice(0, 8);
  const protectedPrefixes = (bucketRow.data?.protected_prefixes as string[] | undefined) ?? [];
  const writeEnabled = bucketRow.data?.write_enabled === true;
  const indexAge = num(bucketRow.data?.indexAgeSeconds);

  const act = async (path: string, body?: unknown): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const response = await api<Row>(`/api/plans/${encodeURIComponent(id)}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      if (path === "execute") setResult(`${formatCount(response.done)} done, ${formatCount(response.skipped)} skipped, ${formatCount(response.failed)} failed.`);
      if (path === "undo") setResult(`${formatCount(response.undone)} delete markers removed.`);
      if (path === "dry-run") setResult(`Dry run finished: ${plural(num(response.objects), "object")}, ${formatBytes(response.bytes)}, about ${plural(num(response.requests), "request")}.`);
      if (path === "approve") setResult("Plan approved. Type the bucket name again to run it.");
      if (path === "approve") setConfirmation("");
      await client.invalidateQueries({ queryKey: ["plan", id] });
      await client.invalidateQueries({ queryKey: ["plans"] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const stepClass = (index: number): string => {
    if (status === "failed" && index === 3) return "fail";
    if (status === "cancelled") return index < step ? "done" : "";
    if (index < step || (index === 4 && status === "done")) return "done";
    if (index === step) return "cur";
    return "";
  };
  const stepTag = (index: number): string => {
    const cls = stepClass(index);
    if (cls === "fail") return "Failed";
    if (cls === "done") return "Done";
    if (cls === "cur") return "You are here";
    if (index === STEPS.length - 1) return "Last";
    return "Next";
  };

  return (
    <>
      <div className="col">
        <Crumbs items={[{ label: "Plans", href: "/plans" }, { label: `Plan ${id.slice(0, 8)}` }]} />
        <div className="stack" style={{ gap: 4 }}>
          <h1>{actionLabel(action)}{bucket ? ` in ${bucket}` : ""}</h1>
          <p className="mut">
            Created {relativeDate(plan.data?.created_at).toLowerCase()} by {text(plan.data?.created_by) || "unknown"}. Bucket: {bucket || "—"}. Status: <StatusBadge status={status} />
          </p>
        </div>
        <ol className="steps">
          {STEPS.map((label, index) => (
            <li key={label} className={stepClass(index) || undefined}>
              <span>{stepTag(index)}</span>
              <strong>{index + 1}. {label}</strong>
            </li>
          ))}
        </ol>
        <ErrorText error={plan.error} />
        {plan.data?.error ? <p className="warn">{text(plan.data.error)}</p> : null}

        <section className="card sec">
          <h2>What will happen</h2>
          <div className="act">
            <div className="tx">
              <h3>{actionLabel(action)}{text(params.prefix) ? ` in ${text(params.prefix)}` : ""}</h3>
              <p>{plural(num(plan.data?.object_count), action === "abort_multipart" ? "upload" : "object")} ({formatBytes(plan.data?.bytes)}) {num(plan.data?.object_count) === 1 ? "is" : "are"} in this plan.</p>
              <p className="small">
                {permanent
                  ? <><span className="badge b-bad">Permanent</span> On a versioned bucket a delete adds a delete marker that Undo can remove. Deleting versions cannot be undone.</>
                  : <><span className="badge b-bad">Permanent</span> Incomplete uploads cannot be read, so no usable data is lost.</>}
              </p>
            </div>
            <span className="sv">Frees {formatBytes(plan.data?.bytes)}</span>
          </div>
        </section>

        <section className="card sec">
          <h2>Dry run results</h2>
          {plan.data?.dry_run_at ? (
            <>
              <dl className="res">
                <div><dt>Objects affected</dt><dd>{formatCount(plan.data?.object_count)}</dd></div>
                <div><dt>Data affected</dt><dd>{formatBytes(plan.data?.bytes)}</dd></div>
                <div><dt>Requests needed</dt><dd>About {formatCount(plan.data?.request_estimate)}</dd></div>
                <div><dt>Dry run</dt><dd>{relativeDate(plan.data?.dry_run_at)}</dd></div>
              </dl>
            </>
          ) : (
            <p className="mut">Not run yet. A dry run counts what the plan would touch without changing anything.</p>
          )}
          {sampleRows.length ? (
            <div className="tw">
              <table className="tbl">
                <colgroup><col /><col style={{ width: 110 }} /><col style={{ width: 140 }} /></colgroup>
                <thead><tr><th>Sample of affected objects</th><th className="num">Size</th><th className="num">Age</th></tr></thead>
                <tbody>
                  {sampleRows.map((item, index) => (
                    <tr key={`${text(item.key)}-${index}`}>
                      <td><code style={{ overflowWrap: "anywhere" }}>{text(item.key)}{item.versionId || item.version_id ? " (older version)" : item.upload_id ? " (incomplete upload)" : ""}</code></td>
                      <td className="num">{formatBytes(item.size)}</td>
                      <td className="num">{item.expected_last_modified ? elapsed(item.expected_last_modified) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {bucket ? (
            <div>
              <button className="link" type="button" onClick={() => openInQuery(`SELECT key, version_id, upload_id, size, status, error\nFROM action_plan_items\nWHERE plan_id = ${sqlString(id)}\nORDER BY key`)}>
                {num(plan.data?.object_count) === 1 ? "Open this item in Query" : `Open all ${plural(num(plan.data?.object_count), "item")} in Query`}
              </button>
            </div>
          ) : null}
        </section>

        <section className="card sec">
          <h2>Safety checks</h2>
          <ul className="chk">
            <li>
              <Icon name="check" />
              Each object is re-checked right before it changes{indexAge ? `, because the index is ${durationWords(indexAge)} old` : ""}
              <em className="info">Always on</em>
            </li>
            <li>
              <Icon name="check" />
              {protectedPrefixes.length ? `Protected prefixes are skipped: ${protectedPrefixes.join(", ")}` : "No protected prefixes are set on this bucket"}
              <em className="info">Always on</em>
            </li>
            <li>
              <Icon name="check" />
              Objects under Object Lock or legal hold are skipped
              <em className="info">Always on</em>
            </li>
            <li>
              <Icon name={writeEnabled ? "check" : "close"} className={`ic${writeEnabled ? "" : " no"}`} />
              Writes are enabled for this bucket in Settings
              <em className={writeEnabled ? undefined : "no"}>{writeEnabled ? "Passed" : "Blocked"}</em>
            </li>
          </ul>
        </section>
      </div>

      <aside className="side">
        <section className="card ap">
          <h2>{status === "draft" ? "Start with a dry run" : status === "dry_run" ? "Approve this plan" : status === "approved" ? "Run this plan" : "Plan status"}</h2>
          {!terminal ? (
            <div className="warn">
              This plan {permanent ? "permanently deletes" : "aborts"} {plural(num(plan.data?.object_count), action === "abort_multipart" ? "incomplete upload" : "object")} ({formatBytes(plan.data?.bytes)}).
              {permanent ? " Deleted versions cannot be restored." : ""}
            </div>
          ) : null}
          {result ? <p className="result">{result}</p> : null}
          <ErrorText error={error} />
          {status === "dry_run" || status === "approved" ? (
            <div className="f">
              <label htmlFor="confirm">Type the bucket name to continue</label>
              <input id="confirm" type="text" value={confirmation} placeholder={bucket} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
              <span className="hint">The button turns on when the name matches.</span>
            </div>
          ) : null}
          {status === "draft" ? <button className="btn pri" type="button" disabled={busy} onClick={() => void act("dry-run")}>Start dry run</button> : null}
          {status === "dry_run" ? <button className="btn pri" type="button" disabled={!nameOk || busy} onClick={() => void act("approve", { confirmation })}>Approve plan</button> : null}
          {status === "approved" ? <button className="btn danger" type="button" disabled={!nameOk || busy || !writeEnabled} onClick={() => void act("execute", { confirmation })}>Run plan</button> : null}
          {status === "approved" && !writeEnabled ? <p className="small">Turn on writes for {bucket} in Settings before running.</p> : null}
          <div className="row">
            {status === "done" ? <button className="btn" type="button" disabled={busy} onClick={() => void act("undo")}>Undo</button> : null}
            {!terminal && status ? <button className="btn" type="button" disabled={busy} onClick={() => void act("cancel")}>Cancel plan</button> : null}
            <button className="btn" type="button" onClick={() => go("/plans")}>All plans</button>
          </div>
          <p className="small">Every step is recorded in the audit log under your name. Objects that changed since the index are skipped.</p>
        </section>
      </aside>
    </>
  );
}
