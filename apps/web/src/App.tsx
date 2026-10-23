import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, clearToken, getToken, setToken, setUnauthorizedHandler } from "./api";
import { Browse } from "./browse";
import { BucketContext, go, useBucket } from "./ctx";
import { indexLabel, text, type Row } from "./format";
import { Icon, type IconName } from "./icons";
import { Jobs } from "./jobs";
import { Maintenance, PlanDetail, Plans } from "./maintenance";
import { QueryScreen } from "./query";
import { Settings } from "./settings";
import { Onboarding } from "./onboarding";
import { Switcher } from "./switcher";
import { TableDetail, Tables } from "./tables";

export { go, useBucket } from "./ctx";
export { ErrorText } from "./ui";

export function App(): ReactNode {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [path, setPath] = useState(() => window.location.pathname);
  const [bucket, setBucketState] = useState(() => localStorage.getItem("t4-bucket") ?? "");
  const [connectionId, setConnectionState] = useState(() => localStorage.getItem("t4-connection") ?? "");

  useEffect(() => setUnauthorizedHandler(() => setAuthed(false)), []);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setBucket = useCallback((next: string): void => {
    setBucketState(next);
    localStorage.setItem("t4-bucket", next);
  }, []);
  const select = useCallback((nextConnection: string, nextBucket: string): void => {
    setConnectionState(nextConnection);
    localStorage.setItem("t4-connection", nextConnection);
    setBucketState(nextBucket);
    localStorage.setItem("t4-bucket", nextBucket);
  }, []);

  if (!authed) return <TokenGate onSave={() => setAuthed(true)} />;

  const signOut = (): void => {
    clearToken();
    setAuthed(false);
  };

  return (
    <BucketContext.Provider value={{ connectionId, bucket, setBucket, select }}>
      <Shell path={path} onSignOut={signOut} />
    </BucketContext.Provider>
  );
}

const SKIP_SETUP = "t4-skip-setup";

/** First run shows a three-step setup until one bucket is indexed; after that, the full app. */
function Shell({ path, onSignOut }: { path: string; onSignOut: () => void }): ReactNode {
  const [skipped, setSkipped] = useState(() => localStorage.getItem(SKIP_SETUP) === "1");
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Row[]>("/api/connections") });
  const buckets = useQuery({ queryKey: ["buckets"], queryFn: () => api<Row[]>("/api/buckets") });
  if (connections.isLoading || buckets.isLoading) return <div className="gate" aria-busy="true" />;
  const anyIndexed = (buckets.data ?? []).some((row) => row.indexedAt != null && row.indexedAt !== "");
  const firstRun = !connections.error && !buckets.error && !anyIndexed && !skipped;
  if (firstRun) {
    return (
      <Onboarding
        connections={connections.data ?? []}
        tracked={buckets.data ?? []}
        onSignOut={onSignOut}
        onSkip={() => {
          localStorage.setItem(SKIP_SETUP, "1");
          setSkipped(true);
        }}
      />
    );
  }
  return (
    <div className="app">
      <Sidebar path={path} onSignOut={onSignOut} />
      <div className="main">{screenFor(path)}</div>
    </div>
  );
}

function TokenGate({ onSave }: { onSave: () => void }): ReactNode {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!value.trim()) return;
    setToken(value.trim());
    onSave();
  };
  return (
    <div className="gate">
      <form className="card gate-card" onSubmit={submit}>
        <div className="gate-brand">
          <span className="logo"><Icon name="bucket" /></span>
          S3 Browser
        </div>
        <div className="stack">
          <h1>Sign in with the app token</h1>
          <p>
            This unlocks the browser. It is separate from the S3 access keys you add on a connection. Docker Compose uses{" "}
            <code>local-dev-token</code>; a local pnpm dev run writes one to <code>data/dev-token.txt</code>.
          </p>
        </div>
        <div className="f">
          <label htmlFor="token">App token</label>
          <input id="token" type="password" value={value} placeholder="Paste the token" onChange={(event) => setValue(event.target.value)} autoFocus />
        </div>
        <button className="btn pri block" type="submit" disabled={!value.trim()}>Continue</button>
        <p className="small">The token stays in this browser tab and is cleared when you close it.</p>
      </form>
    </div>
  );
}

