import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { indexBucket } from "./browse";
import { go, setTheme, useBucket } from "./ctx";
import { asRecord, formatBytes, formatCount, indexLabel, text, type Row } from "./format";
import { Icon } from "./icons";
import { ConfirmDelete, Crumbs, Empty, ErrorText } from "./ui";

type Tab = "connections" | "new" | "buckets" | "appearance";

const TABS: Array<[Tab, string]> = [
  ["connections", "Connections"],
  ["new", "New connection"],
  ["buckets", "Indexed buckets"],
  ["appearance", "Appearance"],
];

function tabFromUrl(): Tab | null {
  const value = new URLSearchParams(window.location.search).get("tab");
  return TABS.some(([id]) => id === value) ? (value as Tab) : null;
}

export function Settings(): ReactNode {
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Row[]>("/api/connections") });
  const [tab, setTabState] = useState<Tab | null>(() => tabFromUrl());
  const [selected, setSelected] = useState("");

  useEffect(() => {
    const onPop = (): void => setTabState(tabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const rows = connections.data ?? [];
  const active: Tab = tab ?? (connections.isSuccess && rows.length === 0 ? "new" : "connections");
  const setTab = (next: Tab): void => {
    window.history.replaceState(null, "", next === "connections" ? "/settings" : `/settings?tab=${next}`);
    setTabState(next);
  };
  const label = TABS.find(([id]) => id === active)?.[1] ?? "";

  return (
    <div className="page">
      <Crumbs
        items={
          active === "new"
            ? [{ label: "Settings", onClick: () => setTab("connections") }, { label: "Connections", onClick: () => setTab("connections") }, { label: "New connection" }]
            : [{ label: "Settings", onClick: () => setTab("connections") }, { label }]
        }
      />
      <div className="stack" style={{ gap: 4 }}>
        <h1>{active === "new" ? "Connect an S3 store" : "Settings"}</h1>
        <p className="mut">
          {active === "new"
            ? "Works with AWS S3, Pure Storage FlashBlade, MinIO, Ceph, and other S3-compatible stores."
            : "Connections, the buckets this browser indexes, and how the app looks."}
        </p>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={active === id} className={active === id ? "on" : undefined} onClick={() => setTab(id)}>
            {name}{id === "connections" && rows.length ? ` (${rows.length})` : ""}
          </button>
        ))}
      </div>
      {active === "new" ? (
        <NewConnection
          onCancel={() => setTab("connections")}
          onDone={(id) => { setSelected(id); setTab("connections"); }}
        />
      ) : null}
      {active === "connections" ? (
        <Connections rows={rows} loading={connections.isLoading} error={connections.error} selected={selected} onSelect={setSelected} onAdd={() => setTab("new")} />
      ) : null}
      {active === "buckets" ? <TrackedBuckets /> : null}
      {active === "appearance" ? <Appearance /> : null}
    </div>
  );
}

/* New connection (design screen 5) ------------------------------------------ */

const STORE_TYPES: Array<[string, string]> = [
  ["aws", "Amazon S3"],
  ["pure", "Pure Storage FlashBlade"],
  ["minio", "MinIO"],
  ["ceph", "Ceph"],
  ["other", "Other S3-compatible"],
];

