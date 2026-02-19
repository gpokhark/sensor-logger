import { SensorLogger } from "./logger.js";
import { attachMotionAndOrientation, attachGeolocation, ensureMotionPermissionIfNeeded, ensureOrientationPermissionIfNeeded, ensureGeoPermissionIfNeeded } from "./sensors.js";
import { clearAll } from "./idb.js";
import { exportChunk, exportSession } from "./exporter.js";

const el = {
  targetHz: document.getElementById("targetHz"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnExportCurrent: document.getElementById("btnExportCurrent"),
  btnExportSession: document.getElementById("btnExportSession"),
  btnClear: document.getElementById("btnClear"),
  chkGzip: document.getElementById("chkGzip"),

  kpiSessionId: document.getElementById("kpiSessionId"),
  kpiChunk: document.getElementById("kpiChunk"),
  kpiRows: document.getElementById("kpiRows"),
  kpiAchieved: document.getElementById("kpiAchieved"),
  kpiWakeLock: document.getElementById("kpiWakeLock"),

  status: document.getElementById("status"),
  diag: document.getElementById("diag"),

  exportBar: document.getElementById("exportBar"),
  exportText: document.getElementById("exportText"),

  btnOpenConverter: document.getElementById("btnOpenConverter"),
  converterLink: document.getElementById("converterLink"),

};

const logger = new SensorLogger({ onState: onLoggerState });
const latestState = logger.getLatestStateRef();

let detachMotion = null;
let geo = null;
let liveDiagTimer = null;

boot().catch(showErr);

async function boot() {
  const restored = await logger.restoreIfNeeded();
  if (restored) {
    el.status.textContent = "Restored unfinished session (press Start to continue)";
    el.targetHz.value = String(restored.target_hz);
    refreshUi(logger.getPublicState());
    enableExportsIfPossible(logger.getPublicState());
  } else {
    refreshUi({ running: false });
  }

  el.btnStart.addEventListener("click", onStart);
  el.btnStop.addEventListener("click", onStop);

  el.btnExportCurrent.addEventListener("click", onExportCurrent);
  el.btnExportSession.addEventListener("click", onExportSession);

  el.btnClear.addEventListener("click", onClear);
  
  if (el.btnOpenConverter && el.converterLink) {
    const converterUrl = new URL("convert.html", location.href).toString();
    el.converterLink.href = converterUrl;
    el.converterLink.textContent = converterUrl;

    el.btnOpenConverter.addEventListener("click", () => {
      window.open(converterUrl, "_blank", "noopener,noreferrer");
    });
  }

  window.addEventListener("visibilitychange", () => {
    // If page hidden, wake lock may release. State updates handle the flag.
  });

  startPassiveSensorPreview();
  startLiveDiagTicker();
}

async function onStart() {
  try {
    const targetHz = Number(el.targetHz.value);

    // iOS permission prompts must be called from user gesture.
    await ensureMotionPermissionIfNeeded();
    await ensureOrientationPermissionIfNeeded();
    await ensureGeoPermissionIfNeeded();

    detachMotion?.();
    detachMotion = attachMotionAndOrientation(latestState);

    geo?.stop?.();
    geo = attachGeolocation(latestState);
    // Start geo watch; ignore failure (user may deny).
    geo.start().catch(() => {});

    const deviceInfo = getDeviceInfo();
    await logger.start({ targetHz, deviceInfo });

    refreshUi(logger.getPublicState());
    enableExportsIfPossible(logger.getPublicState());

    el.btnStart.disabled = true;
    el.btnStop.disabled = false;
  } catch (e) {
    showErr(e);
  }
}

async function onStop() {
  try {
    await logger.stop();
    // Keep passive preview running at idle so live values remain visible.
    startPassiveSensorPreview();

    refreshUi(logger.getPublicState());
    enableExportsIfPossible(logger.getPublicState());

    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
  } catch (e) {
    showErr(e);
  }
}

async function onExportCurrent() {
  const st = logger.getPublicState();
  if (!st.session_id) return;

  setExportUi(0, "Starting export…");
  try {
    await exportChunk(st.session_id, st.chunk_index, {
      gzip: el.chkGzip.checked,
      onProgress: (p) => renderExportProgress(p)
    });
    setExportUi(100, "Export finished");
  } catch (e) {
    setExportUi(0, "Export failed");
    showErr(e);
  }
}

async function onExportSession() {
  const st = logger.getPublicState();
  if (!st.session_id) return;

  setExportUi(0, "Starting session export…");
  try {
    await exportSession(st.session_id, {
      gzip: el.chkGzip.checked,
      onProgress: (p) => renderExportProgress(p)
    });
    setExportUi(100, "Session export finished");
  } catch (e) {
    setExportUi(0, "Export failed");
    showErr(e);
  }
}

async function onClear() {
  if (!confirm("Delete ALL local sensor logs for this app? This cannot be undone.")) return;
  try {
    await logger.stop().catch(() => {});
    detachMotion?.();
    detachMotion = null;
    geo?.stop?.();
    geo = null;
    await clearAll();
    location.reload();
  } catch (e) {
    showErr(e);
  }
}

function onLoggerState(state) {
  if (state.message) el.status.textContent = state.message;
  refreshUi(state);
  enableExportsIfPossible(state);
  renderDiag(state);
}

function startPassiveSensorPreview() {
  detachMotion?.();
  detachMotion = attachMotionAndOrientation(latestState);

  geo?.stop?.();
  geo = attachGeolocation(latestState);
  geo.start().catch(() => {});
}

function startLiveDiagTicker() {
  if (liveDiagTimer) return;
  const tick = () => renderDiag(logger.getPublicState());
  tick();
  liveDiagTimer = setInterval(tick, 1000);
}

function refreshUi(st) {
  el.kpiSessionId.textContent = st.session_id || "—";
  el.kpiChunk.textContent = st.chunk_index ? String(st.chunk_index) : "—";
  el.kpiRows.textContent = (st.rows_in_chunk != null) ? String(st.rows_in_chunk) : "—";
  el.kpiAchieved.textContent = (st.achieved_hz != null) ? String(st.achieved_hz) : "—";
  el.kpiWakeLock.textContent = (st.wake_lock != null) ? (st.wake_lock ? "1" : "0") : "—";

  if (st.running) {
    el.btnStart.disabled = true;
    el.btnStop.disabled = false;
  } else {
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
  }
}

function enableExportsIfPossible(st) {
  const ok = !!st.session_id;
  el.btnExportCurrent.disabled = !ok;
  el.btnExportSession.disabled = !ok;
}

function renderDiag(st) {
  const diag = {
    running: !!st.running,
    session_id: st.session_id || null,
    target_hz: st.target_hz || null,
    chunk_index: st.chunk_index || null,
    rows_in_chunk: st.rows_in_chunk ?? null,
    achieved_hz: st.achieved_hz ?? null,
    wake_lock: st.wake_lock ?? null,
    motion_ok: latestState.motion_ok,
    motion_src: latestState.motion_src || null,
    gps_ok: latestState.gps_ok,
    last_motion: {
      ax: latestState.ax, ay: latestState.ay, az: latestState.az,
      gx: latestState.gx, gy: latestState.gy, gz: latestState.gz,
      alpha: latestState.alpha, beta: latestState.beta, gamma: latestState.gamma
    },
    last_gps: {
      lat: latestState.lat, lon: latestState.lon, acc_m: latestState.gps_acc_m,
      speed_mps: latestState.speed_mps, heading_deg: latestState.heading_deg, alt_m: latestState.alt_m
    },
    ua: navigator.userAgent
  };
  el.diag.textContent = JSON.stringify(diag, null, 2);
}

function renderExportProgress(p) {
  if (p.phase === "gzip") {
    setExportUi(p.percent || 0, p.text || "Compressing…");
    return;
  }
  if (p.phase === "chunk") {
    // Can't know total bytes ahead of time; show a pulsing-ish increment capped at 90
    const approx = Math.min(90, Math.max(5, Math.round((p.bytes / (50 * 1024 * 1024)) * 90)));
    setExportUi(approx, p.text || "Building NDJSON…");
    return;
  }
  if (p.phase === "session") {
    // session: show chunk count progress 0..20
    const pct = Math.min(20, Math.round((p.current / p.total) * 20));
    setExportUi(pct, p.text || "Exporting session…");
    return;
  }
  if (p.phase === "done") {
    setExportUi(100, p.text || "Ready");
  }
}

function setExportUi(percent, text) {
  el.exportBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  el.exportText.textContent = text;
}

function getDeviceInfo() {
  const device = "web";
  const platform = navigator.platform || "unknown";
  const screen_w = Number(screen.width) || 0;
  const screen_h = Number(screen.height) || 0;
  return { device, platform, screen_w, screen_h };
}

function showErr(e) {
  const msg = (e && e.message) ? e.message : String(e);
  el.status.textContent = `Error: ${msg}`;
  console.error(e);
}
