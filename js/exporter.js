import {
  EXPORT_SEGMENT_TARGET_BYTES,
  chunkFileName
} from "./constants.js";

import { iterBatchesByChunk, listChunks } from "./idb.js";

// Export API:
// - exportChunk(sessionId, chunkIndex, { gzip, onProgress })
// - exportSession(sessionId, { gzip, onProgress })
// Uses blob parts to avoid a giant single string in memory.
// Optional gzip uses CompressionStream if supported.

export async function exportChunk(sessionId, chunkIndex, opts) {
  const { gzip = false, onProgress = () => {} } = opts || {};
  const createdMs = Date.now();
  const name = chunkFileName({ sessionId, chunkIndex, createdMs, gzip });

  const { blob, bytes } = await buildNdjsonBlobForChunk(sessionId, chunkIndex, { gzip, onProgress });
  await shareOrDownload(blob, name);
  return { name, bytes };
}

export async function exportSession(sessionId, opts) {
  const { gzip = false, onProgress = () => {} } = opts || {};
  const chunks = await listChunks(sessionId);
  if (!chunks.length) throw new Error("No chunks found for session");

  // Export each chunk as separate file (as PRD specifies per 30-min chunk).
  // If you want a single giant file, change this, but that conflicts with your file naming spec.
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    onProgress({ phase: "session", current: i + 1, total: chunks.length, text: `Exporting chunk ${c.chunk_index} (${i+1}/${chunks.length})` });
    await exportChunk(sessionId, c.chunk_index, { gzip, onProgress });
  }
}

async function buildNdjsonBlobForChunk(sessionId, chunkIndex, { gzip, onProgress }) {
  // Build NDJSON in segments to keep memory sane.
  const parts = [];
  let currentText = "";
  let totalLines = 0;
  let totalBytes = 0;

  await iterBatchesByChunk(sessionId, chunkIndex, async (batch) => {
    const recs = batch.records || [];
    for (let i = 0; i < recs.length; i++) {
      const line = JSON.stringify(recs[i]) + "\n";
      currentText += line;
      totalLines += 1;

      if (currentText.length >= EXPORT_SEGMENT_TARGET_BYTES) {
        const chunkBlob = new Blob([currentText], { type: "application/x-ndjson;charset=utf-8" });
        parts.push(chunkBlob);
        totalBytes += chunkBlob.size;
        currentText = "";

        onProgress({ phase: "chunk", lines: totalLines, bytes: totalBytes, text: `Building NDJSON… ${formatBytes(totalBytes)}` });
        await yieldToUi();
      }
    }
  });

  if (currentText.length) {
    const chunkBlob = new Blob([currentText], { type: "application/x-ndjson;charset=utf-8" });
    parts.push(chunkBlob);
    totalBytes += chunkBlob.size;
    currentText = "";
  }

  let blob = new Blob(parts, { type: "application/x-ndjson;charset=utf-8" });

  if (gzip) {
    const gz = await gzipBlob(blob, (p) => {
      onProgress({ phase: "gzip", ...p, text: `Compressing… ${p.percent}%` });
    });
    blob = gz;
  }

  onProgress({ phase: "done", lines: totalLines, bytes: blob.size, text: `Ready (${formatBytes(blob.size)})` });
  return { blob, bytes: blob.size };
}

async function shareOrDownload(blob, fileName) {
  // Web Share API if available (best on mobile), else download.
  const canShare = !!(navigator.canShare && navigator.share);
  if (canShare) {
    try {
      const f = new File([blob], fileName, { type: blob.type });
      if (navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: fileName });
        return;
      }
    } catch {}
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function gzipBlob(blob, onProgress) {
  if (!("CompressionStream" in window)) {
    throw new Error("CompressionStream not supported in this browser; uncheck gzip.");
  }

  const total = blob.size;
  let processed = 0;

  // Split a single source stream: one branch for compression, one for progress updates.
  const [s1, s2] = blob.stream().tee();
  const reader = s2.getReader();
  const progressTask = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        processed += value.byteLength;
        const percent = Math.min(100, Math.round((processed / total) * 100));
        onProgress({ percent });
        await yieldToUi();
      }
    } catch {}
  })();

  const gzBlob = await new Response(s1.pipeThrough(new CompressionStream("gzip"))).blob();
  await progressTask;
  onProgress({ percent: 100 });
  return gzBlob;
}

function formatBytes(n) {
  const u = ["B","KB","MB","GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}
