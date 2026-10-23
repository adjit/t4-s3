import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { go, useBucket } from "./ctx";
import { indexLabel, text, type Row } from "./format";
import { Icon } from "./icons";
import { ErrorText } from "./ui";

/**
 * The sidebar Bucket card's "Change" panel: pick the active connection, then a bucket in it.
 * Buckets come from a live listing of the store; buckets this app already indexes still show
 * (from the local index) when the store cannot be reached.
 */
export function Switcher({ connections, tracked, onClose }: { connections: Row[]; tracked: Row[]; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const { connectionId, bucket, select } = useBucket();
  const [focus, setFocus] = useState(() => connectionId || text(connections[0]?.connection_id));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const live = useQuery({
    queryKey: ["store-buckets", focus],
    queryFn: () => api<{ buckets: string[] }>(`/api/connections/${encodeURIComponent(focus)}/buckets`),
    enabled: Boolean(focus),
    staleTime: 30_000,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const focused = connections.find((row) => text(row.connection_id) === focus);
  const trackedByName = new Map(tracked.map((row) => [text(row.bucket), row]));
  const names = [...new Set([...(live.data?.buckets ?? []), ...tracked.filter((row) => text(row.connection_id) === focus).map((row) => text(row.bucket))])].sort();

  const pick = async (name: string): Promise<void> => {
    setError(null);
    const row = trackedByName.get(name);
    if (row && text(row.connection_id) === focus) {
      select(focus, name);
      onClose();
      return;
    }
    setBusy(name);
    try {
      // Start tracking the bucket. Browse then offers to index it in place.
      await api("/api/buckets", { method: "POST", body: JSON.stringify({ bucket: name, connectionId: focus, writeEnabled: false }) });
      await client.invalidateQueries({ queryKey: ["buckets"] });
      select(focus, name);
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="switcher" role="dialog" aria-label="Switch connection or bucket">
        <div className="sw-col">
          <span className="lbl">Connections</span>
          {connections.length === 0 ? <p className="small" style={{ padding: "4px 10px" }}>No connections yet.</p> : null}
          {connections.map((row) => {
            const id = text(row.connection_id);
            return (
              <button
                key={id}
                type="button"
                className={`opt conn-opt${id === focus ? " on" : ""}`}
                aria-pressed={id === focus}
                onClick={() => { setFocus(id); setError(null); }}
              >
                <span className="ti">
                  <strong>{text(row.name)}{id === connectionId ? <span className="badge b-ice" style={{ marginLeft: 6 }}>Active</span> : null}</strong>
                  <span>{text(row.endpoint)}</span>
                </span>
                <Icon name="chevron" className="ic rot" />
              </button>
            );
          })}
          <div className="sep" />
          <button className="opt" type="button" onClick={() => { onClose(); go("/settings?tab=new"); }}>Connect another store</button>
          <button className="opt" type="button" onClick={() => { onClose(); go("/settings"); }}>Manage connections</button>
        </div>
        <div className="sw-col">
          <span className="lbl">Buckets in {focused ? text(focused.name) : "this connection"}</span>
          {live.isLoading ? <p className="small" style={{ padding: "4px 10px" }}>Listing buckets…</p> : null}
          {live.error ? (
            <div className="sw-error">
              <strong>Can't reach this store</strong>
              <span>{live.error instanceof Error ? live.error.message : String(live.error)}</span>
              <button className="link" type="button" onClick={() => void live.refetch()}>Try again</button>
              {names.length ? <span>Buckets indexed earlier are still listed below and browse from the local index.</span> : null}
            </div>
          ) : null}
          {!live.isLoading && names.length === 0 && !live.error ? <p className="small" style={{ padding: "4px 10px" }}>This key cannot see any buckets.</p> : null}
          {names.map((name) => {
            const row = trackedByName.get(name);
            const elsewhere = row && text(row.connection_id) !== focus;
            const owner = elsewhere ? connections.find((item) => text(item.connection_id) === text(row?.connection_id)) : undefined;
            const active = name === bucket && focus === connectionId;
            return (
              <button
                key={name}
                type="button"
                className={`opt${active ? " on" : ""}`}
                disabled={Boolean(elsewhere) || busy !== ""}
                title={elsewhere ? `Already indexed through ${text(owner?.name) || "another connection"}. Bucket names are unique in this app.` : undefined}
                onClick={() => void pick(name)}
              >
                <span className="ti">
                  <strong>{name}</strong>
                  <span>
                    {busy === name
                      ? "Adding…"
                      : elsewhere
                        ? `Used through ${text(owner?.name) || "another connection"}`
                        : row
                          ? indexLabel(row.indexAgeSeconds, row.indexedAt)
                          : "Not indexed yet"}
                  </span>
                </span>
                {active ? <Icon name="check" /> : null}
              </button>
            );
          })}
          <ErrorText error={error} />
        </div>
      </div>
    </>
  );
}
