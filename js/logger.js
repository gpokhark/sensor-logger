import {
  NDJSON_KEYS_ORDER,
  FLUSH_EVERY_MS,
  FLUSH_EVERY_SAMPLES,
  CHUNK_MS,
  isoUtc,
  makeSessionId
} from "./constants.js";

import { putSession, putChunk, addBatch, getMostRecentUnfinishedSession, getChunk } from "./idb.js";
import { makeLatestState } from "./sensors.js";

export class SensorLogger {
  constructor({ onState }) {
    this.onState = onState || (() => {});
    this.latestState = makeLatestState();

    this.running = false;
    this.session = null;

    this._samplerTimer = null;
    this._flushTimer = null;

    this._batchBuffer = [];
    this._batchStartSampleIndex = 1;

    this._lastSampleMs = null;
    this._chunkStartMs = null;

    // achieved Hz estimate (rolling)
    this._achievedSamples = 0;
    this._achievedWindowStartMs = null;

    this.wakeLockSentinel = null;
    this.wake_lock_flag = 0;
  }

  async restoreIfNeeded() {
    const s = await getMostRecentUnfinishedSession();
    if (!s) return null;

    const chunk = await getChunk(s.session_id, s.current_chunk_index);
    // If chunk missing, treat as not restorable
    if (!chunk || chunk.finalized_flag === 1) return null;

    this.session = s;
    this._chunkStartMs = Date.parse(chunk.start_time_utc);
    this._lastSampleMs = s.last_sample_ms ?? null;
    this._batchStartSampleIndex = (s.current_sample_index ?? 0) + 1;

    this._emitState("Restored unfinished session");
    return {
      session_id: s.session_id,
      target_hz: s.target_hz,
      chunk_index: s.current_chunk_index,
      row_count: chunk.row_count || 0
    };
  }

  async start({ targetHz, deviceInfo }) {
    if (this.running) return;

    const now = Date.now();
    if (!this.session) {
      const sessionId = makeSessionId();
      this.session = {
        session_id: sessionId,
        start_time_utc: isoUtc(now),
        target_hz: targetHz,
        device: deviceInfo.device,
        platform: deviceInfo.platform,
        screen_w: deviceInfo.screen_w,
        screen_h: deviceInfo.screen_h,
        active: 1,
        current_chunk_index: 1,
        current_sample_index: 0,
        last_sample_ms: null
      };

      await putSession(this.session);

      await putChunk({
        session_id: sessionId,
        chunk_index: 1,
        start_time_utc: isoUtc(now),
        end_time_utc: null,
        row_count: 0,
        finalized_flag: 0
      });

      this._chunkStartMs = now;
      this._lastSampleMs = null;
      this._batchStartSampleIndex = 1;
      this._emitState("New session started");
    } else {
      // resumed session: ensure targetHz updated if different
      this.session.target_hz = targetHz;
      await putSession(this.session);
      this._emitState("Resumed session started");
    }

    this.running = true;

    await this._tryAcquireWakeLock();

    this._achievedSamples = 0;
    this._achievedWindowStartMs = now;

    this._startSampler(targetHz);
    this._startFlushTimer();

    this._emitState("Logging");
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    this._stopSampler();
    this._stopFlushTimer();

    await this.flushNow();

    await this._releaseWakeLock();

    if (this.session) {
      this.session.active = 0;
      await putSession(this.session);
    }

    this._emitState("Stopped");
  }

  async flushNow() {
    if (!this.session) return;
    if (this._batchBuffer.length === 0) return;

    const batch = {
      session_id: this.session.session_id,
      chunk_index: this.session.current_chunk_index,
      start_sample_index: this._batchStartSampleIndex,
      records: this._batchBuffer
    };
    await addBatch(batch);

    // Update chunk meta + session meta
    const added = this._batchBuffer.length;
    this.session.current_sample_index += added;
    this.session.last_sample_ms = this._lastSampleMs;

    await putSession(this.session);

    // Update chunk row_count
    await putChunk({
      session_id: this.session.session_id,
      chunk_index: this.session.current_chunk_index,
      start_time_utc: isoUtc(this._chunkStartMs),
      end_time_utc: null,
      row_count: (this.session.current_sample_index || 0),
      finalized_flag: 0
    });

    this._batchBuffer = [];
    this._batchStartSampleIndex = this.session.current_sample_index + 1;

    this._emitState(`Flushed ${added} records`);
  }

  getLatestStateRef() {
    return this.latestState;
  }

  getPublicState() {
    if (!this.session) {
      return { running: this.running };
    }
    const now = Date.now();
    const achievedHz = this._computeAchievedHz(now);
    return {
      running: this.running,
      session_id: this.session.session_id,
      target_hz: this.session.target_hz,
      chunk_index: this.session.current_chunk_index,
      rows_in_chunk: this.session.current_sample_index,
      achieved_hz: achievedHz,
      wake_lock: this.wake_lock_flag
    };
  }

