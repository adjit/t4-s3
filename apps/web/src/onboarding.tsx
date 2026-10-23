import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { go, useBucket } from "./ctx";
import { formatBytes, formatCount, num, text, type Row } from "./format";
import { Icon } from "./icons";
import { ErrorText } from "./ui";

const STEPS = ["Connect", "Choose bucket", "Index"];

/**
 * First run: shown until at least one bucket is indexed. Three steps, then the normal app.
 */
export function Onboarding({ connections, tracked, onSkip, onSignOut }: { connections: Row[]; tracked: Row[]; onSkip: () => void; onSignOut: () => void }): ReactNode {
  const [connectionId, setConnectionId] = useState(() => text(tracked[0]?.connection_id) || text(connections[0]?.connection_id));
  const [bucket, setBucket] = useState(() => text(tracked[0]?.bucket));
  const [step, setStep] = useState(() => (tracked[0] ? 2 : connections[0] ? 1 : 0));

  return (
    <div className="gate onb">
      <div className="onb-wrap">
        <div className="gate-brand">
          <span className="logo"><Icon name="bucket" /></span>
          S3 Browser
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <h1>Browse and clean up S3-compatible storage</h1>
          <p className="mut">
            See what is in your buckets, find space you can reclaim, and clean it up safely. Nothing is ever deleted without a plan you review and approve.
          </p>
        </div>
        <ol className="onb-steps" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} className={index < step ? "done" : index === step ? "cur" : undefined} aria-current={index === step ? "step" : undefined}>
              <span className="dot">{index < step ? <Icon name="check" /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <section className="card onb-card">
          {step === 0 ? (
            <ConnectStep onDone={(id) => { setConnectionId(id); setStep(1); }} />
          ) : null}
          {step === 1 ? (
            <BucketStep
              connections={connections}
              connectionId={connectionId}
              onConnection={setConnectionId}
              onBack={() => setStep(0)}
              onDone={(name) => { setBucket(name); setStep(2); }}
            />
          ) : null}
          {step === 2 ? <IndexStep connectionId={connectionId || text(tracked.find((row) => text(row.bucket) === bucket)?.connection_id)} bucket={bucket} onBack={() => setStep(1)} /> : null}
        </section>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="link" type="button" onClick={onSkip}>Skip setup and open the app</button>
          <button className="link" type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

function ConnectStep({ onDone }: { onDone: (connectionId: string) => void }): ReactNode {
  const client = useQueryClient();
  const [form, setForm] = useState({ name: "", endpoint: "", accessKeyId: "", secretAccessKey: "", region: "us-east-1", urlStyle: "path", tlsVerify: true });
  const [test, setTest] = useState<{ ok: boolean; summary: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setTest(null);
  };
  const payload = () => ({
    name: form.name.trim() || hostOf(form.endpoint),
    providerHint: "other",
    endpoint: form.endpoint.trim(),
    region: form.region.trim() || "us-east-1",
    urlStyle: form.urlStyle,
    useSsl: !form.endpoint.trim().toLowerCase().startsWith("http://"),
    tlsVerify: form.tlsVerify,
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretAccessKey,
  });
  const runTest = async (): Promise<void> => {
    setError(null);
    setBusy("test");
    try {
      setTest(await api<{ ok: boolean; summary: string }>("/api/connections/test", { method: "POST", body: JSON.stringify(payload()) }));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy("");
    }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy("save");
    try {
      const checked = test ?? (await api<{ ok: boolean; summary: string }>("/api/connections/test", { method: "POST", body: JSON.stringify(payload()) }));
      setTest(checked);
      if (!checked.ok) {
        setBusy("");
        return;
      }
      const result = await api<{ connectionId: string }>("/api/connections", { method: "POST", body: JSON.stringify(payload()) });
      await client.invalidateQueries({ queryKey: ["connections"] });
      onDone(result.connectionId);
    } catch (caught) {
      setError(caught);
      setBusy("");
    }
  };
  return (
    <form className="stack" style={{ gap: 18 }} onSubmit={(event) => void save(event)}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Connect your first store</h2>
        <p className="mut">A connection is an S3 endpoint plus the access key this app uses to read it. AWS S3, MinIO, Ceph, and Pure FlashBlade all work.</p>
      </div>
      <div className="f">
        <label htmlFor="o-endpoint">Endpoint URL</label>
        <input id="o-endpoint" type="text" value={form.endpoint} placeholder="https://s3.us-east-1.amazonaws.com" autoFocus onChange={(event) => set({ endpoint: event.target.value })} />
        <span className="hint">
          Running the optional local MinIO from this repo?{" "}
          <button
            className="link"
            type="button"
            onClick={() => set({ name: "Local MinIO", endpoint: "http://minio:9000", accessKeyId: "t4admin", secretAccessKey: "t4secret-change-me", urlStyle: "path" })}
          >
            Fill in its dev values
          </button>
        </span>
      </div>
      <div className="row2">
        <div className="f">
          <label htmlFor="o-key">Access key ID</label>
          <input id="o-key" type="text" autoComplete="off" value={form.accessKeyId} onChange={(event) => set({ accessKeyId: event.target.value })} />
        </div>
        <div className="f">
          <label htmlFor="o-secret">Secret access key</label>
          <input id="o-secret" type="password" autoComplete="off" value={form.secretAccessKey} onChange={(event) => set({ secretAccessKey: event.target.value })} />
        </div>
      </div>
      <div className="f">
        <label htmlFor="o-name">Name (optional)</label>
        <input id="o-name" type="text" value={form.name} placeholder={hostOf(form.endpoint) || "Production lake"} onChange={(event) => set({ name: event.target.value })} />
      </div>
      <details className="onb-more">
        <summary>More options</summary>
        <div className="stack" style={{ gap: 14, marginTop: 12 }}>
          <div className="f">
            <label htmlFor="o-region">Region</label>
            <input id="o-region" type="text" value={form.region} onChange={(event) => set({ region: event.target.value })} />
            <span className="hint">Leave as is if your store ignores regions.</span>
          </div>
          <fieldset className="f">
            <legend>Address style</legend>
            <label className="rd"><input type="radio" name="o-style" checked={form.urlStyle === "path"} onChange={() => set({ urlStyle: "path" })} />Path style (MinIO, Ceph, most stores inside your network)</label>
            <label className="rd"><input type="radio" name="o-style" checked={form.urlStyle === "virtual"} onChange={() => set({ urlStyle: "virtual" })} />Virtual-hosted style (AWS S3)</label>
          </fieldset>
          <label className="toggle"><input type="checkbox" checked={form.tlsVerify} onChange={(event) => set({ tlsVerify: event.target.checked })} />Verify TLS certificates</label>
        </div>
      </details>
      {test ? <p className={test.ok ? "result" : "result bad"} role="status">{test.ok ? "Connected. " : "Could not connect. "}{test.summary}</p> : null}
      <ErrorText error={error} />
      <div className="row">
        <button className="btn pri" type="submit" disabled={!form.endpoint.trim() || busy !== ""}>{busy === "save" ? "Connecting…" : "Save and continue"}</button>
        <button className="btn" type="button" disabled={!form.endpoint.trim() || busy !== ""} onClick={() => void runTest()}>{busy === "test" ? "Testing…" : "Test connection"}</button>
      </div>
      <p className="small">The access key is stored on the server running this app, not in your browser. Read access is enough to browse; nothing is changed until you allow it per bucket.</p>
    </form>
  );
}

function BucketStep({
  connections,
  connectionId,
  onConnection,
  onBack,
  onDone,
}: {
  connections: Row[];
  connectionId: string;
  onConnection: (id: string) => void;
  onBack: () => void;
  onDone: (bucket: string) => void;
}): ReactNode {
  const client = useQueryClient();
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const live = useQuery({
    queryKey: ["store-buckets", connectionId],
    queryFn: () => api<{ buckets: string[] }>(`/api/connections/${encodeURIComponent(connectionId)}/buckets`),
    enabled: Boolean(connectionId),
  });
  const names = live.data?.buckets ?? [];
  useEffect(() => {
    if (!picked && names.length === 1) setPicked(names[0] ?? "");
  }, [names, picked]);
  const choice = typed.trim() || picked;
  const next = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api("/api/buckets", { method: "POST", body: JSON.stringify({ bucket: choice, connectionId, writeEnabled: false }) });
      await client.invalidateQueries({ queryKey: ["buckets"] });
      onDone(choice);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Choose a bucket</h2>
        <p className="mut">Pick the bucket to explore first. You can add more buckets and connections later from the sidebar.</p>
      </div>
      {connections.length > 1 ? (
        <div className="f">
          <label htmlFor="o-conn">Connection</label>
          <select id="o-conn" value={connectionId} onChange={(event) => { onConnection(event.target.value); setPicked(""); }}>
            {connections.map((row) => <option key={text(row.connection_id)} value={text(row.connection_id)}>{text(row.name)} ({text(row.endpoint)})</option>)}
          </select>
        </div>
      ) : null}
      {live.isLoading ? <p className="mut">Listing buckets…</p> : null}
      {live.error ? (
        <p className="result bad">Could not list buckets: {live.error instanceof Error ? live.error.message : String(live.error)}. Check the endpoint and key, or type a bucket name below.</p>
      ) : null}
      {names.length ? (
        <ul className="bk" role="radiogroup" aria-label="Buckets">
          {names.map((name) => (
            <li key={name}>
              <label className="rd" style={{ width: "100%" }}>
                <input type="radio" name="o-bucket" checked={picked === name && !typed} onChange={() => { setPicked(name); setTyped(""); }} />
                {name}
              </label>
            </li>
          ))}
        </ul>
      ) : !live.isLoading && !live.error ? (
        <p className="mut">This key cannot list any buckets. If it only has access to one bucket, type its name below.</p>
      ) : null}
      <div className="f">
        <label htmlFor="o-typed">{names.length ? "Or type a bucket name" : "Bucket name"}</label>
        <input id="o-typed" type="text" value={typed} placeholder="my-bucket" onChange={(event) => setTyped(event.target.value)} />
      </div>
      <ErrorText error={error} />
      <div className="row">
        <button className="btn pri" type="button" disabled={!choice || busy} onClick={() => void next()}>{busy ? "Adding…" : "Continue"}</button>
        <button className="btn" type="button" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

function IndexStep({ connectionId, bucket, onBack }: { connectionId: string; bucket: string; onBack: () => void }): ReactNode {
  const client = useQueryClient();
  const { select } = useBucket();
  const [jobId, setJobId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<Row>(`/api/jobs/${encodeURIComponent(jobId)}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (["done", "failed", "error"].includes(text(query.state.data?.status)) ? false : 1000),
  });
  const status = text(job.data?.status);
  const result = (job.data?.result ?? {}) as Row;
  const start = async (): Promise<void> => {
    setError(null);
    try {
      const started = await api<{ jobId: string }>(`/api/buckets/${encodeURIComponent(bucket)}/index`, { method: "POST", body: "{}" });
      setJobId(started.jobId);
    } catch (caught) {
      setError(caught);
    }
  };
  const finish = async (): Promise<void> => {
    select(connectionId, bucket);
    window.history.replaceState(null, "", "/");
    await client.invalidateQueries({ queryKey: ["buckets"] });
    go("/");
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Index {bucket}</h2>
        <p className="mut">
          The app lists the bucket once and keeps a local index of keys, sizes, and dates. Browsing, search, and SQL then run against that index, so they are fast
          and do not add load to your store. Indexing only reads; nothing in the bucket changes. Re-index any time from the bucket card.
        </p>
      </div>
      {!jobId ? (
        <div className="row">
          <button className="btn pri" type="button" onClick={() => void start()}>Start indexing</button>
          <button className="btn" type="button" onClick={onBack}>Back</button>
        </div>
      ) : status === "done" ? (
        <>
          <p className="result">Indexed {formatCount(result.rows)} objects ({formatBytes(result.bytes)}).</p>
          <div><button className="btn pri" type="button" onClick={() => void finish()}>Open {bucket} in Browse</button></div>
        </>
      ) : status === "failed" || status === "error" ? (
        <>
          <p className="result bad">Indexing failed: {text(job.data?.error) || "unknown error"}</p>
          <div className="row">
            <button className="btn pri" type="button" onClick={() => void start()}>Try again</button>
            <button className="btn" type="button" onClick={onBack}>Choose another bucket</button>
          </div>
        </>
      ) : (
        <div className="stack">
          <div className="bar" style={{ maxWidth: 420 }}><span style={{ flex: `0 0 ${Math.max(5, Math.round(num(job.data?.progress) * 100))}%`, background: "var(--primary)" }} /></div>
          <span className="small">{text(job.data?.message) || "Listing objects"}…</span>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).hostname;
  } catch {
    return "";
  }
}
