export type Row = Record<string, unknown>;

export function text(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value);
}

export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

export function formatBytes(value: unknown): string {
  const amount = num(value);
  if (!Number.isFinite(amount)) return "—";
  if (Math.abs(amount) < 1024) return `${amount} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = amount / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

export function formatCount(value: unknown): string {
  const amount = num(value);
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString("en-US");
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${formatCount(count)} ${count === 1 ? word : many}`;
}

function toDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatWhen(value: unknown): string {
  const date = toDate(value);
  if (!date) return value == null || value === "" ? "—" : String(value);
  return date.toLocaleString();
}

function clock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today, 05:48", "Yesterday", "3 days ago", "14 months ago". */
export function relativeDate(value: unknown, now = new Date()): string {
  const date = toDate(value);
  if (!date) return "—";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return `Today, ${clock(date)}`;
  if (days === 1) return "Yesterday";
  if (days < 31) return `${days} days ago`;
  const months = Math.max(1, Math.round(days / 30.4));
  if (months < 24) return months === 1 ? "1 month ago" : `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** Elapsed time as words without "ago": "3 days", "14 months", "5 hours". */
export function elapsed(value: unknown, now = new Date()): string {
  const date = toDate(value);
  if (!date) return "";
  return durationWords(Math.max(0, (now.getTime() - date.getTime()) / 1000));
}

export function durationWords(seconds: number): string {
  if (seconds < 90) return "a minute";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.round(seconds / 86400);
  if (days < 31) return days === 1 ? "1 day" : `${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 24) return months === 1 ? "1 month" : `${months} months`;
  return `${Math.round(days / 365)} years`;
}

export function daysSince(value: unknown, now = new Date()): number | null {
  const date = toDate(value);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / 86_400_000;
}

export function indexLabel(ageSeconds: unknown, indexedAt: unknown): string {
  if (indexedAt == null || indexedAt === "") return "Not indexed yet";
  const seconds = num(ageSeconds);
  if (seconds < 90) return "Indexed just now";
  return `Indexed ${durationWords(seconds)} ago`;
}

export function asRecord(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Row;
    } catch {
      return {};
    }
  }
  return {};
}

export function asArray(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed as Row[];
    } catch {
      return [];
    }
  }
  return [];
}

export function isPreviewable(key: string): boolean {
  return /\.(parquet|csv|tsv|json|jsonl|ndjson)(\.gz)?$/i.test(key);
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
