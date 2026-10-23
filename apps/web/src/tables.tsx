import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "./api";
import { go, openInQuery, useBucket } from "./ctx";
import { formatBytes, formatCount, num, plural, percent, relativeDate, sqlString, text, type Row } from "./format";
import { Icon } from "./icons";
import { CopyButton, Crumbs, DataTable, Empty, ErrorText } from "./ui";

function tableName(location: string): string {
  return location.split("/").filter(Boolean).at(-1) ?? location;
}

function qualifiedName(location: string): string {
  return location.split("/").filter(Boolean).join(".");
}

function useTables(bucket: string) {
  return useQuery({
    queryKey: ["tables", bucket],
    queryFn: () => api<Row[]>(`/api/tables?bucket=${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
}

export function Tables(): ReactNode {
  const { bucket } = useBucket();
  const tables = useTables(bucket);
  if (!bucket) {
    return <div className="page"><div className="card"><Empty title="Connect a store in Settings" action="Open Settings" href="/settings" /></div></div>;
  }
  const rows = tables.data ?? [];
  const open = (location: string): void => go(`/tables/${encodeURIComponent(location)}`);
  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Tables</h1>
          <p>Apache Iceberg tables found in {bucket}: folders with data/ and metadata/ that query engines read as one table. This tool reports on them and never deletes their files.</p>
        </div>
      </div>
      <ErrorText error={tables.error} />
      <section className="card">
        {tables.isLoading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty
            title="No Iceberg tables in this bucket"
            body="Tables are discovered from metadata JSON keys while the bucket is indexed. Re-index after new tables are created."
            action="Browse the bucket"
            href="/"
          />
        ) : (
          <div className="tw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Format</th>
                  <th className="num">Size</th>
                  <th className="num">Objects</th>
                  <th>Last write</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const location = text(row.location);
                  return (
                    <tr key={location} className="click" onClick={() => open(location)}>
                      <td>
                        <div className="nm">
                          <Icon name="table" />
                          <div className="ti">
                            <a className="name" href={`/tables/${encodeURIComponent(location)}`} onClick={(event) => { event.preventDefault(); open(location); }}>
                              {tableName(location)}
                            </a>
                            <span><code>{location}</code></span>
                          </div>
                        </div>
                      </td>
                      <td><span className="badge b-ice">Iceberg{row.format_version != null ? ` v${text(row.format_version)}` : ""}</span></td>
                      <td className="num">{formatBytes(row.bytes)}</td>
                      <td className="num">{formatCount(row.objects)}</td>
                      <td>{relativeDate(row.newest)}</td>
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

interface Breakdown {
  area: string;
  band: number;
  files: number;
  bytes: number;
}

const BANDS = ["Under 1 MB", "1 to 16 MB", "16 to 128 MB", "Over 128 MB"];

export function TableDetail({ location }: { location: string }): ReactNode {
  const { bucket } = useBucket();
  const tables = useTables(bucket);
  const [tab, setTab] = useState<"health" | "files">("health");
  const scope = `bucket = ${sqlString(bucket)} AND starts_with(key, ${sqlString(location)}) AND is_latest AND NOT is_delete_marker`;
  const breakdown = useQuery({
    queryKey: ["table-breakdown", bucket, location],
    queryFn: async () => {
      const result = await api<{ rows: Row[] }>("/api/query", {
        method: "POST",
        body: JSON.stringify({
          sql: `SELECT
  CASE WHEN contains(key, '/metadata/') THEN 'metadata' WHEN contains(key, '/data/') THEN 'data' ELSE 'other' END AS area,
  CASE WHEN size < 1048576 THEN 0 WHEN size < 16777216 THEN 1 WHEN size < 134217728 THEN 2 ELSE 3 END AS band,
  count(*) AS files,
  coalesce(sum(size), 0) AS bytes
FROM objects
WHERE ${scope}
GROUP BY 1, 2`,
          limit: 100,
        }),
      });
      return result.rows.map((row): Breakdown => ({ area: text(row.area), band: num(row.band), files: num(row.files), bytes: num(row.bytes) }));
    },
    enabled: Boolean(bucket && location),
  });
  const largest = useQuery({
    queryKey: ["table-files", bucket, location],
    queryFn: () => api<{ rows: Row[] }>("/api/query", {
      method: "POST",
      body: JSON.stringify({ sql: `SELECT key, size, last_modified FROM objects WHERE ${scope} ORDER BY size DESC LIMIT 50`, limit: 50 }),
    }),
    enabled: Boolean(bucket && location) && tab === "files",
  });

  const row = (tables.data ?? []).find((item) => text(item.location) === location);
  const name = tableName(location);
  const qualified = qualifiedName(location);
  const s3 = `s3://${bucket}/${location}`;
  const parts = breakdown.data ?? [];
  const sum = (area: string | null, key: "files" | "bytes"): number =>
    parts.filter((part) => area == null || part.area === area).reduce((total, part) => total + part[key], 0);
  const dataFiles = sum("data", "files");
  const dataBytes = sum("data", "bytes");
  const metaFiles = sum("metadata", "files");
  const metaBytes = sum("metadata", "bytes");
  const otherBytes = sum("other", "bytes");
  const totalBytes = sum(null, "bytes") || num(row?.bytes);
  const histArea = dataFiles > 0 ? "data" : null;
  const bands = BANDS.map((label, band) => ({
    label,
    files: parts.filter((part) => part.band === band && (histArea == null || part.area === histArea)).reduce((total, part) => total + part.files, 0),
  }));
  const histTotal = bands.reduce((total, band) => total + band.files, 0);
  const histMax = Math.max(1, ...bands.map((band) => band.files));
  const smallFiles = (bands[0]?.files ?? 0) + (bands[1]?.files ?? 0);
  const smallShare = percent(smallFiles, histTotal);
  const scanSql = `SELECT * FROM iceberg_scan('${s3.replaceAll("'", "''")}') LIMIT 100;`;

  if (!bucket) return <div className="page"><div className="card"><Empty title="Connect a store in Settings" action="Open Settings" href="/settings" /></div></div>;

  return (
    <>
      <div className="col">
        <Crumbs items={[{ label: "Tables", href: "/tables" }, { label: name }]} />
        <div className="stack" style={{ gap: 12 }}>
          <h1>{name}</h1>
          <div className="meta">
            <span className="badge b-ice">Iceberg{row?.format_version != null ? ` v${text(row.format_version)}` : ""}</span>
            <span className="path inline"><code>{s3}</code></span>
          </div>
          <div className="row">
            <button className="btn" type="button" onClick={() => go("/")}>Open in Browse</button>
            <CopyButton value={s3} label="Copy path" className="btn" />
          </div>
        </div>
        <ErrorText error={tables.error ?? breakdown.error} />
        {!tables.isLoading && !row ? <div className="card"><Empty title="This table is not in the index" body="It may have been removed, or the bucket needs re-indexing." action="All tables" href="/tables" /></div> : null}

        <div className="kpis">
          <div className="card kpi"><span>Size on S3</span><strong>{formatBytes(totalBytes)}</strong><small>{plural(num(row?.objects), "object")}</small></div>
          <div className="card kpi"><span>Data files</span><strong>{formatCount(dataFiles)}</strong><small>{dataFiles ? `${formatBytes(dataBytes / dataFiles)} on average` : "None under data/"}</small></div>
          <div className="card kpi"><span>Metadata files</span><strong>{formatCount(metaFiles)}</strong><small>{formatBytes(metaBytes)}</small></div>
          <div className="card kpi"><span>Last write</span><strong style={{ fontSize: 20 }}>{relativeDate(row?.newest)}</strong><small>From the index</small></div>
        </div>

        {totalBytes > 0 ? (
          <section className="card sec">
            <h2>Where the storage goes</h2>
            <div className="bar thick" role="img" aria-label="Storage split">
              {dataBytes > 0 ? <span style={{ flex: `${dataBytes} 1 0%`, background: "var(--primary)" }} /> : null}
              {metaBytes > 0 ? <span style={{ flex: `${metaBytes} 1 0%`, background: "var(--ink-dark)" }} /> : null}
              {otherBytes > 0 ? <span style={{ flex: `${otherBytes} 1 0%`, background: "var(--amber)" }} /> : null}
            </div>
            <ul className="legend">
              <li><i style={{ background: "var(--primary)" }} />Data files {formatBytes(dataBytes)}</li>
              <li><i style={{ background: "var(--ink-dark)" }} />Metadata {formatBytes(metaBytes)}</li>
              {otherBytes > 0 ? <li><i style={{ background: "var(--amber)" }} />Outside data/ and metadata/ {formatBytes(otherBytes)}</li> : null}
            </ul>
          </section>
        ) : null}

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "health"} className={tab === "health" ? "on" : undefined} onClick={() => setTab("health")}>Health</button>
          <button type="button" role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : undefined} onClick={() => setTab("files")}>Files</button>
        </div>

        {tab === "health" ? (
          <>
            <section className="card sec">
              <div className="t">
                <h3>Small files</h3>
                {smallShare >= 30 && smallFiles > 10 ? <span className="badge b-warn">Needs attention</span> : <span className="badge b-ok">Looks fine</span>}
              </div>
              <p>
                {histTotal
                  ? `${smallShare}% of ${dataFiles ? "data " : ""}files are under 16 MB (${formatCount(smallFiles)} of ${formatCount(histTotal)}). Many small files slow queries and add S3 request cost. Compaction merges them into larger files.`
                  : "No files found under this table in the index."}
              </p>
              <Statement sql={`ALTER TABLE ${qualified} EXECUTE optimize(file_size_threshold => '16MB')`} />
            </section>
            <section className="card sec">
              <div className="t">
                <h3>Snapshots and metadata</h3>
                <span className="badge b-ice">Report only</span>
              </div>
              <p>
                {formatCount(metaFiles)} metadata files ({formatBytes(metaBytes)}) sit under metadata/. Expiring old snapshots lets the engine remove files only they reference.
                Snapshot history is not read by this tool.
              </p>
              <Statement sql={`ALTER TABLE ${qualified} EXECUTE expire_snapshots(retention_threshold => '30d')`} />
            </section>
            <section className="card sec">
              <div className="t">
                <h3>Unreferenced files</h3>
                <span className="badge b-ice">Report only</span>
              </div>
              <p>This tool never deletes files inside an Iceberg table. Use the table's engine to remove orphan files. Files newer than the retention window are left alone.</p>
              <Statement sql={`ALTER TABLE ${qualified} EXECUTE remove_orphan_files(retention_threshold => '7d')`} />
            </section>
            <p className="small">Statements are for copying into your table engine. They are not executed here.</p>
          </>
        ) : (
          <section className="card">
            <ErrorText error={largest.error} />
            {largest.isLoading ? <div className="empty">Loading…</div> : (
              <DataTable
                columns={["Largest files", "Size", "Modified"]}
                numeric={[false, true, false]}
                widths={[undefined, "120px", "170px"]}
                rows={(largest.data?.rows ?? []).map((file) => [
                  <code key="k" style={{ overflowWrap: "anywhere" }}>{text(file.key).slice(location.length)}</code>,
                  formatBytes(file.size),
                  relativeDate(file.last_modified),
                ])}
                empty={<Empty title="No files in the index under this table" />}
              />
            )}
          </section>
        )}
      </div>

      <aside className="side">
        <section className="card sec">
          <h2>{histArea ? "Data file sizes" : "File sizes"}</h2>
          <div className="hist">
            {bands.map((band, index) => (
              <div key={band.label} style={{ display: "contents" }}>
                <span>{band.label}</span>
                <span><span className={`b${index < 2 ? " s" : ""}`} style={{ display: "block", width: `${Math.max(2, (band.files / histMax) * 100)}%` }} /></span>
                <span className="c">{formatCount(band.files)}</span>
              </div>
            ))}
          </div>
          <p className="small">Orange bars are small files, {formatCount(smallFiles)} of {formatCount(histTotal)}.</p>
        </section>
        <section className="card sec">
          <h2>Table metadata</h2>
          <ul className="list">
            <li><strong>Format</strong><span>Iceberg{row?.format_version != null ? ` v${text(row.format_version)}` : ""}</span></li>
            <li><strong>Location</strong><span><code>{location}</code></span></li>
            <li style={{ flexDirection: "column", alignItems: "flex-start" }}>
              <strong>Latest metadata</strong>
              <code style={{ overflowWrap: "anywhere", color: "var(--text-3)" }}>{text(row?.latest_metadata) || "—"}</code>
            </li>
          </ul>
        </section>
        <section className="card sec">
          <h2>Query this table</h2>
          <p className="mut">Read the table with DuckDB's Iceberg reader in the Query console.</p>
          <button className="btn" type="button" onClick={() => openInQuery(scanSql)}>Open in Query</button>
        </section>
      </aside>
    </>
  );
}

function Statement({ sql }: { sql: string }): ReactNode {
  return (
    <div className="code">
      <code>{sql}</code>
      <CopyButton value={sql} label="Copy statement" />
    </div>
  );
}
