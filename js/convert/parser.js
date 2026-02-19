export async function* parseNdjsonStream(byteStream, { signal, onProgress, totalBytes }) {
  const reader = byteStream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let readBytes = 0;
  let lineNo = 0;

  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    const { value, done } = await reader.read();
    if (done) break;

    readBytes += value.byteLength;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      lineNo++;

      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try { obj = JSON.parse(trimmed); }
      catch { throw new Error(`Invalid JSON at line ${lineNo}`); }

      yield obj;
    }

    if (onProgress && totalBytes) {
      const pct = Math.min(99, Math.round((readBytes / totalBytes) * 100));
      onProgress({ pct, readBytes, lineNo });
    }
    await new Promise(r => setTimeout(r, 0));
  }

  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) {
    lineNo++;
    let obj;
    try { obj = JSON.parse(tail); }
    catch { throw new Error(`Invalid JSON at line ${lineNo}`); }
    yield obj;
  }

  onProgress?.({ pct: 100, readBytes, lineNo });
}
