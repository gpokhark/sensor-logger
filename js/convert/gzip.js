export async function maybeDecompressToByteStream(fileOrBlob, nameHint = "") {
  const name = (nameHint || fileOrBlob.name || "").toLowerCase();
  const isGz = name.endsWith(".gz");
  let stream = fileOrBlob.stream();

  if (isGz) {
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser cannot decompress .gz. Use plain .ndjson.");
    }
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  return stream;
}
