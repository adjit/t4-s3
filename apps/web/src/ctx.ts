import { createContext, useContext } from "react";

export interface BucketState {
  /** Active connection. Every screen works on one bucket inside it. */
  connectionId: string;
  bucket: string;
  setBucket: (bucket: string) => void;
  select: (connectionId: string, bucket: string) => void;
}

export const BucketContext = createContext<BucketState>({
  connectionId: "",
  bucket: "",
  setBucket: () => undefined,
  select: () => undefined,
});

export function useBucket(): BucketState {
  return useContext(BucketContext);
}

export function go(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const QUERY_DRAFT = "t4-query-draft";

/** Hand a SQL statement to the Query screen and open it. */
export function openInQuery(sql: string): void {
  sessionStorage.setItem(QUERY_DRAFT, sql);
  go("/query");
}

export function takeQueryDraft(): string {
  const sql = sessionStorage.getItem(QUERY_DRAFT) ?? "";
  sessionStorage.removeItem(QUERY_DRAFT);
  return sql;
}

export function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("t4-theme", theme);
}
