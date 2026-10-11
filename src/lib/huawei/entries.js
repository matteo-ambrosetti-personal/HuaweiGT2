// Classify files inside a Huawei Health export by folder and file name.
//
// Layouts seen in the wild:
//   2025+   HUAWEI_HEALTH_<ts>/Motion path detail data & description/motion path detail data<13 digits>.json
//   ≤2024   Motion path detail data & description/motion path detail data.json
//   older   data/Motion path detail data & description/motion path detail data.json

const KINDS = [
  { kind: 'motion', re: /motion path detail data/ },
  { kind: 'health', re: /health detail data/ },
  { kind: 'minute', re: /sport per minute merged data/ },
  { kind: 'sequence', re: /sample sequence data/ },
];

/** Returns 'motion' | 'health' | 'minute' | 'sequence' | 'zip' | null. */
export function classifyEntry(name) {
  const lower = String(name).toLowerCase().replace(/\\/g, '/');
  const base = lower.split('/').pop();
  if (lower.endsWith('.zip')) return 'zip';
  if (!base.endsWith('.json')) return null;
  for (const { kind, re } of KINDS) if (re.test(base)) return kind;
  // Fall back to the folder name for oddly named chunks.
  for (const { kind, re } of KINDS) if (re.test(lower)) return kind;
  return null;
}

/** Order files so workouts and daily data parse before sample sequences. */
export function entryOrder(kind) {
  return { motion: 0, minute: 1, health: 2, sequence: 3 }[kind] ?? 9;
}
