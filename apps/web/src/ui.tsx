import { useEffect, useState, type ReactNode } from "react";
import { go } from "./ctx";
import { text } from "./format";
import { Icon } from "./icons";

export function ErrorText({ error }: { error: unknown }): ReactNode {
  if (!error) return null;
  return <p className="error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}

export interface Crumb {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function Crumbs({ items }: { items: Crumb[] }): ReactNode {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} style={{ display: "contents" }}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {last ? (
              <strong aria-current="page">{item.label}</strong>
            ) : (
              <a
                href={item.href ?? "#"}
                onClick={(event) => {
                  event.preventDefault();
                  if (item.onClick) item.onClick();
                  else if (item.href) go(item.href);
                }}
              >
                {item.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function CopyButton({ value, label = "Copy", className = "btn sm" }: { value: string; label?: string; className?: string }): ReactNode {
  const [done, setDone] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  };
  return (
    <button className={className} type="button" onClick={() => void copy()}>
      {done ? "Copied" : label}
    </button>
  );
}

export function Empty({ title, body, action, href, onClick }: { title: string; body?: string; action?: string; href?: string; onClick?: () => void }): ReactNode {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action ? (
        <button className="btn pri" type="button" onClick={() => (href ? go(href) : onClick?.())}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="modal sm" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="row-act" type="button" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="body pad">{children}</div>
        <footer>{footer}</footer>
      </div>
    </>
  );
}

/**
 * Destructive confirmation: the action button stays disabled until the exact name is typed.
 * `blocked` explains why the action cannot run at all.
 */
export function ConfirmDelete({
  title,
  name,
  what,
  children,
  actionLabel = "Delete",
  blocked,
  onConfirm,
  onClose,
}: {
  title: string;
  name: string;
  what: string;
  children?: ReactNode;
  actionLabel?: string;
  blocked?: string | null;
  onConfirm: (typed: string) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const matches = typed === name && name !== "";
  const run = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await onConfirm(typed);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn danger" type="button" disabled={!matches || busy || Boolean(blocked)} onClick={() => void run()}>
            {busy ? "Working…" : actionLabel}
          </button>
        </>
      }
    >
      {children}
      {blocked ? (
        <p className="warn" role="alert">{blocked}</p>
      ) : (
        <form className="f" onSubmit={(event) => { event.preventDefault(); if (matches) void run(); }}>
          <label htmlFor="confirm-name">Type the {what} name <code>{name}</code> to confirm</label>
          <input id="confirm-name" type="text" value={typed} autoComplete="off" autoFocus spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
          <span className="hint">{typed && !matches ? "That does not match yet." : "The button turns on when the name matches exactly."}</span>
        </form>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}

const STATUS_TONE: Record<string, string> = {
  done: "b-ok",
  ok: "b-ok",
  approved: "b-ice",
  dry_run: "b-ice",
  running: "b-ice",
  draft: "b-n",
  cancelled: "b-n",
  failed: "b-bad",
  error: "b-bad",
};

const STATUS_LABEL: Record<string, string> = {
  dry_run: "Dry run",
  draft: "Draft",
  approved: "Approved",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: unknown }): ReactNode {
  const value = text(status);
  return <span className={`badge ${STATUS_TONE[value] ?? "b-n"}`}>{STATUS_LABEL[value] ?? (value || "—")}</span>;
}

/** Simple table inside a card. Column alignment via `numeric`. */
export function DataTable({
  columns,
  numeric,
  rows,
  empty,
  widths,
}: {
  columns: string[];
  numeric?: boolean[];
  rows: ReactNode[][];
  empty?: ReactNode;
  widths?: (string | undefined)[];
}): ReactNode {
  if (rows.length === 0) return empty ? <>{empty}</> : null;
  return (
    <div className="tw">
      <table className="tbl">
        {widths ? (
          <colgroup>
            {widths.map((width, index) => <col key={index} style={width ? { width } : undefined} />)}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={`${column}-${index}`} className={numeric?.[index] ? "num" : undefined}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={numeric?.[cellIndex] ? "num" : undefined}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