function NewConnection({ onCancel, onDone }: { onCancel: () => void; onDone: (connectionId: string) => void }): ReactNode {
  const client = useQueryClient();
  const { setBucket } = useBucket();
  const [form, setForm] = useState({
    name: "",
    providerHint: "minio",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    region: "us-east-1",
    urlStyle: "path",
    cert: "system" as "system" | "custom" | "off",
    caBundlePath: "",
    rate: "",
  });
  const [test, setTest] = useState<{ ok: boolean; summary: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedId, setSavedId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const storeBuckets = useQuery({
    queryKey: ["store-buckets", savedId],
    queryFn: () => api<{ buckets: string[] }>(`/api/connections/${encodeURIComponent(savedId)}/buckets`),
    enabled: Boolean(savedId),
  });

  const payload = () => ({
    name: form.name.trim(),
    providerHint: form.providerHint,
    endpoint: form.endpoint.trim(),
    region: form.region.trim() || "us-east-1",
    urlStyle: form.urlStyle,
    useSsl: !form.endpoint.trim().toLowerCase().startsWith("http://"),
    tlsVerify: form.cert !== "off",
    caBundlePath: form.cert === "custom" && form.caBundlePath.trim() ? form.caBundlePath.trim() : null,
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretAccessKey,
    requestRatePerSec: form.rate.trim() ? Number(form.rate) : null,
  });

  const runTest = async (): Promise<void> => {
    setError(null);
    setTest(null);
    setTesting(true);
    try {
      setTest(await api<{ ok: boolean; summary: string }>("/api/connections/test", { method: "POST", body: JSON.stringify(payload()) }));
    } catch (caught) {
      setError(caught);
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const result = await api<{ connectionId: string }>("/api/connections", { method: "POST", body: JSON.stringify(payload()) });
      setSavedId(result.connectionId);
      await client.invalidateQueries({ queryKey: ["connections"] });
    } catch (caught) {
      setError(caught);
    }
  };

  const addAndIndex = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      for (const bucket of picked) {
        await api("/api/buckets", { method: "POST", body: JSON.stringify({ bucket, connectionId: savedId, writeEnabled: false }) });
      }
      await client.invalidateQueries({ queryKey: ["buckets"] });
      if (picked[0]) setBucket(picked[0]);
      for (const bucket of picked.slice(1)) {
        await api(`/api/buckets/${encodeURIComponent(bucket)}/index`, { method: "POST", body: "{}" });
      }
      if (picked[0]) await indexBucket(picked[0]);
      else onDone(savedId);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(form.name.trim() && form.endpoint.trim());
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setTest(null);
  };

  return (
    <div className="cols">
      <form className="card form" onSubmit={(event) => void save(event)}>
        <div className="row2">
          <div className="f">
            <label htmlFor="c-name">Connection name</label>
            <input id="c-name" type="text" value={form.name} placeholder="Production lake" onChange={(event) => set({ name: event.target.value })} disabled={Boolean(savedId)} />
          </div>
          <div className="f">
            <label htmlFor="c-type">Store type</label>
            <select id="c-type" value={form.providerHint} onChange={(event) => set({ providerHint: event.target.value, urlStyle: event.target.value === "aws" ? "virtual" : "path" })} disabled={Boolean(savedId)}>
              {STORE_TYPES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </div>
        </div>
        <div className="f">
          <label htmlFor="c-endpoint">Endpoint URL</label>
          <input id="c-endpoint" type="text" value={form.endpoint} placeholder="https://s3.storage.example.internal" onChange={(event) => set({ endpoint: event.target.value })} disabled={Boolean(savedId)} />
          <span className="hint">From inside Docker Compose the bundled MinIO is http://minio:9000.</span>
        </div>
        <div className="row2">
          <div className="f">
            <label htmlFor="c-key">Access key ID</label>
            <input id="c-key" type="text" value={form.accessKeyId} autoComplete="off" placeholder="Paste the access key ID" onChange={(event) => set({ accessKeyId: event.target.value })} disabled={Boolean(savedId)} />
          </div>
          <div className="f">
            <label htmlFor="c-secret">Secret access key</label>
            <input id="c-secret" type="password" value={form.secretAccessKey} autoComplete="off" placeholder="Paste the secret key" onChange={(event) => set({ secretAccessKey: event.target.value })} disabled={Boolean(savedId)} />
          </div>
        </div>
        <div className="f">
          <label htmlFor="c-region">Region (optional)</label>
          <input id="c-region" type="text" value={form.region} onChange={(event) => set({ region: event.target.value })} disabled={Boolean(savedId)} />
          <span className="hint">Leave as is if your store ignores regions.</span>
        </div>
        <fieldset className="f" disabled={Boolean(savedId)}>
          <legend>Address style</legend>
          <label className="rd"><input type="radio" name="style" checked={form.urlStyle === "path"} onChange={() => set({ urlStyle: "path" })} />Path style (usual for stores inside your network)</label>
          <label className="rd"><input type="radio" name="style" checked={form.urlStyle === "virtual"} onChange={() => set({ urlStyle: "virtual" })} />Virtual-hosted style (bucket in the host name)</label>
        </fieldset>
        <fieldset className="f" disabled={Boolean(savedId)}>
          <legend>Certificate</legend>
          <label className="rd"><input type="radio" name="cert" checked={form.cert === "system"} onChange={() => set({ cert: "system" })} />Verify with the system certificates</label>
          <label className="rd"><input type="radio" name="cert" checked={form.cert === "custom"} onChange={() => set({ cert: "custom" })} />Verify with my own CA certificate</label>
          {form.cert === "custom" ? (
            <input type="text" aria-label="CA bundle path on the server" value={form.caBundlePath} placeholder="/etc/ssl/certs/my-ca.pem" onChange={(event) => set({ caBundlePath: event.target.value })} />
          ) : null}
          <label className="rd"><input type="radio" name="cert" checked={form.cert === "off"} onChange={() => set({ cert: "off" })} />Do not verify (not recommended)</label>
        </fieldset>
        <div className="f">
          <label htmlFor="c-rate">Limit list requests per second (optional)</label>
          <input id="c-rate" type="number" min="1" value={form.rate} placeholder="No limit" onChange={(event) => set({ rate: event.target.value })} disabled={Boolean(savedId)} />
          <span className="hint">Lower this on a store that serves production traffic.</span>
        </div>
        <ErrorText error={error} />
        {savedId ? (
          <p className="result">Connection saved. Pick the buckets to index on the right.</p>
        ) : (
          <div className="row">
            <button className="btn pri" type="button" disabled={!form.endpoint.trim() || testing} onClick={() => void runTest()}>{testing ? "Testing…" : "Test connection"}</button>
            <button className="btn" type="submit" disabled={!ready}>Save connection</button>
            <button className="btn" type="button" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </form>

      <div className="aside">
        <section className="card sec">
          <h2>Connection check</h2>
          {test ? (
            <ul className="cap">
              <li>
                <Icon name={test.ok ? "check" : "close"} className={`ic ${test.ok ? "ok" : "no"}`} />
                <div><strong>{test.ok ? "Reached the store" : "Could not reach the store"}</strong><span>{test.summary}</span></div>
                <em className={test.ok ? "ok" : "no"}>{test.ok ? "Passed" : "Failed"}</em>
              </li>
            </ul>
          ) : (
            <p className="mut">Test the connection to list what the key can reach. Feature support (versions, Object Lock, lifecycle) is probed per bucket after you add it.</p>
          )}
        </section>
        <section className="card sec">
          <h2>Buckets to index</h2>
          {!savedId ? (
            <p className="mut">Save the connection to list its buckets.</p>
          ) : storeBuckets.isLoading ? (
            <p className="mut">Listing buckets…</p>
          ) : (
            <>
              <ErrorText error={storeBuckets.error} />
              {(storeBuckets.data?.buckets ?? []).length === 0 ? <p className="mut">This key cannot see any buckets.</p> : (
                <ul className="bk">
                  {(storeBuckets.data?.buckets ?? []).map((name) => (
                    <li key={name}>
                      <input
                        type="checkbox"
                        id={`pick-${name}`}
                        checked={picked.includes(name)}
                        onChange={() => setPicked((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])}
                      />
                      <label htmlFor={`pick-${name}`} className="strong">{name}</label>
                      <span>Not indexed yet</span>
                    </li>
                  ))}
                </ul>
              )}
              <button className="btn pri block" type="button" disabled={picked.length === 0 || busy} onClick={() => void addAndIndex()}>
                {busy ? "Adding…" : "Add and start indexing"}
              </button>
              <button className="link" type="button" onClick={() => onDone(savedId)}>Skip for now</button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* Connections ---------------------------------------------------------------- */

function Connections({
  rows,
  loading,
  error,
  selected,
  onSelect,
  onAdd,
}: {
  rows: Row[];
  loading: boolean;
  error: unknown;
  selected: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}): ReactNode {
  const { bucket } = useBucket();
  const [removing, setRemoving] = useState<Row | null>(null);
  const tracked = useQuery({ queryKey: ["buckets"], queryFn: () => api<Row[]>("/api/buckets") });
  useEffect(() => {
    if (!rows.length || !tracked.isSuccess) return;
    if (!selected || !rows.some((row) => text(row.connection_id) === selected)) {
      // Start on the connection that owns the bucket in use.
      const owner = text(tracked.data.find((row) => text(row.bucket) === bucket)?.connection_id);
      onSelect(owner && rows.some((row) => text(row.connection_id) === owner) ? owner : text(rows[0]?.connection_id));
    }
  }, [rows, selected, onSelect, tracked.isSuccess, tracked.data, bucket]);

  if (loading) return <p className="mut">Loading connections…</p>;
  if (!rows.length) {
    return (
      <div className="card">
        <Empty title="No connections yet" body="Each connection is one S3 endpoint and the access key this app uses for it." action="Connect a store" onClick={onAdd} />
      </div>
    );
  }
  const connection = rows.find((row) => text(row.connection_id) === selected);
  return (
    <>
      <ErrorText error={error} />
      <section className="card">
        <div className="tw">
          <table className="tbl">
            <thead>
              <tr><th>Connection</th><th>Endpoint</th><th>Access key</th><th className="num">Indexed buckets</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = text(row.connection_id);
                const count = (tracked.data ?? []).filter((bucket) => text(bucket.connection_id) === id).length;
                return (
                  <tr key={id} className={`click${id === selected ? " sel" : ""}`} onClick={() => onSelect(id)}>
                    <td><div className="nm"><Icon name="bucket" /><span className="name">{text(row.name)}</span><span className="badge b-n">{text(row.provider_hint)}</span></div></td>
                    <td><code>{text(row.endpoint)}</code></td>
                    <td>{text(row.access_key_id) || <span className="mut">Default chain</span>}</td>
                    <td className="num">{count}</td>
                    <td className="num">
                      <button className="link" type="button" style={{ color: "var(--danger)" }} onClick={(event) => { event.stopPropagation(); setRemoving(row); }}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="more"><button className="btn sm" type="button" onClick={onAdd}>Connect another store</button></div>
      </section>
      {connection ? <ConnectionDetail key={selected} connection={connection} tracked={tracked.data ?? []} onRemove={() => setRemoving(connection)} /> : null}
      {removing ? <RemoveConnection connection={removing} tracked={tracked.data ?? []} onClose={() => setRemoving(null)} /> : null}
    </>
  );
}

function ConnectionDetail({ connection, tracked, onRemove }: { connection: Row; tracked: Row[]; onRemove: () => void }): ReactNode {
  const id = text(connection.connection_id);
  const [storeBucket, setStoreBucket] = useState("");
  const [deleting, setDeleting] = useState("");
  const buckets = useQuery({
    queryKey: ["store-buckets", id],
    queryFn: () => api<{ buckets: string[] }>(`/api/connections/${encodeURIComponent(id)}/buckets`),
  });
  const names = buckets.data?.buckets ?? [];
  useEffect(() => {
    if (!storeBucket && names[0]) setStoreBucket(names[0]);
  }, [names, storeBucket]);


  return (
    <div className="cols">
      <div className="aside" style={{ flex: "1 1 460px" }}>
        <section className="card sec">
          <div className="t">
            <div className="stack" style={{ gap: 2 }}>
              <h2>{text(connection.name)}</h2>
              <span className="small">
                <code>{text(connection.endpoint)}</code> · {text(connection.region) || "us-east-1"} · {text(connection.url_style) === "virtual" ? "virtual-hosted" : "path"} style · TLS {connection.tls_verify === false ? "not verified" : "verified"}
              </span>
            </div>
            <button className="btn sm danger-outline" type="button" onClick={onRemove}><Icon name="trash" />Remove connection</button>
          </div>
        </section>
        <AccessKey connection={connection} />
        {storeBucket ? <Policy connectionId={id} bucket={storeBucket} /> : null}
      </div>
      <div className="aside">
        <section className="card sec">
          <h2>Buckets in this store</h2>
          <ErrorText error={buckets.error} />
          {buckets.isLoading ? <p className="mut">Listing buckets…</p> : buckets.error ? <p className="mut">Check the endpoint and access key, then try again.</p> : names.length === 0 ? <p className="mut">This key cannot see any buckets.</p> : (
            <ul className="bk">
              {names.map((name) => (
                <StoreBucketRow
                  key={name}
                  connectionId={id}
                  name={name}
                  tracked={tracked.find((row) => text(row.bucket) === name && text(row.connection_id) === id)}
                  elsewhere={tracked.some((row) => text(row.bucket) === name && text(row.connection_id) !== id)}
                  selected={name === storeBucket}
                  onSelect={() => setStoreBucket(name)}
                  onDelete={() => setDeleting(name)}
                />
              ))}
            </ul>
          )}
          <CreateBucket connectionId={id} onCreated={setStoreBucket} />
        </section>
      </div>
      {deleting ? (
        <DeleteBucket
          connectionId={id}
          bucket={deleting}
          tracked={tracked.find((row) => text(row.bucket) === deleting)}
          onClose={() => setDeleting("")}
          onDeleted={() => { if (storeBucket === deleting) setStoreBucket(""); setDeleting(""); }}
        />
      ) : null}
    </div>
  );
}

function RemoveConnection({ connection, tracked, onClose }: { connection: Row; tracked: Row[]; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const { connectionId, select } = useBucket();
  const id = text(connection.connection_id);
  const name = text(connection.name);
  const owned = tracked.filter((row) => text(row.connection_id) === id).map((row) => text(row.bucket));
  return (
    <ConfirmDelete
      title={`Remove connection ${name}`}
      name={name}
      what="connection"
      actionLabel="Remove connection"
      onClose={onClose}
      onConfirm={async () => {
        await api(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (connectionId === id) select("", "");
        onClose();
        await client.invalidateQueries({ queryKey: ["connections"] });
        await client.invalidateQueries({ queryKey: ["buckets"] });
        client.removeQueries({ queryKey: ["store-buckets", id] });
      }}
    >
      <p>
        Removes <strong>{name}</strong> (<code>{text(connection.endpoint)}</code>) and its stored access key from this app. Nothing in the store is deleted.
      </p>
      {owned.length ? (
        <p className="note"><span>
          {owned.length === 1 ? "This bucket stops" : `These ${owned.length} buckets stop`} being indexed and {owned.length === 1 ? "its" : "their"} local index is cleared: <strong>{owned.join(", ")}</strong>. Plans, jobs, and the audit log are kept. A connection with an approved or running plan cannot be removed.
        </span></p>
      ) : (
        <p className="small">No buckets are indexed through this connection.</p>
      )}
    </ConfirmDelete>
  );
}

function DeleteBucket({ connectionId, bucket, tracked, onClose, onDeleted }: { connectionId: string; bucket: string; tracked?: Row; onClose: () => void; onDeleted: () => void }): ReactNode {
  const client = useQueryClient();
  const { bucket: active, connectionId: activeConnection, select } = useBucket();
  const blocked = tracked && tracked.write_enabled !== true
    ? `Writes are off for ${bucket}. Turn on "Allow plans to change this bucket" under Indexed buckets before deleting it.`
    : null;
  return (
    <ConfirmDelete
      title={`Delete bucket ${bucket}`}
      name={bucket}
      what="bucket"
      actionLabel="Delete bucket"
      blocked={blocked}
      onClose={onClose}
      onConfirm={async (typed) => {
        await api(`/api/connections/${encodeURIComponent(connectionId)}/buckets/${encodeURIComponent(bucket)}`, { method: "DELETE", body: JSON.stringify({ confirmation: typed }) });
        if (active === bucket) select(activeConnection, "");
        onDeleted();
        await client.invalidateQueries({ queryKey: ["store-buckets", connectionId] });
        await client.invalidateQueries({ queryKey: ["buckets"] });
      }}
    >
      <p>Deletes the bucket <strong>{bucket}</strong> from the store.</p>
      <p className="note"><span>Only empty buckets can be deleted. If it still has objects (or older versions), the delete is refused and nothing changes: remove its folders and files first. This app never empties a bucket in one step.</span></p>
    </ConfirmDelete>
  );
}

function StoreBucketRow({ connectionId, name, tracked, elsewhere, selected, onSelect, onDelete }: { connectionId: string; name: string; tracked?: Row; elsewhere: boolean; selected: boolean; onSelect: () => void; onDelete: () => void }): ReactNode {
  const client = useQueryClient();
  const { setBucket } = useBucket();
  const [error, setError] = useState<unknown>(null);
  const track = async (): Promise<void> => {
    setError(null);
    try {
      await api("/api/buckets", { method: "POST", body: JSON.stringify({ bucket: name, connectionId, writeEnabled: false }) });
      await client.invalidateQueries({ queryKey: ["buckets"] });
      setBucket(name);
      await indexBucket(name);
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <li style={{ flexWrap: "wrap" }}>
      <button className="link" type="button" style={{ fontWeight: selected ? 600 : 500, color: selected ? "var(--primary-text)" : "var(--text)" }} onClick={onSelect}>
        {name}
      </button>
      {tracked ? (
        <span className="small">{indexLabel(tracked.indexAgeSeconds, tracked.indexedAt)}</span>
      ) : elsewhere ? (
        <span className="small">Indexed through another connection</span>
      ) : null}
      <span>
        {elsewhere ? null : tracked ? (
          <button className="link" type="button" onClick={() => { setBucket(name); go("/"); }}>Browse</button>
        ) : (
          <button className="link" type="button" onClick={() => void track()}>Add and index</button>
        )}
        <button className="link" type="button" style={{ color: "var(--danger)", marginLeft: 12 }} onClick={onDelete}>Delete</button>
      </span>
      {error ? <div style={{ flexBasis: "100%" }}><ErrorText error={error} /></div> : null}
    </li>
  );
}

function CreateBucket({ connectionId, onCreated }: { connectionId: string; onCreated: (name: string) => void }): ReactNode {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (bucket: string) => api(`/api/connections/${encodeURIComponent(connectionId)}/buckets`, { method: "POST", body: JSON.stringify({ name: bucket }) }),
    onSuccess: async (_result, bucket) => {
      setName("");
      await client.invalidateQueries({ queryKey: ["store-buckets", connectionId] });
      onCreated(bucket);
    },
  });
  return (
    <form
      className="f"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate(name.trim());
      }}
    >
      <label htmlFor={`new-bucket-${connectionId}`}>Create a bucket</label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input id={`new-bucket-${connectionId}`} type="text" value={name} placeholder="bucket-name" onChange={(event) => setName(event.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim() || create.isPending}>Create</button>
      </div>
      <ErrorText error={create.error} />
    </form>
  );
}

function AccessKey({ connection }: { connection: Row }): ReactNode {
  const client = useQueryClient();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/connections/${encodeURIComponent(text(connection.connection_id))}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: text(connection.name),
          endpoint: text(connection.endpoint),
          region: text(connection.region) || "us-east-1",
          urlStyle: text(connection.url_style) === "virtual" ? "virtual" : "path",
          useSsl: Boolean(connection.use_ssl),
          tlsVerify: connection.tls_verify !== false,
          caBundlePath: text(connection.ca_bundle_path) || null,
          providerHint: text(connection.provider_hint) || undefined,
          requestRatePerSec: connection.request_rate_per_sec == null ? null : Number(connection.request_rate_per_sec),
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
        }),
      }),
    onSuccess: async () => {
      setSecretAccessKey("");
      setAccessKeyId("");
      setNotice("Access key saved.");
      await client.invalidateQueries({ queryKey: ["connections"] });
    },
  });
  return (
    <form
      className="card sec"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice("");
        save.mutate();
      }}
    >
      <h2>Access key</h2>
      <p className="small">
        In use: <code>{text(connection.access_key_id) || "default credential chain"}</code>. Saving replaces the key this app uses for the store. S3 has no shared API for creating keys, so a second key is a second connection.
      </p>
      <div className="row2">
        <div className="f">
          <label htmlFor="rotate-key">New access key ID</label>
          <input id="rotate-key" type="text" value={accessKeyId} autoComplete="off" onChange={(event) => setAccessKeyId(event.target.value)} />
        </div>
        <div className="f">
          <label htmlFor="rotate-secret">New secret access key</label>
          <input id="rotate-secret" type="password" value={secretAccessKey} autoComplete="off" onChange={(event) => setSecretAccessKey(event.target.value)} />
        </div>
      </div>
      <ErrorText error={save.error} />
      {notice ? <p className="result" role="status">{notice}</p> : null}
      <div><button className="btn pri" type="submit" disabled={!accessKeyId.trim() || !secretAccessKey || save.isPending}>Save access key</button></div>
    </form>
  );
}

