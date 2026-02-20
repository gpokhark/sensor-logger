# Mobile Sensor Logger (Web-Based)

Static GitHub Pages app. No backend. Fully client-side logging.

## What it does
- Samples a `latestState` updated by sensor events:
  - DeviceMotion + DeviceOrientation (best effort, user-permissioned on iOS)
  - Geolocation watch (best effort; GPS updates are usually <= 1 Hz)
- Scheduler samples at 5 / 50 / 100 Hz (100 Hz is best effort).
- Buffers in memory and flushes to IndexedDB:
  - every 500 samples OR every 3 seconds (whichever first)
- Automatically rolls over into a new chunk every 30 minutes.

## Storage (IndexedDB)
DB name: `sensor_logger_db`

Stores:
- `sessions` (key: `session_id`)
- `chunks` (key: `[session_id, chunk_index]`)
- `batches` (auto key, indexed by session + chunk)

## Export format
Exports NDJSON:
- One JSON object per line.
- Flat, strict schema (all keys always present).
- Missing/unavailable values are `null`.
- File naming:
  `session_<sessionId>_chunk<NN>_<YYYYMMDD_HHMMSSZ>.ndjson`
- Optional gzip: `.ndjson.gz` using `CompressionStream` if supported.

## Logging schema (columns + units)
Column order in NDJSON and CSV:

| Column | Meaning | Unit / Type |
|---|---|---|
| `utc` | Sample timestamp in UTC ISO-8601 | datetime string (`YYYY-MM-DDTHH:mm:ss.sssZ`) |
| `epoch_ms` | Sample timestamp (Unix epoch) | milliseconds |
| `dt_ms` | Time since previous sample | milliseconds |
| `session_id` | Session identifier | string |
| `chunk` | 30-minute chunk index (1-based) | integer |
| `sample_index` | Sample index within current chunk (1-based) | integer |
| `target_hz` | Requested logging rate | hertz (Hz) |
| `ax` | Linear acceleration X (no gravity) | m/s^2 |
| `ay` | Linear acceleration Y (no gravity) | m/s^2 |
| `az` | Linear acceleration Z (no gravity) | m/s^2 |
| `ax_g` | Acceleration X including gravity | m/s^2 |
| `ay_g` | Acceleration Y including gravity | m/s^2 |
| `az_g` | Acceleration Z including gravity | m/s^2 |
| `gx` | Rotation rate around X axis | deg/s |
| `gy` | Rotation rate around Y axis | deg/s |
| `gz` | Rotation rate around Z axis | deg/s |
| `alpha` | Device orientation alpha | degrees |
| `beta` | Device orientation beta | degrees |
| `gamma` | Device orientation gamma | degrees |
| `lat` | Latitude | decimal degrees |
| `lon` | Longitude | decimal degrees |
| `gps_acc_m` | GPS horizontal accuracy | meters |
| `speed_mps` | Ground speed | m/s |
| `heading_deg` | Heading/course | degrees |
| `alt_m` | Altitude | meters |
| `device` | Device marker (currently `"web"`) | string |
| `platform` | Browser platform string | string |
| `screen_w` | Screen width | pixels |
| `screen_h` | Screen height | pixels |
| `motion_ok` | Motion sensor available/receiving | 0 or 1 |
| `gps_ok` | Geolocation available/receiving | 0 or 1 |
| `wake_lock` | Screen wake lock active flag | 0 or 1 |

Notes:
- Sensor and GPS update rates are browser/OS dependent; not every field changes every sample.
- A blank cell in CSV means the original NDJSON value was `null`.

## NDJSON to CSV conversion
Use `convert.html` (fully client-side):

1. Open `convert.html` (or click **Open CSV Converter Page** in the app).
2. Drop/select `.ndjson`, `.gz`, or `.ndjson.gz`.
3. Click **Convert**.
4. Click **Download CSV** (or **Share / Save** on supported devices).

Converter behavior:
- Preserves the recommended schema order above.
- If extra keys exist, they are appended as additional CSV columns.
- Parses line-by-line (streaming) to handle large files better.
- Optional preview shows the first 50 rows.
- `.ndjson.gz` input requires browser `DecompressionStream` support.

## Deploy
- Push this folder to GitHub.
- Enable GitHub Pages from repository settings (deploy from main branch).

## Known limitations (browser reality)
- True 100 Hz precision is not guaranteed.
- Background logging stability is not guaranteed.
- GPS frequency is typically around 1 Hz (or lower).
- Thermal throttling can reduce sampling rate.
