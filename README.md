# Mobile Sensor Logger (Web-Based)

Static GitHub Pages app. No backend. Fully client-side logging.

## What it does
- Samples a `latestState` updated by sensor events:
  - DeviceMotion + DeviceOrientation (best effort, user-permissioned on iOS)
  - Geolocation watch (best effort; GPS updates are usually ≤ 1 Hz)
- Scheduler samples at 5 / 50 / 100 Hz (100 Hz is best effort).
- Buffers in memory and flushes to IndexedDB:
  - every 500 samples OR every 3 seconds (whichever first)
- Automatically rolls over into a new chunk every 30 minutes.

## Storage (IndexedDB)
DB name: `sensor_logger_db`
Stores:
- `sessions` (key: session_id)
- `chunks` (key: [session_id, chunk_index])
- `batches` (auto key, indexed by session + chunk)

## Export
Exports NDJSON:
- One JSON object per line
- Flat schema; all keys always present; missing values are `null`
- File naming:
  `session_<sessionId>_chunk<NN>_<YYYYMMDD_HHMMSSZ>.ndjson`
- Optional gzip: `.ndjson.gz` using `CompressionStream` if supported.

## NDJSON to CSV converter
- Open `convert.html` to convert `.ndjson` / `.ndjson.gz` to `.csv` fully client-side.
- You can access it from the main page via **Open CSV Converter Page**.
- Supports drag/drop or file picker input.
- Optional file share path uses the browser Web Share API when available.
- `.ndjson.gz` input requires `DecompressionStream` support in the browser. If unsupported, use plain `.ndjson`.

## Deploy
- Push this folder to GitHub
- Enable GitHub Pages from the repository settings (deploy from main branch)

## Known limitations (browser reality)
- True 100 Hz precision is not guaranteed.
- Background logging stability is not guaranteed.
- GPS frequency typically ~1 Hz or worse.
- Thermal throttling can reduce sampling rate.
