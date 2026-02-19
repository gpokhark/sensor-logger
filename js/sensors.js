// Updates a latestState object via sensor events (motion/orientation/gps)
// Also provides permission helpers for iOS.

export function makeLatestState() {
  return {
    // motion (m/s^2)
    ax: null, ay: null, az: null,
    // accel including gravity (m/s^2)
    ax_g: null, ay_g: null, az_g: null,
    // gyro (rad/s on some browsers; deg/s on others). We log raw.
    gx: null, gy: null, gz: null,
    // device orientation (deg)
    alpha: null, beta: null, gamma: null,

    // gps
    lat: null, lon: null, gps_acc_m: null,
    speed_mps: null, heading_deg: null, alt_m: null,

    // flags
    motion_ok: 0,
    gps_ok: 0,
    motion_src: null
  };
}

export async function ensureMotionPermissionIfNeeded() {
  // iOS requires explicit permission
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === "function") {
    const r = await DME.requestPermission();
    if (r !== "granted") throw new Error("Motion permission denied");
  }
}

export async function ensureOrientationPermissionIfNeeded() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === "function") {
    const r = await DOE.requestPermission();
    if (r !== "granted") throw new Error("Orientation permission denied");
  }
}

export async function ensureGeoPermissionIfNeeded() {
  // We'll just attempt watchPosition; browser prompts as needed.
  if (!("geolocation" in navigator)) throw new Error("Geolocation not available");
}

export function attachMotionAndOrientation(latestState) {
  let accel = null;

  // Prefer Generic Sensor API Accelerometer when available.
  if ("Accelerometer" in window) {
    try {
      accel = new Accelerometer({ frequency: 100 });
      accel.addEventListener("reading", () => {
        const x = finiteOrNull(accel.x);
        const y = finiteOrNull(accel.y);
        const z = finiteOrNull(accel.z);
        latestState.ax = x;
        latestState.ay = y;
        latestState.az = z;
        latestState.ax_g = x;
        latestState.ay_g = y;
        latestState.az_g = z;
        latestState.motion_ok = 1;
        latestState.motion_src = "accelerometer";
      });
      accel.addEventListener("error", () => {});
      accel.start();
    } catch {}
  }

  const onMotion = (ev) => {
    const a = ev.acceleration;
    const ag = ev.accelerationIncludingGravity;
    const rr = ev.rotationRate;

    // If Accelerometer API is active, it is the source of truth for acceleration values.
    if (!accel && ag) {
      latestState.ax = finiteOrNull(ag.x);
      latestState.ay = finiteOrNull(ag.y);
      latestState.az = finiteOrNull(ag.z);
      latestState.motion_src = "devicemotion";
    } else if (!accel && a) {
      // Fallback if gravity-included acceleration is unavailable.
      latestState.ax = finiteOrNull(a.x);
      latestState.ay = finiteOrNull(a.y);
      latestState.az = finiteOrNull(a.z);
      latestState.motion_src = "devicemotion";
    }
    if (!accel && ag) {
      latestState.ax_g = finiteOrNull(ag.x);
      latestState.ay_g = finiteOrNull(ag.y);
      latestState.az_g = finiteOrNull(ag.z);
    } else if (!accel && a) {
      latestState.ax_g = finiteOrNull(a.x);
      latestState.ay_g = finiteOrNull(a.y);
      latestState.az_g = finiteOrNull(a.z);
    }
    if (rr) {
      // Some browsers provide alpha/beta/gamma as deg/s
      latestState.gx = finiteOrNull(rr.alpha);
      latestState.gy = finiteOrNull(rr.beta);
      latestState.gz = finiteOrNull(rr.gamma);
    }
    latestState.motion_ok = 1;
  };

  const onOrientation = (ev) => {
    latestState.alpha = finiteOrNull(ev.alpha);
    latestState.beta = finiteOrNull(ev.beta);
    latestState.gamma = finiteOrNull(ev.gamma);
  };

  window.addEventListener("devicemotion", onMotion, { passive: true });
  window.addEventListener("deviceorientation", onOrientation, { passive: true });

  return () => {
    try { accel?.stop(); } catch {}
    accel = null;
    latestState.motion_src = null;
    window.removeEventListener("devicemotion", onMotion);
    window.removeEventListener("deviceorientation", onOrientation);
  };
}

export function attachGeolocation(latestState) {
  let watchId = null;

  const start = () => new Promise((resolve, reject) => {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        latestState.lat = finiteOrNull(c.latitude);
        latestState.lon = finiteOrNull(c.longitude);
        latestState.gps_acc_m = finiteOrNull(c.accuracy);
        latestState.speed_mps = finiteOrNull(c.speed);
        latestState.heading_deg = finiteOrNull(c.heading);
        latestState.alt_m = finiteOrNull(c.altitude);
        latestState.gps_ok = 1;
        resolve();
      },
      (err) => {
        latestState.gps_ok = 0;
        // keep running; user may enable later
        reject(err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );
  });

  const stop = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  };

  return { start, stop };
}

function finiteOrNull(x) {
  return Number.isFinite(x) ? x : null;
}
