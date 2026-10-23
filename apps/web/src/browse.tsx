import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, downloadExport } from "./api";
import { go, openInQuery, useBucket } from "./ctx";
import {
  asRecord,
  daysSince,
  elapsed,
  formatBytes,
  formatCount,
  isPreviewable,
  num,
  percent,
  plural,
  relativeDate,
  sqlString,
  text,
  type Row,
} from "./format";
import { Icon } from "./icons";
import { ConfirmDelete, CopyButton, Crumbs, DataTable, Empty, ErrorText, Modal } from "./ui";

const STALE_DAYS = 180;

interface SizeFilter { label: string; min: string; max: string }
interface DateFilter { label: string; after: string; before: string }
type IcebergFilter = "any" | "only" | "hide";

type Selection = { kind: "folder"; row: Row } | { kind: "file"; row: Row } | null;

const MB = 1024 * 1024;
const GB = 1024 * MB;

const SIZE_PRESETS: SizeFilter[] = [
  { label: "any", min: "", max: "" },
  { label: "under 1 MB", min: "", max: String(MB) },
  { label: "1 MB to 100 MB", min: String(MB), max: String(100 * MB) },
  { label: "100 MB to 1 GB", min: String(100 * MB), max: String(GB) },
  { label: "over 1 GB", min: String(GB), max: "" },
];

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const DATE_PRESETS: Array<{ label: string; make: () => DateFilter }> = [
  { label: "any", make: () => ({ label: "any", after: "", before: "" }) },
  { label: "last 24 hours", make: () => ({ label: "last 24 hours", after: daysAgoIso(1), before: "" }) },
  { label: "last 7 days", make: () => ({ label: "last 7 days", after: daysAgoIso(7), before: "" }) },
  { label: "last 30 days", make: () => ({ label: "last 30 days", after: daysAgoIso(30), before: "" }) },
  { label: "older than 90 days", make: () => ({ label: "older than 90 days", after: "", before: daysAgoIso(90) }) },
  { label: "older than 1 year", make: () => ({ label: "older than 1 year", after: "", before: daysAgoIso(365) }) },
];

const TYPE_PRESETS = ["parquet", "csv", "json", "jsonl", "txt", "gz", "avro", "orc"];

