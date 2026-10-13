// Minimal RFC 4180 CSV writing, for exports.

function cell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Objects → CSV text with the given columns [{key, label}]. */
export function toCsv(records, columns) {
  const lines = [columns.map((c) => cell(c.label ?? c.key)).join(',')];
  for (const r of records) lines.push(columns.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}