function Policy({ connectionId, bucket }: { connectionId: string; bucket: string }): ReactNode {
  const client = useQueryClient();
  const base = `/api/connections/${encodeURIComponent(connectionId)}/buckets/${encodeURIComponent(bucket)}/policy`;
  const policy = useQuery({ queryKey: ["policy", connectionId, bucket], queryFn: () => api<{ policy: string | null }>(base) });
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const value = policy.data?.policy;
    setDraft(value ? pretty(value) : "");
    setNotice("");
  }, [bucket, policy.data]);

  const save = useMutation({
    mutationFn: () => api(base, { method: "PUT", body: JSON.stringify({ policy: draft }) }),
    onSuccess: async () => {
      setNotice("Policy saved.");
      await client.invalidateQueries({ queryKey: ["policy", connectionId, bucket] });
    },
  });
  const clear = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: async () => {
      setDraft("");
      setNotice("Policy removed. The bucket is private.");
      await client.invalidateQueries({ queryKey: ["policy", connectionId, bucket] });
    },
  });

  return (
    <form
      className="card sec"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice("");
        save.mutate();
      }}
    >
      <div className="t">
        <h2>Bucket policy for {bucket}</h2>
        {policy.data ? <span className={`badge ${policy.data.policy ? "b-warn" : "b-ok"}`}>{policy.data.policy ? "Has a policy" : "Private"}</span> : null}
      </div>
      <p className="small">This is the S3 bucket policy. Leaving it empty keeps the bucket private to the access key above. Changes apply to the store immediately.</p>
      {policy.isLoading ? <p className="mut">Loading policy…</p> : null}
      <ErrorText error={policy.error} />
      <div className="f">
        <label htmlFor="policy-json">Policy JSON</label>
        <textarea id="policy-json" value={draft} spellCheck={false} placeholder="{ }" onChange={(event) => setDraft(event.target.value)} />
      </div>
      <ErrorText error={save.error ?? clear.error} />
      {notice ? <p className="result" role="status">{notice}</p> : null}
      <div className="row">
        <button className="btn pri" type="submit" disabled={!draft.trim() || save.isPending}>Save policy</button>
        <button className="btn" type="button" onClick={() => setDraft(readPolicy(bucket))}>Use public-read template</button>
        <button className="btn" type="button" disabled={clear.isPending || !policy.data?.policy} onClick={() => clear.mutate()}>Make private</button>
      </div>
    </form>
  );
}

