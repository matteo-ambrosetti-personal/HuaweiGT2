// Small numeric helpers shared by the models. Inputs may hold nulls; every
// helper ignores them.

export const finite = (v) => v != null && Number.isFinite(v);
export const clean = (xs) => xs.filter(finite);

export function mean(xs) {
  const v = clean(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Sample standard deviation (n − 1). */
export function sd(xs) {
  const v = clean(xs);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export function quantile(xs, q) {
  const v = clean(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const median = (xs) => quantile(xs, 0.5);

/** Ordinary least squares y = a + b·x over [x, y] pairs: {a, b, r2, n}. */
export function ols(points) {
  const p = points.filter(([x, y]) => finite(x) && finite(y));
  const n = p.length;
  if (n < 2) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / n;
  const my = p.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of p) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (!sxx) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, r2: syy ? (sxy * sxy) / (sxx * syy) : 1, n };
}

/** Values over a trailing window of `n` items ending at each index. */
export function trailing(values, n, fn, minCount = 1) {
  return values.map((_, i) => {
    const w = clean(values.slice(Math.max(0, i - n + 1), i + 1));
    return w.length >= minCount ? fn(w) : null;
  });
}

export const round = (v, d = 0) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
