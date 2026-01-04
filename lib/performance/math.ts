export function num(v: any, fallback: number | null = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round(n: number, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

export function safeDiv(a: number, b: number, fallback = 0) {
  return b ? a / b : fallback;
}