export function Browse(): ReactNode {
  const { bucket, connectionId } = useBucket();
  const client = useQueryClient();
  const [prefix, setPrefix] = useState(prefixFromUrl);
  const [dialog, setDialog] = useState<null | "new" | { delete: string }>(null);
  const [indexJob, setIndexJob] = useState("");
  const [cursor, setCursor] = useState("");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [ext, setExt] = useState("");
  const [size, setSize] = useState<SizeFilter>(SIZE_PRESETS[0] as SizeFilter);
  const [modified, setModified] = useState<DateFilter>({ label: "any", after: "", before: "" });
  const [iceberg, setIceberg] = useState<IcebergFilter>("any");
  const [showSql, setShowSql] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  // The folder lives in the URL (?prefix=) so Back and reload work.
  useEffect(() => {
    const onPop = (): void => {
      setPrefix(prefixFromUrl());
      setCursor("");
      setSelected(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const lastBucket = useRef(bucket);
  useEffect(() => {
    if (lastBucket.current === bucket) return;
    lastBucket.current = bucket;
    setPrefix("");
    setCursor("");
    setSelected(null);
    if (window.location.pathname === "/" && window.location.search) window.history.replaceState(null, "", "/");
  }, [bucket]);

  const indexing = useQuery({
    queryKey: ["job", indexJob],
    queryFn: () => api<Row>(`/api/jobs/${encodeURIComponent(indexJob)}`),
    enabled: Boolean(indexJob),
    refetchInterval: (query) => (["done", "failed", "error"].includes(text(query.state.data?.status)) ? false : 1000),
  });
  const indexStatus = text(indexing.data?.status);
  useEffect(() => {
    if (indexStatus === "done") {
      void client.invalidateQueries({ queryKey: ["browse", bucket] });
      void client.invalidateQueries({ queryKey: ["summary", bucket] });
      void client.invalidateQueries({ queryKey: ["buckets"] });
      void client.invalidateQueries({ queryKey: ["tree", bucket] });
    }
  }, [indexStatus, bucket, client]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(searchText.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const fileFilters = Boolean(ext || size.min || size.max || modified.after || modified.before);
  const searching = Boolean(q) || fileFilters;

  const browse = useQuery({
    queryKey: ["browse", bucket, prefix, cursor],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}/browse?${qs({ prefix, cursor })}`),
    enabled: Boolean(bucket),
  });
  const search = useQuery({
    queryKey: ["search", bucket, prefix, q, ext, size.min, size.max, modified.after, modified.before],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}/search?${qs({
      prefix,
      q,
      ext,
      minSize: size.min,
      maxSize: size.max,
      modifiedAfter: modified.after,
      modifiedBefore: modified.before,
    })}`),
    enabled: Boolean(bucket) && searching,
  });
  const summary = useQuery({
    queryKey: ["summary", bucket],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
  const parent = parentOf(prefix);
  const parentStats = useQuery({
    queryKey: ["tree", bucket, parent],
    queryFn: () => api<Row[]>(`/api/buckets/${encodeURIComponent(bucket)}/tree?${qs({ prefix: parent })}`),
    enabled: Boolean(bucket) && Boolean(prefix),
  });
  const findings = useQuery({
    queryKey: ["findings", bucket, "open"],
    queryFn: () => api<Row[]>(`/api/findings?bucket=${encodeURIComponent(bucket)}&status=open`),
    enabled: Boolean(bucket),
  });

  const allFolders = useMemo(() => (browse.data?.folders as Row[] | undefined) ?? [], [browse.data]);

  if (!bucket) {
    return (
      <div className="col">
        <div className="card">
          {connectionId ? (
            <Empty title="Pick a bucket" body="Use Change on the Bucket card in the sidebar to choose a bucket in this connection." />
          ) : (
            <Empty title="Connect a store to start browsing" body="Add an S3 connection and a bucket in Settings." action="Open Settings" href="/settings?tab=new" />
          )}
        </div>
      </div>
    );
  }

  const open = (next: string): void => {
    go(next ? `/?prefix=${encodeURIComponent(next)}` : "/");
  };
  const startIndex = async (): Promise<void> => {
    const job = await api<{ jobId: string }>(`/api/buckets/${encodeURIComponent(bucket)}/index`, { method: "POST", body: "{}" });
    setIndexJob(job.jobId);
  };
  const refreshListing = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ["browse", bucket] });
    await client.invalidateQueries({ queryKey: ["search", bucket] });
    await client.invalidateQueries({ queryKey: ["tree", bucket] });
    await client.invalidateQueries({ queryKey: ["summary", bucket] });
  };
  const writeEnabled = summary.data?.write_enabled === true;
  const protectedPrefixes = (summary.data?.protected_prefixes as string[] | undefined) ?? [];
  const writeNote = !writeEnabled
    ? `Writes are off for ${bucket}. Turn on "Allow plans to change this bucket" in Settings to create or delete folders.`
    : null;

  const needle = q.toLowerCase();
  const folders = fileFilters
    ? []
    : allFolders.filter((row) => {
        if (iceberg === "only" && !row.iceberg) return false;
        if (iceberg === "hide" && row.iceberg) return false;
        if (needle && !text(row.name).toLowerCase().includes(needle)) return false;
        return true;
      });
  const files = iceberg === "only"
    ? []
    : searching
      ? ((search.data?.rows as Row[] | undefined) ?? [])
      : ((browse.data?.files as Row[] | undefined) ?? []).filter((row) => text(row.key) !== prefix);
  const directFiles = (browse.data?.files as Row[] | undefined) ?? [];
  const indexed = browse.data?.indexedAt != null && browse.data.indexedAt !== "";
  const sql = searching
    ? text(search.data?.sql)
    : `-- folders\n${text(asRecord(browse.data?.sql).folders)}\n\n-- files\n${text(asRecord(browse.data?.sql).files)}`;

  const totals = asRecord(summary.data?.totals);
  const here = prefix ? (parentStats.data ?? []).find((row) => text(row.prefix) === prefix) : undefined;
  const hereBytes = prefix ? num(here?.bytes) : num(totals.bytes);
  const hereObjects = prefix ? num(here?.objects) : num(totals.objects);
  const hereNewest = prefix ? here?.newest : maxDate([...allFolders.map((row) => row.newest), ...directFiles.map((row) => row.last_modified)]);
  const heading = prefix ? `${prefix.split("/").filter(Boolean).at(-1) ?? ""}/` : bucket;
  const crumbParts = prefix.split("/").filter(Boolean);
  const loading = browse.isLoading || (searching && search.isLoading);
  const openFindings = findings.data ?? [];

  const segments = usageSegments(allFolders, directFiles, hereBytes);

  const resetFilters = (): void => {
    setSearchText("");
    setQ("");
    setExt("");
    setSize(SIZE_PRESETS[0] as SizeFilter);
    setModified({ label: "any", after: "", before: "" });
    setIceberg("any");
  };
  const anyFilter = searching || iceberg !== "any";

  return (
    <>
      <div className="col">
        <div className="top">
          <Crumbs
            items={[
              { label: bucket, onClick: () => open("") },
              ...crumbParts.map((part, index) => ({ label: part, onClick: () => open(`${crumbParts.slice(0, index + 1).join("/")}/`) })),
            ]}
          />
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              value={searchText}
              placeholder="Search this bucket by name, type, or size"
              aria-label="Search this bucket"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") setQ(searchText.trim()); }}
            />
            {searchText ? (
              <button className="clear" type="button" aria-label="Clear search" onClick={() => { setSearchText(""); setQ(""); }}>
                <Icon name="close" />
              </button>
            ) : null}
          </label>
        </div>

        <div className="chips">
          <span className="lbl">Filter by</span>
          <ChipMenu label={`Type: ${ext ? `.${ext}` : "any"}`} active={Boolean(ext)}>
            {(close) => <TypeMenu value={ext} onPick={(value) => { setExt(value); close(); }} />}
          </ChipMenu>
          <ChipMenu label={`Size: ${size.label}`} active={Boolean(size.min || size.max)}>
            {(close) => <SizeMenu value={size} onPick={(value) => { setSize(value); close(); }} />}
          </ChipMenu>
          <ChipMenu label={`Modified: ${modified.label}`} active={Boolean(modified.after || modified.before)}>
            {(close) => (
              <div className="stack" style={{ gap: 2 }}>
                {DATE_PRESETS.map((preset) => (
                  <button key={preset.label} type="button" className={`opt${modified.label === preset.label ? " on" : ""}`} onClick={() => { setModified(preset.make()); close(); }}>
                    {cap(preset.label)}
                  </button>
                ))}
              </div>
            )}
          </ChipMenu>
          <ChipMenu label={`Iceberg: ${iceberg === "any" ? "any" : iceberg === "only" ? "tables only" : "hidden"}`} active={iceberg !== "any"}>
            {(close) => (
              <div className="stack" style={{ gap: 2 }}>
                {([["any", "Any"], ["only", "Only Iceberg tables"], ["hide", "Hide Iceberg tables"]] as const).map(([value, label]) => (
                  <button key={value} type="button" className={`opt${iceberg === value ? " on" : ""}`} onClick={() => { setIceberg(value); close(); }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </ChipMenu>
          <span className="end">
            {anyFilter ? <button className="link" type="button" onClick={resetFilters}>Clear filters</button> : null}
            <button className="link" type="button" onClick={() => setShowSql((value) => !value)}>{showSql ? "Hide SQL" : "Show SQL"}</button>
            {indexed ? (
              <button
                className="btn sm"
                type="button"
                title={writeNote ?? `Create a folder in ${heading}`}
                onClick={() => setDialog("new")}
              >
                <Icon name="plus" />New folder
              </button>
            ) : null}
          </span>
        </div>
        {showSql ? <pre className="sql">{sql}</pre> : null}
        <ErrorText error={browse.error ?? search.error} />

        {!indexed && !browse.isLoading ? (
          <div className="card">
            {indexJob && !["failed", "error"].includes(indexStatus) ? (
              <div className="empty">
                <strong>Indexing {bucket}…</strong>
                <p>{text(indexing.data?.message) || "Listing objects"}. This page fills in when it finishes. Nothing in the bucket changes.</p>
                <div className="bar" style={{ width: 320 }}><span style={{ flex: `0 0 ${Math.max(5, Math.round(num(indexing.data?.progress) * 100))}%`, background: "var(--primary)" }} /></div>
              </div>
            ) : (
              <Empty
                title="This bucket is not indexed yet"
                body={indexStatus === "failed" || indexStatus === "error"
                  ? `Indexing failed: ${text(indexing.data?.error) || "unknown error"}. Check the connection and try again.`
                  : "Browsing reads from a local index. Indexing lists the bucket once and does not change anything in it."}
                action="Index this bucket"
                onClick={() => void startIndex().catch(() => undefined)}
              />
            )}
          </div>
        ) : (
          <section className="card sum" aria-label="Folder summary">
            <div className="stack" style={{ gap: 2 }}>
              <h1>{heading}</h1>
              <p className="mut">
                {formatBytes(hereBytes)} · {plural(hereObjects, "object")} · {plural(allFolders.length, "folder")}
              </p>
            </div>
            {segments ? (
              <div className="classes">
                <div className="bar" role="img" aria-label={segments.map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`).join(", ")}>
                  {segments.map((segment) => (
                    <span key={segment.label} style={{ flex: `${Math.max(segment.bytes, 1)} 1 0%`, background: segment.color }} />
                  ))}
                </div>
                <ul className="legend">
                  {segments.map((segment) => (
                    <li key={segment.label}>
                      <i style={{ background: segment.color }} />
                      {segment.label} {formatBytes(segment.bytes)} ({percent(segment.bytes, segments.reduce((sum, item) => sum + item.bytes, 0))}%)
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        )}

        {!indexed && !browse.isLoading ? null : <section className="card" aria-label="Folder contents">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : folders.length === 0 && files.length === 0 ? (
            <Empty
              title={anyFilter ? "Nothing matches these filters" : "This folder is empty"}
              body={anyFilter ? "Try a broader search or clear the filters." : undefined}
              action={anyFilter ? "Clear filters" : undefined}
              onClick={resetFilters}
            />
          ) : (
            <div className="tw">
              <table className="tbl">
                <colgroup>
                  <col />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 160 }} />
                  <col style={{ width: 52 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Size</th>
                    <th className="num">Objects</th>
                    <th>Modified</th>
                    <th><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody>
                  {folders.map((row) => {
                    const key = text(row.prefix);
                    const isSel = selected?.kind === "folder" && text(selected.row.prefix) === key;
                    const stale = isStale(row.newest);
                    return (
                      <tr
                        key={`d:${key}`}
                        className={`click${isSel ? " sel" : ""}`}
                        aria-selected={isSel}
                        title={`Open ${text(row.name) || key}/`}
                        onClick={() => open(key)}
                      >
                        <td>
                          <div className="nm">
                            <Icon name="folder" />
                            <a
                              className="name"
                              href={`/?prefix=${encodeURIComponent(key)}`}
                              onClick={(event) => { event.preventDefault(); event.stopPropagation(); open(key); }}
                            >
                              {text(row.name) || key}/
                            </a>
                            {row.iceberg ? <span className="badge b-ice">Iceberg table</span> : null}
                            {stale ? <span className="badge b-warn">Stale</span> : null}
                          </div>
                        </td>
                        <td className="num">{formatBytes(row.bytes)}</td>
                        <td className="num">{formatCount(row.objects)}</td>
                        <td>{relativeDate(row.newest)}</td>
                        <td className="num">
                          <button
                            className="row-act"
                            type="button"
                            aria-label={`Show details for ${text(row.name) || key}/`}
                            title="Show details"
                            onClick={(event) => { event.stopPropagation(); setSelected(isSel ? null : { kind: "folder", row }); }}
                          >
                            <Icon name="info" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {files.map((row) => {
                    const key = text(row.key);
                    const isSel = selected?.kind === "file" && text(selected.row.key) === key;
                    const label = searching && key.startsWith(prefix) ? key.slice(prefix.length) : text(row.name) || key;
                    return (
                      <tr
                        key={`f:${key}`}
                        className={`click${isSel ? " sel" : ""}`}
                        aria-selected={isSel}
                        onClick={() => setSelected(isSel ? null : { kind: "file", row })}
                      >
                        <td>
                          <div className="nm">
                            <Icon name="file" />
                            <span className="name">{label}</span>
                            {row.storage_class && text(row.storage_class) !== "STANDARD" ? <span className="badge b-n">{text(row.storage_class)}</span> : null}
                          </div>
                        </td>
                        <td className="num">{formatBytes(row.size)}</td>
                        <td className="num">1</td>
                        <td>{relativeDate(row.last_modified)}</td>
                        <td className="num">
                          <button className="row-act" type="button" aria-label={`Show details for ${label}`} title="Show details" onClick={(event) => { event.stopPropagation(); setSelected(isSel ? null : { kind: "file", row }); }}>
                            <Icon name="info" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!searching && browse.data?.nextCursor ? (
            <div className="more">
              <button className="btn sm" type="button" onClick={() => setCursor(text(browse.data?.nextCursor))}>Load more files</button>
            </div>
          ) : null}
          {searching && search.data?.nextCursor ? (
            <p className="more small">Showing the first {formatCount(files.length)} matches. Narrow the search to see more.</p>
          ) : null}
        </section>}
      </div>

      <aside className="drawer dr" aria-label="Details">
        {selected?.kind === "file" ? (
          <FilePanel bucket={bucket} row={selected.row} onPreview={setPreviewKey} />
        ) : (
          <FolderPanel
            bucket={bucket}
            prefix={selected?.kind === "folder" ? text(selected.row.prefix) : prefix}
            title={selected?.kind === "folder" ? `${text(selected.row.name) || text(selected.row.prefix)}/` : heading}
            current={selected?.kind !== "folder"}
            bytes={selected?.kind === "folder" ? num(selected.row.bytes) : hereBytes}
            objects={selected?.kind === "folder" ? num(selected.row.objects) : hereObjects}
            newest={selected?.kind === "folder" ? selected.row.newest : hereNewest}
            iceberg={selected?.kind === "folder" ? Boolean(selected.row.iceberg) : false}
            findings={openFindings}
            onOpen={open}
            writeNote={writeNote}
            onDelete={(target) => setDialog({ delete: target })}
          />
        )}
      </aside>

      {previewKey ? <PreviewModal bucket={bucket} objectKey={previewKey} onClose={() => setPreviewKey(null)} /> : null}
      {dialog === "new" ? (
        <NewFolderDialog
          bucket={bucket}
          prefix={prefix}
          blocked={writeNote ?? protectedNote(protectedPrefixes, prefix, false)}
          onClose={() => setDialog(null)}
          onCreated={async () => { setDialog(null); await refreshListing(); }}
        />
      ) : null}
      {dialog && dialog !== "new" ? (
        <DeleteFolderDialog
          bucket={bucket}
          prefix={dialog.delete}
          onClose={() => setDialog(null)}
          onDeleted={async () => {
            const target = dialog.delete;
            setDialog(null);
            setSelected(null);
            await refreshListing();
            if (prefix.startsWith(target)) open(parentOf(target));
          }}
        />
      ) : null}
    </>
  );
}

function FolderPanel({
  bucket,
  prefix,
  title,
  current,
  bytes,
  objects,
  newest,
  iceberg,
  findings,
  onOpen,
  writeNote,
  onDelete,
}: {
  bucket: string;
  prefix: string;
  title: string;
  current: boolean;
  bytes: number;
  objects: number;
  newest: unknown;
  iceberg: boolean;
  findings: Row[];
  onOpen: (prefix: string) => void;
  writeNote: string | null;
  onDelete: (prefix: string) => void;
}): ReactNode {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const stale = isStale(newest);
  const related = findings.filter((row) => {
    const at = text(row.prefix);
    return prefix === "" || at.startsWith(prefix);
  });
  const reclaimable = related.reduce((sum, row) => sum + num(row.reclaimable_bytes), 0);
  const listSql = `SELECT key, size, last_modified, storage_class\nFROM objects\nWHERE bucket = ${sqlString(bucket)}\n  AND starts_with(key, ${sqlString(prefix)})\n  AND is_latest AND NOT is_delete_marker\nORDER BY key`;

  const exportList = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const file = await api<{ url: string; fileName: string }>("/api/export", { method: "POST", body: JSON.stringify({ sql: listSql, format: "csv" }) });
      await downloadExport(file.url, file.fileName);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="stack">
        <span className="small">{current ? (prefix ? "Current folder" : "Bucket") : "Selected folder"}</span>
        <h2>{title}</h2>
        {stale || iceberg ? (
          <div className="row">
            {iceberg ? <span className="badge b-ice">Iceberg table</span> : null}
            {stale ? <span className="badge b-warn">Stale: no writes for {elapsed(newest)}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="path">
        <code>{`s3://${bucket}/${prefix}`}</code>
        <CopyButton value={`s3://${bucket}/${prefix}`} label="Copy path" />
      </div>
      <dl className="stats">
        <div><dt>Size</dt><dd>{formatBytes(bytes)}</dd></div>
        <div><dt>Objects</dt><dd>{formatCount(objects)}</dd></div>
        <div><dt>Last write</dt><dd>{relativeDate(newest)}</dd></div>
        <div><dt>Type</dt><dd>{iceberg ? "Iceberg table" : current && !prefix ? "Bucket" : "Plain folder"}</dd></div>
      </dl>
      {reclaimable > 0 ? (
        <div className="note">
          <h3>Cleanup candidate</h3>
          <p>
            {plural(related.length, "open finding")} {current && !prefix ? "in this bucket" : "under this folder"} could free {formatBytes(reclaimable)}.
          </p>
        </div>
      ) : stale ? (
        <div className="note">
          <h3>Possibly stale</h3>
          <p>Nothing has been written here for {elapsed(newest)}. Run the analyzers in Maintenance to size up a cleanup.</p>
        </div>
      ) : null}
      <ErrorText error={error} />
      <div className="stack-10">
        {reclaimable > 0 ? (
          <button className="btn pri" type="button" onClick={() => go("/maintenance")}>Review cleanup options</button>
        ) : null}
        {!current ? (
          <button className={`btn${reclaimable > 0 ? "" : " pri"}`} type="button" onClick={() => onOpen(prefix)}>Open folder</button>
        ) : null}
        {iceberg ? <button className="btn" type="button" onClick={() => go(`/tables/${encodeURIComponent(prefix)}`)}>Open table details</button> : null}
        <button className="btn" type="button" onClick={() => openInQuery(`${listSql}\nLIMIT 1000`)}>Open in Query</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void exportList()}>{busy ? "Preparing export…" : "Export file list (CSV)"}</button>
        {prefix ? (
          <button className="btn danger-outline" type="button" onClick={() => onDelete(prefix)}>
            <Icon name="trash" />Delete folder
          </button>
        ) : null}
      </div>
      {prefix && writeNote ? <p className="blocked"><Icon name="info" />{writeNote}</p> : null}
      <p className="small">Deleting a folder asks you to type its name first. Bigger cleanups go through a plan you review and approve.</p>
    </>
  );
}

function FilePanel({ bucket, row, onPreview }: { bucket: string; row: Row; onPreview: (key: string) => void }): ReactNode {
  const key = text(row.key);
  const detail = useQuery({
    queryKey: ["object", bucket, key],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}/objects?key=${encodeURIComponent(key)}`),
  });
  const [error, setError] = useState<unknown>(null);
  const head = asRecord(detail.data?.head);
  const versions = (detail.data?.versions as Row[] | undefined) ?? [];
  const name = key.split("/").at(-1) || key;
  const extension = text(row.ext) || (name.includes(".") ? name.split(".").at(-1) ?? "" : "");
  const previewable = isPreviewable(key);

  const download = async (): Promise<void> => {
    setError(null);
    try {
      const result = await api<{ url: string }>(`/api/buckets/${encodeURIComponent(bucket)}/objects/download-url?key=${encodeURIComponent(key)}`);
      window.open(result.url, "_blank", "noopener");
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <>
      <div className="stack">
        <span className="small">Selected file</span>
        <h2>{name}</h2>
        {detail.data?.missing ? <div><span className="badge b-bad">Missing from the store</span></div> : null}
      </div>
      <div className="path">
        <code>{`s3://${bucket}/${key}`}</code>
        <CopyButton value={`s3://${bucket}/${key}`} label="Copy path" />
      </div>
      <dl className="stats">
        <div><dt>Size</dt><dd>{formatBytes(head.size ?? row.size)}</dd></div>
        <div><dt>Storage class</dt><dd>{text(head.storageClass) || text(row.storage_class) || "STANDARD"}</dd></div>
        <div><dt>Last write</dt><dd>{relativeDate(row.last_modified)}</dd></div>
        <div><dt>Type</dt><dd>{extension ? extension.toUpperCase() : "File"}</dd></div>
      </dl>
      <div className="stack" style={{ gap: 4 }}>
        <span className="small">ETag</span>
        <code style={{ overflowWrap: "anywhere", color: "var(--text-2)" }}>{text(head.etag) || text(row.etag) || "—"}</code>
      </div>
      <ErrorText error={error ?? detail.error} />
      <div className="stack-10">
        {previewable ? <button className="btn pri" type="button" onClick={() => onPreview(key)}>Preview contents</button> : null}
        <button className={`btn${previewable ? "" : " pri"}`} type="button" onClick={() => void download()}>Download</button>
        <button
          className="btn"
          type="button"
          onClick={() => openInQuery(`SELECT key, version_id, is_latest, size, last_modified, storage_class, etag\nFROM objects\nWHERE bucket = ${sqlString(bucket)}\n  AND key = ${sqlString(key)}`)}
        >
          Open in Query
        </button>
      </div>
      {versions.length > 1 ? (
        <div className="stack">
          <h3>Versions ({formatCount(versions.length)})</h3>
          <ul className="versions">
            {versions.map((version, index) => (
              <li key={`${text(version.version_id)}-${index}`}>
                <span>{version.is_latest ? <strong>Latest</strong> : version.is_delete_marker ? "Delete marker" : "Older version"}</span>
                <span className="mut">{formatBytes(version.size)} · {relativeDate(version.last_modified)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="small">Nothing is deleted from this screen. Downloads use a short-lived signed link.</p>
    </>
  );
}

function PreviewModal({ bucket, objectKey, onClose }: { bucket: string; objectKey: string; onClose: () => void }): ReactNode {
  const preview = useQuery({
    queryKey: ["preview", bucket, objectKey],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}/objects/preview?key=${encodeURIComponent(objectKey)}`),
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows = (preview.data?.rows as Row[] | undefined) ?? [];
  const columns = ((preview.data?.columns as Row[] | undefined) ?? []).map((column) => text(column.column_name) || text(column.name) || "column");
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="Preview">
        <header>
          <div className="stack" style={{ gap: 2 }}>
            <h2 style={{ overflowWrap: "anywhere" }}>{objectKey.split("/").at(-1)}</h2>
            <span className="small">
              {preview.data
                ? `${text(preview.data.format).toUpperCase()} · ${preview.data.rowCount != null ? `${formatCount(preview.data.rowCount)} rows · ` : ""}first ${formatCount(rows.length)} shown`
                : "Loading preview…"}
            </span>
          </div>
          <button className="btn sm" type="button" onClick={onClose} aria-label="Close preview"><Icon name="close" /></button>
        </header>
        <div className="body">
          {preview.error ? <div className="sec"><ErrorText error={preview.error} /></div> : null}
          {preview.data ? (
            <DataTable
              columns={columns}
              rows={rows.map((row) => columns.map((column) => cellText(row[column])))}
              empty={<Empty title="No rows" />}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function ChipMenu({ label, active, children }: { label: string; active: boolean; children: (close: () => void) => ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const close = (): void => setOpen(false);
  return (
    <span className="chip-wrap">
      <button className={`chip${active ? " on" : ""}`} type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
        <Icon name="chevron" className="ic" />
      </button>
      {open ? (
        <>
          <div className="scrim" onClick={close} />
          <div className="pop">{children(close)}</div>
        </>
      ) : null}
    </span>
  );
}

function TypeMenu({ value, onPick }: { value: string; onPick: (value: string) => void }): ReactNode {
  const [custom, setCustom] = useState(value);
  return (
    <div className="stack" style={{ gap: 2 }}>
      <button type="button" className={`opt${!value ? " on" : ""}`} onClick={() => onPick("")}>Any type</button>
      {TYPE_PRESETS.map((item) => (
        <button key={item} type="button" className={`opt${value === item ? " on" : ""}`} onClick={() => onPick(item)}>.{item}</button>
      ))}
      <div className="sep" />
      <form
        className="row"
        style={{ padding: "4px 6px", flexWrap: "nowrap" }}
        onSubmit={(event) => { event.preventDefault(); onPick(custom.replace(/^\./, "").trim()); }}
      >
        <input className="input sm" value={custom} placeholder="Other extension" aria-label="Other extension" onChange={(event) => setCustom(event.target.value)} />
        <button className="btn sm" type="submit">Apply</button>
      </form>
    </div>
  );
}

function SizeMenu({ value, onPick }: { value: SizeFilter; onPick: (value: SizeFilter) => void }): ReactNode {
  const [min, setMin] = useState(value.min ? String(Number(value.min) / MB) : "");
  const [max, setMax] = useState(value.max ? String(Number(value.max) / MB) : "");
  const apply = (): void => {
    const minBytes = min ? String(Math.round(Number(min) * MB)) : "";
    const maxBytes = max ? String(Math.round(Number(max) * MB)) : "";
    const label = minBytes && maxBytes
      ? `${formatBytes(minBytes)} to ${formatBytes(maxBytes)}`
      : minBytes ? `over ${formatBytes(minBytes)}` : maxBytes ? `under ${formatBytes(maxBytes)}` : "any";
    onPick({ label, min: minBytes, max: maxBytes });
  };
  return (
    <div className="stack" style={{ gap: 2 }}>
      {SIZE_PRESETS.map((preset) => (
        <button key={preset.label} type="button" className={`opt${value.label === preset.label ? " on" : ""}`} onClick={() => onPick(preset)}>
          {cap(preset.label)}
        </button>
      ))}
      <div className="sep" />
      <span className="lbl">Custom range in MB</span>
      <form className="row" style={{ padding: "4px 6px", flexWrap: "nowrap" }} onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <input className="input sm" style={{ width: 80 }} inputMode="decimal" value={min} placeholder="Min" aria-label="Minimum size in MB" onChange={(event) => setMin(event.target.value)} />
        <input className="input sm" style={{ width: 80 }} inputMode="decimal" value={max} placeholder="Max" aria-label="Maximum size in MB" onChange={(event) => setMax(event.target.value)} />
        <button className="btn sm" type="submit">Apply</button>
      </form>
    </div>
  );
}

interface Segment { label: string; bytes: number; color: string }

/** Pick a storage split that the index can actually answer for this level. */
function usageSegments(folders: Row[], files: Row[], total: number): Segment[] | null {
  const icebergBytes = folders.filter((row) => row.iceberg).reduce((sum, row) => sum + num(row.bytes), 0);
  if (icebergBytes > 0 && total > 0) {
    return [
      { label: "Iceberg tables", bytes: icebergBytes, color: "var(--primary)" },
      { label: "Other data", bytes: Math.max(0, total - icebergBytes), color: "var(--primary-light)" },
    ];
  }
  const noncurrent = folders.reduce((sum, row) => sum + num(row.noncurrent_bytes), 0);
  if (noncurrent > 0) {
    const current = folders.reduce((sum, row) => sum + num(row.bytes), 0) + files.reduce((sum, row) => sum + num(row.size), 0);
    return [
      { label: "Current versions", bytes: current, color: "var(--primary)" },
      { label: "Older versions", bytes: noncurrent, color: "var(--primary-light)" },
    ];
  }
  const inFolders = folders.reduce((sum, row) => sum + num(row.bytes), 0);
  const inFiles = files.reduce((sum, row) => sum + num(row.size), 0);
  if (inFolders > 0 && inFiles > 0) {
    return [
      { label: "In folders", bytes: inFolders, color: "var(--primary)" },
      { label: "Files at this level", bytes: inFiles, color: "var(--primary-light)" },
    ];
  }
  return null;
}

function isStale(newest: unknown): boolean {
  const days = daysSince(newest);
  return days != null && days > STALE_DAYS;
}

function maxDate(values: unknown[]): string | null {
  let best: number | null = null;
  for (const value of values) {
    if (value == null || value === "") continue;
    const time = Date.parse(String(value));
    if (!Number.isNaN(time) && (best == null || time > best)) best = time;
  }
  return best == null ? null : new Date(best).toISOString();
}

function parentOf(prefix: string): string {
  const parts = prefix.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function NewFolderDialog({
  bucket,
  prefix,
  blocked,
  onClose,
  onCreated,
}: {
  bucket: string;
  prefix: string;
  blocked: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const clean = name.trim();
  const invalid = clean.includes("/") ? "A folder name cannot contain a slash." : clean === "." || clean === ".." ? "Pick another name." : "";
  const create = async (): Promise<void> => {
    if (!clean || invalid || blocked) return;
    setError(null);
    setBusy(true);
    try {
      await api("/api/buckets/" + encodeURIComponent(bucket) + "/folders", { method: "POST", body: JSON.stringify({ prefix, name: clean }) });
      await onCreated();
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New folder"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn pri" type="button" disabled={!clean || Boolean(invalid) || busy || Boolean(blocked)} onClick={() => void create()}>
            {busy ? "Creating…" : "Create folder"}
          </button>
        </>
      }
    >
      <p className="mut">
        Creates an empty <code>{`${prefix}${clean || "name"}/`}</code> marker object in <strong>{bucket}</strong>, the way the S3 console does.
      </p>
      {blocked ? (
        <p className="warn" role="alert">{blocked}</p>
      ) : (
        <form className="f" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label htmlFor="folder-name">Folder name</label>
          <input id="folder-name" type="text" value={name} autoFocus autoComplete="off" spellCheck={false} placeholder="reports" onChange={(event) => setName(event.target.value)} />
          {invalid ? <span className="hint error">{invalid}</span> : <span className="hint">Created inside {prefix ? `${prefix}` : "the bucket root"}.</span>}
        </form>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}

function DeleteFolderDialog({ bucket, prefix, onClose, onDeleted }: { bucket: string; prefix: string; onClose: () => void; onDeleted: () => Promise<void> }): ReactNode {
  const info = useQuery({
    queryKey: ["folder-info", bucket, prefix],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}/folder?prefix=${encodeURIComponent(prefix)}`),
    gcTime: 0,
  });
  const name = prefix.slice(0, -1).split("/").at(-1) ?? prefix;
  const blocked = info.data ? (text(info.data.blocked) || null) : info.error ? (info.error instanceof Error ? info.error.message : String(info.error)) : "Counting objects…";
  return (
    <ConfirmDelete
      title={`Delete folder ${name}/`}
      name={name}
      what="folder"
      actionLabel={info.data ? `Delete ${plural(num(info.data.objects), "object")}` : "Delete"}
      blocked={blocked}
      onClose={onClose}
      onConfirm={async (typed) => {
        await api(`/api/buckets/${encodeURIComponent(bucket)}/folders`, { method: "DELETE", body: JSON.stringify({ prefix, confirmation: typed }) });
        await onDeleted();
      }}
    >
      <p>
        This deletes <strong>every object</strong> under <code>{`s3://${bucket}/${prefix}`}</code>:
      </p>
      {info.data ? (
        <dl className="stats">
          <div><dt>Objects</dt><dd>{formatCount(info.data.objects)}{info.data.truncated ? "+" : ""}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(info.data.bytes)}</dd></div>
        </dl>
      ) : null}
      <p className="small">Counted live from the store just now. On a versioned bucket older versions are kept and a delete marker is added. It cannot be undone from here.</p>
    </ConfirmDelete>
  );
}

function protectedNote(prefixes: string[], prefix: string, includeChildren: boolean): string | null {
  const hit = prefixes.find((item) => item && (prefix.startsWith(item) || (includeChildren && item.startsWith(prefix))));
  return hit ? `${hit} is a protected prefix. Remove it in Settings first.` : null;
}

function prefixFromUrl(): string {
  if (window.location.pathname !== "/") return "";
  const value = new URLSearchParams(window.location.search).get("prefix") ?? "";
  return value && !value.endsWith("/") ? `${value}/` : value;
}

export async function indexBucket(bucket: string): Promise<void> {
  const job = await api<{ jobId: string }>(`/api/buckets/${encodeURIComponent(bucket)}/index`, { method: "POST", body: "{}" });
  go(`/jobs?started=${job.jobId}`);
}

export function qs(values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}