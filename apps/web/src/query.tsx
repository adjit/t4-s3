import Editor from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api, downloadExport } from "./api";
import { takeQueryDraft, useBucket } from "./ctx";
import { formatCount, relativeDate, sqlString, text, type Row } from "./format";
import { DataTable, Empty, ErrorText } from "./ui";

interface Result { columns: string[]; rows: Row[]; sql?: string }

export function QueryScreen(): ReactNode {
  const { bucket } = useBucket();
  const client = useQueryClient();
  const [sql, setSql] = useState(() => takeQueryDraft());
  const [name, setName] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const saved = useQuery({ queryKey: ["saved-queries"], queryFn: () => api<Row[]>("/api/saved-queries") });
  const dark = document.documentElement.dataset.theme === "dark";

  useEffect(() => {
    if (bucket) {
      setSql((current) => current || `SELECT key, size, last_modified, storage_class\nFROM objects\nWHERE bucket = ${sqlString(bucket)}\n  AND is_latest AND NOT is_delete_marker\nORDER BY size DESC\nLIMIT 100`);
    }
  }, [bucket]);

  const run = async (): Promise<void> => {
    setError(null);
    setRunning(true);
    const started = performance.now();
    try {
      setResult(await api<Result>("/api/query", { method: "POST", body: JSON.stringify({ sql, limit: 1000 }) }));
      setMs(Math.round(performance.now() - started));
    } catch (caught) {
      setResult(null);
      setError(caught);
    } finally {
      setRunning(false);
    }
  };
  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api("/api/saved-queries", { method: "POST", body: JSON.stringify({ name: name.trim() || "Untitled", sql }) });
      setName("");
      await client.invalidateQueries({ queryKey: ["saved-queries"] });
    } catch (caught) {
      setError(caught);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/saved-queries/${encodeURIComponent(id)}`, { method: "DELETE" });
      await client.invalidateQueries({ queryKey: ["saved-queries"] });
    } catch (caught) {
      setError(caught);
    }
  };
  const exportAs = async (format: "csv" | "parquet"): Promise<void> => {
    setError(null);
    try {
      const file = await api<{ url: string; fileName: string }>("/api/export", { method: "POST", body: JSON.stringify({ sql, format }) });
      await downloadExport(file.url, file.fileName);
    } catch (caught) {
      setError(caught);
    }
  };

  const columns = result ? (result.columns.length ? result.columns : Object.keys(result.rows[0] ?? {})) : [];

  return (
    <>
      <div className="col">
        <div className="head">
          <div>
            <h1>Query</h1>
            <p>Ask the local index with SQL. One SELECT, DESCRIBE, EXPLAIN, or SUMMARIZE at a time. Local file reads are rejected.</p>
          </div>
        </div>
        <section className="card sec">
          <div className="editor">
            <Editor
              height="260px"
              defaultLanguage="sql"
              theme={dark ? "vs-dark" : "vs"}
              value={sql}
              onChange={(value) => setSql(value ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, padding: { top: 10 } }}
            />
          </div>
          <div className="row">
            <button className="btn pri" type="button" disabled={running || !sql.trim()} onClick={() => void run()}>{running ? "Running…" : "Run query"}</button>
            <button className="btn" type="button" disabled={!sql.trim()} onClick={() => void exportAs("csv")}>Export CSV</button>
            <button className="btn" type="button" disabled={!sql.trim()} onClick={() => void exportAs("parquet")}>Export Parquet</button>
            <span className="grow" />
            <span className="small">Tables: objects, prefix_stats, findings, iceberg_tables, jobs</span>
          </div>
          <ErrorText error={error} />
        </section>
        {result ? (
          <section className="card">
            <div className="sec" style={{ paddingBottom: 12 }}>
              <div className="t">
                <h2>Results</h2>
                <span className="small">{formatCount(result.rows.length)} rows{ms != null ? ` · ${ms} ms` : ""}{result.rows.length >= 1000 ? " · capped at 1,000" : ""}</span>
              </div>
            </div>
            <DataTable
              columns={columns.length ? columns : ["result"]}
              rows={result.rows.map((row) => columns.map((column) => cell(row[column])))}
              empty={<Empty title="The query returned no rows" />}
            />
          </section>
        ) : null}
      </div>
      <aside className="side">
        <section className="card sec">
          <h2>Save this query</h2>
          <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <input className="input" value={name} placeholder="Name" aria-label="Saved query name" onChange={(event) => setName(event.target.value)} />
            <button className="btn" type="submit" disabled={!sql.trim()}>Save</button>
          </form>
        </section>
        <section className="card sec">
          <h2>Saved queries</h2>
          {(saved.data ?? []).length === 0 ? (
            <p className="mut">No saved queries yet.</p>
          ) : (
            <ul className="list">
              {(saved.data ?? []).map((row) => (
                <li key={text(row.query_id)}>
                  <div className="ti">
                    <button className="link" type="button" style={{ textAlign: "left", fontWeight: 600 }} onClick={() => setSql(text(row.sql))}>{text(row.name)}</button>
                    <span>{relativeDate(row.created_at)}</span>
                  </div>
                  <button className="link" type="button" onClick={() => void remove(text(row.query_id))}>Delete</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </>
  );
}

function cell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