/* Indexed buckets -------------------------------------------------------- */

function TrackedBuckets(): ReactNode {
  const { bucket } = useBucket();
  const buckets = useQuery({ queryKey: ["buckets"], queryFn: () => api<Row[]>("/api/buckets") });
  const rows = buckets.data ?? [];
  if (buckets.isLoading) return <p className="mut">Loading buckets…</p>;
  if (!rows.length) {
    return <div className="card"><Empty title="No buckets are indexed yet" body="Pick buckets from a connection to index them." action="Open Connections" href="/settings" /></div>;
  }
  return (
    <>
      <ErrorText error={buckets.error} />
      {rows.map((row) => <BucketSettings key={text(row.bucket)} row={row} selected={text(row.bucket) === bucket} />)}
    </>
  );
}

const CAPABILITIES: Array<[string, string, string]> = [
  ["list_objects", "List objects", "Needed to index the bucket."],
  ["versioning", "Versions", ""],
  ["multipart", "Incomplete uploads", "Lets Maintenance find and abort orphaned uploads."],
  ["tagging", "Object tags", ""],
  ["object_lock", "Object Lock", "Locked objects are always skipped by plans."],
  ["lifecycle", "Lifecycle rules", "Maintenance checks coverage of cached rules."],
  ["inventory", "S3 Inventory", "Without it, indexing crawls the bucket instead."],
  ["presign", "Signed downloads", ""],
];

