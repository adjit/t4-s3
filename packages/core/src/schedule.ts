export interface CronParts {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export function parseCron(expression: string): CronParts {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expressions need five fields: minute hour day month weekday");
  return {
    minute: parts[0]!,
    hour: parts[1]!,
    dayOfMonth: parts[2]!,
    month: parts[3]!,
    dayOfWeek: parts[4]!,
  };
}

export function cronMatches(expression: string, date: Date): boolean {
  const parts = parseCron(expression);
  return (
    fieldMatches(parts.minute, date.getUTCMinutes(), 0, 59) &&
    fieldMatches(parts.hour, date.getUTCHours(), 0, 23) &&
    fieldMatches(parts.dayOfMonth, date.getUTCDate(), 1, 31) &&
    fieldMatches(parts.month, date.getUTCMonth() + 1, 1, 12) &&
    fieldMatches(parts.dayOfWeek, date.getUTCDay(), 0, 6)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  return field.split(",").some((piece) => {
    if (piece.startsWith("*/")) {
      const step = Number(piece.slice(2));
      return step > 0 && value % step === 0;
    }
    if (piece.includes("-")) {
      const [start, end] = piece.split("-").map(Number);
      return value >= (start ?? min) && value <= (end ?? max);
    }
    return Number(piece) === value;
  });
}
