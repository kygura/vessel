/** The single place for percentage / currency / duration / token / truncation formatting (CLI and TUI). */
export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const usd = (x?: number): string =>
  x === undefined ? "-" : x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`;
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
export const tokens = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
export const trunc = (s: string, max: number): string =>
  max <= 0 ? "" : s.length <= max ? s : max === 1 ? "…" : `${s.slice(0, max - 1)}…`;