function BucketSettings({ row, selected }: { row: Row; selected: boolean }): ReactNode {
  const client = useQueryClient();
  const { setBucket } = useBucket();
  const name = text(row.bucket);
  const [prefixes, setPrefixes] = useState(Array.isArray(row.protected_prefixes) ? (row.protected_prefixes as string[]).join(", ") : "");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const caps = asRecord(row.capabilities);
  const notes = asRecord(caps.notes);
  const patch = useMutation({
    mutationFn: (body: Row) => api(`/api/buckets/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["buckets"] });
      await client.invalidateQueries({ queryKey: ["summary", name] });
    },
  });
  const run = async (work: () => Promise<void>): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      await work();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="cols">
      <section className="card sec" style={{ flex: "1 1 460px" }}>
        <div className="t">
          <div className="stack" style={{ gap: 2 }}>
            <h2>{name}{selected ? <span className="badge b-ice" style={{ marginLeft: 8 }}>In use</span> : null}</h2>
            <span className="small">{indexLabel(row.indexAgeSeconds, row.indexedAt)} · index mode {text(row.index_mode) || "crawl"}</span>
          </div>
          <div className="row">
            {!selected ? <button className="btn sm" type="button" onClick={() => setBucket(name)}>Use</button> : null}
            <button className="btn sm" type="button" onClick={() => void run(async () => {
              const result = await api<Row>(`/api/buckets/${encodeURIComponent(name)}/index/estimate`, { method: "POST", body: "{}" });
              setNotice(`A crawl takes about ${formatCount(result.listRequests)} list requests. Pagination can add more.`);
            })}>Estimate</button>
            <button className="btn sm pri" type="button" onClick={() => void run(() => indexBucket(name))}>Index now</button>
          </div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={patch.isPending && typeof patch.variables?.writeEnabled === "boolean" ? patch.variables.writeEnabled : row.write_enabled === true} onChange={(event) => patch.mutate({ writeEnabled: event.target.checked })} />
          <span><strong>Allow plans to change this bucket</strong><br /><span className="small">Off means plans can be dry run and approved, but never run.</span></span>
        </label>
        <div className="f">
          <label htmlFor={`prot-${name}`}>Protected prefixes</label>
          <input
            id={`prot-${name}`}
            type="text"
            value={prefixes}
            placeholder="e.g. backups/, legal/"
            onChange={(event) => setPrefixes(event.target.value)}
            onBlur={() => patch.mutate({ protectedPrefixes: prefixes.split(",").map((item) => item.trim()).filter(Boolean) })}
          />
          <span className="hint">Comma separated. Plans always skip these. Saved when you leave the field.</span>
        </div>
        {notice ? <p className="result">{notice}</p> : null}
        <ErrorText error={error ?? patch.error} />
      </section>
      <section className="card sec" style={{ flex: "1 1 380px" }}>
        <div className="t">
          <h2>What this store supports</h2>
          <button className="btn sm" type="button" onClick={() => void run(async () => {
            await api(`/api/buckets/${encodeURIComponent(name)}/probe`, { method: "POST", body: "{}" });
            await client.invalidateQueries({ queryKey: ["buckets"] });
            setNotice("Probe finished.");
          })}>Probe again</button>
        </div>
        {row.capabilities ? (
          <ul className="cap">
            {CAPABILITIES.map(([key, label, hint]) => {
              const value = text(caps[key]);
              const ok = value === "supported";
              const extra = key === "versioning" && ok ? `Versioning is ${caps.versioning_enabled ? "on" : "off"} for ${name}.` : text(notes[key]) || hint;
              return (
                <li key={key}>
                  <Icon name={ok ? "check" : "dash"} className={`ic ${ok ? "ok" : "no"}`} />
                  <div><strong>{label}</strong>{extra ? <span>{extra}</span> : null}</div>
                  <em className={ok ? "ok" : "no"}>{ok ? "Supported" : value === "not_tested" ? "Not tested" : value ? "Not supported" : "Unknown"}</em>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mut">Not probed yet. Probing makes a few read-only requests to see which S3 features the store has.</p>
        )}
      </section>
    </div>
  );
}

/* Appearance ------------------------------------------------------------- */

function Appearance(): ReactNode {
  const [theme, setThemeState] = useState(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const pick = (next: "light" | "dark"): void => {
    setTheme(next);
    setThemeState(next);
  };
  return (
    <section className="card sec" style={{ maxWidth: 560 }}>
      <h2>Theme</h2>
      <fieldset className="f">
        <legend className="sr-only">Theme</legend>
        <label className="rd"><input type="radio" name="theme" checked={theme === "light"} onChange={() => pick("light")} />Light</label>
        <label className="rd"><input type="radio" name="theme" checked={theme === "dark"} onChange={() => pick("dark")} />Dark</label>
      </fieldset>
      <p className="small">Saved in this browser.</p>
      <p className="small">Sizes are shown in binary units ({formatBytes(1024 * 1024)} = 1,048,576 bytes).</p>
    </section>
  );
}

function readPolicy(bucket: string): string {
  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [{ Sid: "ReadObjects", Effect: "Allow", Principal: "*", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/*`] }],
    },
    null,
    2,
  );
}

function pretty(policy: string): string {
  try {
    return JSON.stringify(JSON.parse(policy), null, 2);
  } catch {
    return policy;
  }
}
