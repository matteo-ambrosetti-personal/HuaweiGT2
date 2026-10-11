// Minimal RFC 4180 CSV parsing and writing.

/** Parse CSV text into an array of rows (arrays of strings). Detects ; and tab delimiters. */
export function parseCsv(text) {
  const nl = text.indexOf('\n');
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const c of firstLine) if (c in counts) counts[c]++;
  let delim = ',', best = 0;
  for (const [d, n] of Object.entries(counts)) if (n > best) { best = n; delim = d; }
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length && rows[0].length && rows[0][0].charCodeAt(0) === 0xfeff) rows[0][0] = rows[0][0].slice(1);
  return rows;
}

/** Rows → array of objects keyed by the header row. */
export function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { header, records };
}

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
