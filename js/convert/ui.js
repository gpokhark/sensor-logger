import { maybeDecompressToByteStream } from "./gzip.js";
import { parseNdjsonStream } from "./parser.js";
import { convertObjectsToCsv } from "./converter.js";

const el = {
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  btnConvert: document.getElementById("btnConvert"),
  btnCancel: document.getElementById("btnCancel"),
  btnDownload: document.getElementById("btnDownload"),
  btnShare: document.getElementById("btnShare"),
  chkPreview: document.getElementById("chkPreview"),
  bar: document.getElementById("bar"),
  progressText: document.getElementById("progressText"),
  meta: document.getElementById("meta"),
  previewTable: document.getElementById("previewTable")
};

let abort = null;
let input = null;     // { blobOrFile, name }
let csvOut = null;    // { blob, name }

wireDropzone();
wireInputs();

function wireInputs() {
  el.file.addEventListener("change", () => {
    const f = el.file.files?.[0];
    if (f) setInput(f, f.name);
  });

  el.btnConvert.addEventListener("click", () => runConvert().catch(showErr));
  el.btnCancel.addEventListener("click", () => abort?.abort());

  el.btnDownload.addEventListener("click", () => {
    if (!csvOut) return;
    downloadBlob(csvOut.blob, csvOut.name);
  });

  el.btnShare.addEventListener("click", async () => {
    if (!csvOut) return;
    await shareFile(csvOut.blob, csvOut.name);
  });

  // Share button only if supported
  if (!navigator.share) {
    el.btnShare.disabled = true;
    el.btnShare.title = "Web Share not supported on this browser";
  }
}

function wireDropzone() {
  const d = el.drop;

  d.addEventListener("dragover", (e) => {
    e.preventDefault();
    d.classList.add("dragover");
  });
  d.addEventListener("dragleave", () => d.classList.remove("dragover"));
  d.addEventListener("drop", (e) => {
    e.preventDefault();
    d.classList.remove("dragover");
    const f = e.dataTransfer.files?.[0];
    if (f) setInput(f, f.name);
  });
}

function setInput(blobOrFile, name) {
  input = { blobOrFile, name };
  el.meta.textContent = `${name} (${formatBytes(blobOrFile.size || 0)})`;
  el.btnConvert.disabled = false;
  el.btnDownload.disabled = true;
  // enable share only if supported and we have output later
  el.btnShare.disabled = !navigator.share;
  csvOut = null;
  renderPreview([], []);
  setProgress(0, "Ready");
}

async function runConvert() {
  if (!input) return;

  abort?.abort();
  abort = new AbortController();

  setUiRunning(true);
  setProgress(0, "Preparing…");

  try {
    const { blobOrFile, name } = input;

    const byteStream = await maybeDecompressToByteStream(blobOrFile, name);

    const totalBytes = blobOrFile.size || 0;
    const baseIter = parseNdjsonStream(byteStream, {
      signal: abort.signal,
      totalBytes: totalBytes || undefined,
      onProgress: (p) => setProgress(p.pct || 0, `Parsing… ${p.lineNo || 0} lines`)
    });

    // One-pass iterator with first 100 buffered
    const detectLines = 100;
    const buffered = [];
    const it = baseIter[Symbol.asyncIterator]();

    for (let i = 0; i < detectLines; i++) {
      const n = await it.next();
      if (n.done) break;
      buffered.push(n.value);
    }

    async function* wrapped() {
      for (const x of buffered) yield x;
      while (true) {
        const n = await it.next();
        if (n.done) break;
        yield n.value;
      }
    }

    setProgress(5, `Converting… schema from ${buffered.length} lines`);

    const enablePreview = !!el.chkPreview.checked;
    let convertedRows = 0;

    const { blob: csvBlob, columns, rows, preview } = await convertObjectsToCsv({
      objectsAsyncIterable: wrapped(),
      detectLines: buffered.length || 1,
      enablePreview,
      onProgress: (p) => {
        if (p.rows != null) {
          convertedRows = p.rows;
          const approx = Math.min(95, 5 + Math.round(Math.log10(1 + p.rows) * 20));
          setProgress(approx, `Converting… ${p.rows} rows`);
        }
        if (p.done) setProgress(100, `Done: ${p.rows ?? convertedRows} rows`);
      },
      signal: abort.signal
    });

    renderPreview(columns, preview);

    const outName = toCsvName(name);
    csvOut = { blob: csvBlob, name: outName };

    el.btnDownload.disabled = false;
    el.btnShare.disabled = !navigator.share;

    // Auto-download on desktop is fine; on iOS it’s often better to let user press Share.
    // We'll NOT auto-download: user chooses Download or Share.
  } finally {
    setUiRunning(false);
  }
}

function setUiRunning(running) {
  el.btnConvert.disabled = running || !input;
  el.btnCancel.disabled = !running;
  el.file.disabled = running;
}

function setProgress(pct, text) {
  el.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.progressText.textContent = text;
}

function renderPreview(columns, previewRows) {
  el.previewTable.innerHTML = "";
  if (!previewRows?.length) return;

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  columns.forEach(c => {
    const th = document.createElement("th");
    th.textContent = c;
    trh.appendChild(th);
  });
  thead.appendChild(trh);

  const tbody = document.createElement("tbody");
  previewRows.forEach(row => {
    const tr = document.createElement("tr");
    columns.forEach(c => {
      const td = document.createElement("td");
      td.textContent = row[c] ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  el.previewTable.appendChild(thead);
  el.previewTable.appendChild(tbody);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function shareFile(blob, name) {
  if (!navigator.share) {
    throw new Error("Share not supported. Use Download.");
  }
  const file = new File([blob], name, { type: "text/csv" });
  // Use canShare if available
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
  } else {
    // fallback: download
    downloadBlob(blob, name);
  }
}

function toCsvName(inputName) {
  const n = (inputName || "").toLowerCase();
  if (n.endsWith(".ndjson.gz")) return inputName.slice(0, -10) + ".csv";
  if (n.endsWith(".gz")) return inputName.slice(0, -3) + ".csv";
  if (n.endsWith(".ndjson")) return inputName.slice(0, -7) + ".csv";
  return inputName + ".csv";
}

function formatBytes(n) {
  const u = ["B","KB","MB","GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function showErr(e) {
  console.error(e);
  const msg = (e && e.message) ? e.message : String(e);
  if (msg === "Cancelled") {
    setProgress(0, "Cancelled");
    setUiRunning(false);
    return;
  }
  setProgress(0, `Error: ${msg}`);
  setUiRunning(false);
}
