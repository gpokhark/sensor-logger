const RECOMMENDED_ORDER = [
  "utc","epoch_ms","dt_ms",
  "session_id","chunk","sample_index","target_hz",
  "ax","ay","az","ax_g","ay_g","az_g",
  "gx","gy","gz","alpha","beta","gamma",
  "lat","lon","gps_acc_m","speed_mps","heading_deg","alt_m",
  "device","platform","screen_w","screen_h",
  "motion_ok","gps_ok","wake_lock"
];

export async function convertObjectsToCsv({
  objectsAsyncIterable,
  detectLines = 100,
  previewRows = 50,
  enablePreview = true,
  onProgress = () => {},
  signal
}) {
  const keysSet = new Set();
  const buffered = [];
  let rows = 0;

  // buffer first N for schema
  for await (const obj of objectsAsyncIterable) {
    if (signal?.aborted) throw new Error("Cancelled");
    buffered.push(obj);
    Object.keys(obj).forEach(k => keysSet.add(k));
    if (buffered.length >= detectLines) break;
  }
  if (!buffered.length) throw new Error("No records found");

  const extras = [...keysSet].filter(k => !RECOMMENDED_ORDER.includes(k)).sort();
  const columns = [...RECOMMENDED_ORDER.filter(k => keysSet.has(k)), ...extras];

  const parts = [];
  let csvChunk = "";
  const preview = [];

  const pushChunkIfBig = () => {
    if (csvChunk.length >= 2_000_000) {
      parts.push(new Blob([csvChunk], { type: "text/csv;charset=utf-8" }));
      csvChunk = "";
    }
  };

  csvChunk += columns.map(csvEscape).join(",") + "\n";

  const handle = (obj) => {
    const row = columns.map(k => valueToCell(obj?.[k]));
    csvChunk += row.map(csvEscape).join(",") + "\n";
    rows++;

    if (enablePreview && preview.length < previewRows) {
      preview.push(Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    }
    pushChunkIfBig();
  };

  buffered.forEach(handle);

  for await (const obj of objectsAsyncIterable) {
    if (signal?.aborted) throw new Error("Cancelled");
    handle(obj);

    if (rows % 5000 === 0) {
      onProgress({ rows });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (csvChunk.length) parts.push(new Blob([csvChunk], { type: "text/csv;charset=utf-8" }));
  const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });

  onProgress({ rows, done: true });
  return { blob, columns, rows, preview };
}

function valueToCell(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function csvEscape(s) {
  const needs = /[,"\n\r]/.test(s);
  if (!needs) return s;
  return `"${s.replaceAll(`"`, `""`)}"`;
}
