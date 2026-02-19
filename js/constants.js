export const DB_NAME = "sensor_logger_db";
export const DB_VERSION = 1;

export const STORE_SESSIONS = "sessions";
export const STORE_CHUNKS = "chunks";
export const STORE_BATCHES = "batches";

export const FLUSH_EVERY_SAMPLES = 500;
export const FLUSH_EVERY_MS = 3000;

export const CHUNK_MS = 30 * 60 * 1000; // 30 minutes
export const EXPORT_SEGMENT_TARGET_BYTES = 2 * 1024 * 1024; // ~2MB segments

export const TARGET_HZ_OPTIONS = [5, 50, 100];

// Flat, strict schema: keys always present (nullable where unavailable).
export const NDJSON_KEYS_ORDER = [
  // time fields
  "utc","epoch_ms","dt_ms",
  // session fields
  "session_id","chunk","sample_index","target_hz",
  // motion fields
  "ax","ay","az","ax_g","ay_g","az_g",
  "gx","gy","gz",
  "alpha","beta","gamma",
  // gps fields
  "lat","lon","gps_acc_m","speed_mps","heading_deg","alt_m",
  // device fields
  "device","platform","screen_w","screen_h",
  // flags
  "motion_ok","gps_ok","wake_lock"
];

// Helper: ISO UTC like 2026-02-18T12:34:56.789Z
export function isoUtc(ms) {
  return new Date(ms).toISOString();
}

export function pad2(n) { return String(n).padStart(2, "0"); }
export function pad3(n) { return String(n).padStart(3, "0"); }

// YYYYMMDD_HHMMSSZ
export function utcStamp(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "_" +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z"
  );
}

export function makeSessionId() {
  // short, URL-safe
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const b64 = btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
  return "s_" + b64;
}

export function chunkFileName({ sessionId, chunkIndex, createdMs, gzip }) {
  const nn = String(chunkIndex).padStart(2, "0");
  const stamp = utcStamp(createdMs);
  const base = `session_${sessionId}_chunk${nn}_${stamp}.ndjson`;
  return gzip ? `${base}.gz` : base;
}