  async finalizeAndRolloverChunkIfNeeded() {
    if (!this.session) return;
    const now = Date.now();
    if (this._chunkStartMs == null) return;

    if (now - this._chunkStartMs < CHUNK_MS) return;

    // finalize current chunk
    await this.flushNow();

    const oldChunkIndex = this.session.current_chunk_index;
    await putChunk({
      session_id: this.session.session_id,
      chunk_index: oldChunkIndex,
      start_time_utc: isoUtc(this._chunkStartMs),
      end_time_utc: isoUtc(now),
      row_count: this.session.current_sample_index,
      finalized_flag: 1
    });

    // start new chunk
    const newChunkIndex = oldChunkIndex + 1;
    this.session.current_chunk_index = newChunkIndex;
    this.session.current_sample_index = 0;
    this.session.last_sample_ms = null;
    await putSession(this.session);

    await putChunk({
      session_id: this.session.session_id,
      chunk_index: newChunkIndex,
      start_time_utc: isoUtc(now),
      end_time_utc: null,
      row_count: 0,
      finalized_flag: 0
    });

    this._chunkStartMs = now;
    this._lastSampleMs = null;
    this._batchStartSampleIndex = 1;

    this._emitState(`Chunk rollover -> ${newChunkIndex}`);
  }

  _startSampler(targetHz) {
    const intervalMs = Math.max(1, Math.round(1000 / targetHz));

    // Best effort scheduling: use setInterval; at 100Hz it will drift/skip on mobile (expected).
    this._samplerTimer = setInterval(async () => {
      if (!this.running) return;
      const now = Date.now();

      // rollover check (cheap)
      try { await this.finalizeAndRolloverChunkIfNeeded(); } catch {}

      const dt = this._lastSampleMs == null ? 0 : (now - this._lastSampleMs);
      this._lastSampleMs = now;

      // rolling achieved Hz window
      if (this._achievedWindowStartMs == null) this._achievedWindowStartMs = now;
      this._achievedSamples += 1;
      if (now - this._achievedWindowStartMs > 2000) {
        // reset every ~2s to keep it responsive
        this._achievedWindowStartMs = now;
        this._achievedSamples = 1;
      }

      const rec = this._makeRecord(now, dt);
      this._batchBuffer.push(rec);

      // flush conditions
      if (this._batchBuffer.length >= FLUSH_EVERY_SAMPLES) {
        try { await this.flushNow(); } catch {}
      }

      this.onState(this.getPublicState());
    }, intervalMs);
  }

  _stopSampler() {
    if (this._samplerTimer) clearInterval(this._samplerTimer);
    this._samplerTimer = null;
  }

  _startFlushTimer() {
    this._flushTimer = setInterval(async () => {
      if (!this.running) return;
      try { await this.flushNow(); } catch {}
    }, FLUSH_EVERY_MS);
  }

  _stopFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = null;
  }

  _makeRecord(nowMs, dtMs) {
    const s = this.latestState;
    const session = this.session;

    // Strict flat schema. All keys always present.
    const out = {};
    for (const k of NDJSON_KEYS_ORDER) out[k] = null;

    out.utc = isoUtc(nowMs);
    out.epoch_ms = nowMs;
    out.session_id = session.session_id;
    out.chunk = session.current_chunk_index;
    out.sample_index = (session.current_sample_index || 0) + this._batchBuffer.length + 1;
    out.target_hz = session.target_hz;
    out.dt_ms = dtMs;

    // motion/orientation
    out.ax = s.ax; out.ay = s.ay; out.az = s.az;
    out.ax_g = s.ax_g; out.ay_g = s.ay_g; out.az_g = s.az_g;
    out.gx = s.gx; out.gy = s.gy; out.gz = s.gz;
    out.alpha = s.alpha; out.beta = s.beta; out.gamma = s.gamma;

    // gps
    out.lat = s.lat; out.lon = s.lon;
    out.gps_acc_m = s.gps_acc_m;
    out.speed_mps = s.speed_mps;
    out.heading_deg = s.heading_deg;
    out.alt_m = s.alt_m;

    // device info per record (robustness)
    out.device = session.device;
    out.platform = session.platform;
    out.screen_w = session.screen_w;
    out.screen_h = session.screen_h;

    // flags
    out.motion_ok = s.motion_ok ? 1 : 0;
    out.gps_ok = s.gps_ok ? 1 : 0;
    out.wake_lock = this.wake_lock_flag ? 1 : 0;

    return out;
  }

  _computeAchievedHz(nowMs) {
    if (!this._achievedWindowStartMs) return null;
    const dt = nowMs - this._achievedWindowStartMs;
    if (dt <= 0) return null;
    return Math.round((this._achievedSamples / (dt / 1000)) * 10) / 10;
  }

  async _tryAcquireWakeLock() {
    this.wake_lock_flag = 0;
    this.wakeLockSentinel = null;

    if (!("wakeLock" in navigator)) {
      this._emitState("Wake Lock API not available");
      return;
    }
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request("screen");
      this.wake_lock_flag = 1;
      this.wakeLockSentinel.addEventListener("release", () => {
        this.wake_lock_flag = 0;
        this.onState(this.getPublicState());
      });
      this._emitState("Wake lock acquired");
    } catch (e) {
      this._emitState("Wake lock denied/unavailable");
    }
  }

  async _releaseWakeLock() {
    try {
      if (this.wakeLockSentinel) await this.wakeLockSentinel.release();
    } catch {}
    this.wakeLockSentinel = null;
    this.wake_lock_flag = 0;
  }

  _emitState(msg) {
    this.onState({ ...this.getPublicState(), message: msg });
  }
}
