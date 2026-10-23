import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "./api";
import { asRecord, formatBytes, formatCount, num, relativeDate, text, type Row } from "./format";
import { Icon } from "./icons";
import { Empty, ErrorText, StatusBadge } from "./ui";

const KIND_LABEL: Record<string, string> = {
  index: "Index bucket",
  "index-inventory": "Load S3 Inventory",
  analyzers: "Run analyzers",
  analyze: "Run analyzers",
};

export function Jobs(): ReactNode {
  const started = new URLSearchParams(window.location.search).get("started") ?? "";
  const [open, setOpen] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Row[]>("/api/jobs"),
    refetchInterval: () => (document.visibilityState === "visible" ? 2000 : false),
  });
  const rows = jobs.data ?? [];
  const running = rows.filter((row) => text(row.status) === "running").length;

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Jobs</h1>
          <p>Background work: indexing buckets and running analyzers. {running ? `${running} running now.` : "Nothing running now."} This page refreshes every 2 seconds.</p>
        </div>
      </div>
      <ErrorText error={jobs.error} />
      <section className="card">
        {jobs.isLoading ? <div className="empty">Loading…</div> : rows.length === 0 ? (
          <Empty title="No jobs yet" body="Index a bucket or run analyzers to start one." action="Open Settings" href="/settings" />
        ) : (
          <div className="tw">
            <table className="tbl">
              <colgroup>
                <col />
                <col style={{ width: 150 }} />
                <col style={{ width: 120 }} />
                <col />
                <col style={{ width: 150 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Bucket</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((row) => {
                  const id = text(row.job_id);
                  const status = text(row.status);
                  const result = asRecord(row.result);
                  const log = Array.isArray(row.log) ? (row.log as unknown[]) : [];
                  const out = [
                    <tr key={id} className={`click${id === started ? " on" : ""}`} onClick={() => setOpen(open === id ? null : id)}>
                      <td>
                        <div className="nm">
                          <Icon name="clock" />
                          <div className="ti">
                            <strong>{KIND_LABEL[text(row.kind)] ?? text(row.kind)}</strong>
                            <span>Started {relativeDate(row.created_at).toLowerCase()} · {id.slice(0, 8)}</span>
                          </div>
                        </div>
                      </td>
                      <td>{text(row.bucket) || "—"}</td>
                      <td><StatusBadge status={status === "running" ? "running" : status === "error" ? "failed" : status} /></td>
                      <td>
                        {status === "running" ? (
                          <div className="stack" style={{ gap: 4 }}>
                            <div className="bar"><span style={{ flex: `0 0 ${Math.round(num(row.progress) * 100)}%`, background: "var(--primary)" }} /></div>
                            <span className="small">{text(row.message) || "Working"}</span>
                          </div>
                        ) : row.error ? (
                          <span className="error">{text(row.error)}</span>
                        ) : result.rows != null ? (
                          <span>{formatCount(result.rows)} objects · {formatBytes(result.bytes)}{result.listRequests != null ? ` · ${formatCount(result.listRequests)} list requests` : ""}</span>
                        ) : result.findings != null ? (
                          <span>{formatCount(result.findings)} findings · {formatBytes(result.reclaimableBytes)} reclaimable</span>
                        ) : (
                          <span className="mut">{text(row.message) || "—"}</span>
                        )}
                      </td>
                      <td>{relativeDate(row.updated_at)}</td>
                    </tr>,
                  ];
                  if (open === id) {
                    out.push(
                      <tr key={`${id}-detail`}>
                        <td colSpan={5}>
                          <pre className="sql">{JSON.stringify({ result: row.result, log, error: row.error }, null, 2)}</pre>
                        </td>
                      </tr>,
                    );
                  }
                  return out;
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="small">Select a job to see its raw result and log.</p>
    </div>
  );
}