function Sidebar({ path, onSignOut }: { path: string; onSignOut: () => void }): ReactNode {
  const { bucket, connectionId, select } = useBucket();
  const [menu, setMenu] = useState(false);
  const buckets = useQuery({ queryKey: ["buckets"], queryFn: () => api<Row[]>("/api/buckets") });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Row[]>("/api/connections") });
  const findings = useQuery({
    queryKey: ["findings", bucket, "open"],
    queryFn: () => api<Row[]>(`/api/findings?bucket=${encodeURIComponent(bucket)}&status=open`),
    enabled: Boolean(bucket),
  });
  const plans = useQuery({
    queryKey: ["plans", bucket],
    queryFn: () => api<Row[]>(`/api/plans?bucket=${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });
  const summary = useQuery({
    queryKey: ["summary", bucket],
    queryFn: () => api<Row>(`/api/buckets/${encodeURIComponent(bucket)}`),
    enabled: Boolean(bucket),
  });

  const connectionRows = connections.data ?? [];
  useEffect(() => {
    if (!buckets.data || !connections.data) return;
    const ids = connections.data.map((row) => text(row.connection_id));
    const conn = ids.includes(connectionId) ? connectionId : "";
    const tracked = buckets.data.find((row) => text(row.bucket) === bucket);
    if (bucket && tracked) {
      const owner = text(tracked.connection_id);
      if (owner !== connectionId) select(owner, bucket);
      return;
    }
    // The saved bucket is gone (or none yet): stay on the connection, take its first indexed bucket.
    const fallback = buckets.data.find((row) => !conn || text(row.connection_id) === conn);
    const nextConn = fallback ? text(fallback.connection_id) : conn || ids[0] || "";
    const nextBucket = fallback ? text(fallback.bucket) : "";
    if (nextConn !== connectionId || nextBucket !== bucket) select(nextConn, nextBucket);
  }, [bucket, connectionId, buckets.data, connections.data, select]);
  const activeConnection = connectionRows.find((row) => text(row.connection_id) === connectionId);

  const openPlans = (plans.data ?? []).filter((row) => !["done", "failed", "cancelled"].includes(text(row.status))).length;
  const current = routeName(path);
  const items: Array<{ href: string; label: string; icon: IconName; on: boolean; count?: number }> = [
    { href: "/", label: "Browse", icon: "folder", on: current === "browse" },
    { href: "/tables", label: "Tables", icon: "table", on: current === "tables" || current === "table" },
    { href: "/query", label: "Query", icon: "code", on: current === "query" },
    { href: "/maintenance", label: "Maintenance", icon: "chart", on: current === "maintenance", count: findings.data?.length ?? 0 },
    { href: "/plans", label: "Plans", icon: "list", on: current === "plans" || current === "plan", count: openPlans },
    { href: "/jobs", label: "Jobs", icon: "clock", on: current === "jobs" },
    { href: "/settings", label: "Settings", icon: "sliders", on: current === "settings" },
  ];

  return (
    <nav className="nav" aria-label="Main">
      <div className="brand">S3 Browser</div>
      <div className="bucket-wrap">
        <button className="bucket" type="button" aria-label="Change connection or bucket" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
          <small>{activeConnection ? text(activeConnection.name) : "Connection"}</small>
          <span className="r"><span>{bucket || "Pick a bucket"}</span><em>{connectionRows.length ? "Change" : "Add"}</em></span>
          <small>{bucket ? indexLabel(summary.data?.indexAgeSeconds, summary.data?.indexedAt) : connectionRows.length ? "No bucket selected" : "Connect a store"}</small>
        </button>
        {menu ? (
          <Switcher
            connections={connectionRows}
            tracked={buckets.data ?? []}
            onClose={() => setMenu(false)}
          />
        ) : null}
      </div>
      <div className="nv">
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={item.on ? "on" : undefined}
            aria-current={item.on ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              go(item.href);
            }}
          >
            <Icon name={item.icon} />
            {item.label}
            {item.count != null && item.count > 0 ? <span className="n">{item.count}</span> : null}
          </a>
        ))}
      </div>
      <div className="nav-foot">
        <button type="button" onClick={onSignOut}><Icon name="logout" />Sign out</button>
      </div>
    </nav>
  );
}

function screenFor(path: string): ReactNode {
  const name = routeName(path);
  if (name === "tables") return <Tables />;
  if (name === "table") return <TableDetail location={tail(path, "/tables/")} />;
  if (name === "query") return <QueryScreen />;
  if (name === "maintenance") return <Maintenance />;
  if (name === "plans") return <Plans />;
  if (name === "plan") return <PlanDetail id={tail(path, "/plans/")} />;
  if (name === "jobs") return <Jobs />;
  if (name === "settings") return <Settings />;
  return <Browse />;
}

function routeName(path: string): string {
  const clean = path.replace(/\/$/, "") || "/";
  if (clean === "/tables") return "tables";
  if (clean.startsWith("/tables/")) return "table";
  if (clean === "/query") return "query";
  if (clean === "/maintenance") return "maintenance";
  if (clean === "/plans") return "plans";
  if (/^\/plans\/[^/]+$/.test(clean)) return "plan";
  if (clean === "/jobs") return "jobs";
  if (clean === "/settings") return "settings";
  return "browse";
}

function tail(path: string, prefix: string): string {
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}