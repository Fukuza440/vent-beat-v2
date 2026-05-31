/* Fix note: loading main.js as a module via file:// prevented it from running at all, so the script now loads via a deferred classic tag; logging hooks were left in place to make slider/input activity easy to trace. */
const TWO_PI = Math.PI * 2;
const HIT_ANGLE_TOL_MULT = 1.0; // multiplier for per-substep rotation to derive hit window
const MIN_HIT_ANGLE_TOL = 0.01;
const MAX_HIT_ANGLE_TOL = 0.6;
const SIM_SUBSTEPS = 4;

/*
 * DEBUG DUMP: collision/audio pipeline as of 2024-05-26 (Vol.2)
 *
 * rawStrength source (stepSimulation inner loop):
 *   - revPerSec = state.rpm / 60; radPerSec = revPerSec * TWO_PI;
 *   - dtSub = dt / SIM_SUBSTEPS; deltaTheta = radPerSec * dtSub;
 *   - hitAngleTol = clamp(deltaTheta * HIT_ANGLE_TOL_MULT, MIN_HIT_ANGLE_TOL, MAX_HIT_ANGLE_TOL);
 *   - diff = smallestAngleDiff(bladeAngleWithWobble, obstacle.angle);
 *   - one-sided window: inZone if diff > 0 && diff <= hitAngleTol;
 *   - rawStrength = clamp(1 - diff / hitAngleTol, 0, 1) when inZone, then edge-detected per blade/obstacle.
 *
 * registerCollision(rawStrength, obstacle, bladeIndex, obstacleIndex):
 *   - Gate only: threshold = clamp(state.hitThreshold, 0..1); if rawStrength < threshold => return (silent).
 *   - Re-normalize survivors: strength = clamp((rawStrength - threshold) / (1 - threshold), 0..1); if threshold ~1, strength = 1.
 *   - hit logging, hit-rate logging, then playClick({ rawStrength, strength, obstacle, obstacleIndex, bladeIndex }).
 *
 * playClick(payload):
 *   - Chooses sample vs noise, forwards rawStrength/strength to playSampleHit or playNoiseHit.
 *
 * playSampleHit(buffer, payload):
 *   - impact = getImpactStrength(strength) // dynamics knob mixes between flat and full strength
 *   - Gain/decay use impact; tone (Soft Hit Low-Cut) uses strength: lowCutFactor = getSoftHitLowCutFactor(strength).
 *
 * playNoiseHit(payload):
 *   - Same pattern: impact for gain/decay, strength for tone/filters.
 *
 * getImpactStrength(strength):
 *   - dyn = state.impactDynamics in [0,1]; returns 1 - dyn * (1 - clamp(strength)).
 *   - dyn=0 => always 1 (flat); dyn=1 => passthrough strength.
 *
 * getSoftHitLowCutFactor(strength):
 *   - bias = state.softHitLowCut in [0,1]; softness = 1 - clamp(strength); returns bias * softness.
 *   - Weak hits (small strength) -> higher factor -> higher HPF cutoff.
 *
 * Intended behavior:
 * - rawStrength: 0..1 from geometry only.
 * - hitThreshold: 0..1, gate only. rawStrength < threshold => no sound.
 * - strength: normalized (rawStrength - threshold) / (1 - threshold), so survivors span 0..1.
 * - impactDynamics: 0..1; 0 = flat levels, 1 = full strength-based dynamics.
 * - Soft Hit Low-Cut: uses strength to high-pass weak hits more than strong hits.
 * Confirmed: hitThreshold is only used for gating/normalization here; hitRate logs should decrease as threshold rises.
 */

const APP_VERSION = "v2.3.4";
const MAX_RECORDING_SECONDS = 120;
const MAX_USER_SAMPLE_SECONDS = 5;
const MAX_USER_SAMPLE_BYTES = 10 * 1024 * 1024;
const MAX_USER_SAMPLES = 20;
const APPROX_MAX_USER_SAMPLE_STORAGE_BYTES = 50 * 1024 * 1024;
const USER_SAMPLE_DB_NAME = "ventBeatSimVol2.userSamples";
const USER_SAMPLE_DB_VERSION = 1;
const USER_SAMPLE_STORE = "samples";

const state = {
  running: false,
  rpm: 200,
  bladeCount: 3,
  axisJitter: 0.1,
  timingJitter: 0.3,
  softHitLowCut: 0.4,
  hitThreshold: 0.12,
  obstacleCount: 3,
  wobbleFreqHz: 3.0,
  tailMs: 250,
  voiceMode: "mono",
  impactDynamics: 0.4,
};

let obstacles = [];
let wasInHitZone = [];
let wobblePhasePerBlade = [];
let lastHitRev = [];
let hitCount = 0;
let lastHitRateLogTime = 0;

const PRESET_STORAGE_KEY = "ventBeatSimVol2.presets";

const obstacleVolumeContainer =
  document.getElementById("obstacleVolumeControls");
const angleTrack = document.getElementById("obstacleAngleTrack");
const angleList = document.getElementById("obstacleAngleList");
const recordingButton = document.getElementById("recordingButton");
const recordingTimeEl = document.getElementById("recordingTime");
const recordingStatusEl = document.getElementById("recordingStatus");
const userSampleInput = document.getElementById("userSampleInput");
const userSampleStatusEl = document.getElementById("userSampleStatus");
const userSampleCountEl = document.getElementById("userSampleCount");
const userSampleListEl = document.getElementById("userSampleList");
const clearUserSamplesButton = document.getElementById("clearUserSamples");
const MAX_PRESETS = 10;
const presets = new Array(MAX_PRESETS).fill(null);
const presetSummaryEls = [];
let sampleBuffers = [];
let sampleMetas = [];
let userSamples = [];
let userSampleDb = null;
let userSamplePersistenceAvailable = false;
const activeVoices = {
  sample: [],
  noise: [],
};
let audioContext = null;
let masterGain = null;
let noiseBuffer = null;
let audioReadyPromise = null;
let recorderNode = null;
let recorderReady = false;
let recorderSupported =
  typeof window !== "undefined" && "AudioWorkletNode" in window;
let isRecording = false;
let recordingStartedAt = 0;
let recordingTimerId = null;
let recordedChunks = [];
let recordedSampleRate = null;
let recordingFileCounter = 0;

function smallestAngleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return d;
}

function setVoiceMode(mode) {
  const next = mode === "poly" ? "poly" : "mono";
  state.voiceMode = next;
  console.log(`[audio] Voice mode set to ${next}`);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function radiansToDegrees(rad) {
  return (rad * 180) / Math.PI;
}

function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

function normalizeDegrees(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

function getTailSeconds() {
  const tailMs = Number(state.tailMs) || 250;
  return clamp(tailMs / 1000, 0.05, 5);
}

function getSampleOptions() {
  const count = Math.max(
    Array.isArray(sampleMetas) ? sampleMetas.length : 0,
    Array.isArray(sampleBuffers) ? sampleBuffers.length : 0
  );
  const options = [
    {
      group: "Noise",
      options: [{ value: "noise", label: "Noise" }],
    },
  ];

  if (userSamples.length > 0) {
    options.push({
      group: "User Samples",
      options: userSamples.map((sample, index) => ({
        value: sampleRefToSelectValue({ type: "user", id: sample.id }),
        label: `User ${index + 1}: ${sample.name}`,
      })),
    });
  }

  const builtInOptions = [];
  for (let i = 0; i < count; i += 1) {
    const meta = sampleMetas[i];
    const baseLabel = meta && meta.label ? meta.label : `Sample ${i + 1}`;
    const file = meta && meta.file ? meta.file : null;
    builtInOptions.push({
      value: sampleRefToSelectValue(
        file ? { type: "builtin", id: file } : sampleRefFromLegacyIndex(i)
      ),
      label: `${i + 1}: ${baseLabel}`,
    });
  }
  if (builtInOptions.length > 0) {
    options.push({
      group: "Built-in Samples",
      options: builtInOptions,
    });
  }
  return options;
}

function sampleRefFromLegacyIndex(index) {
  if (index < 0) return { type: "noise" };
  const meta = sampleMetas[index];
  if (meta && meta.file) {
    return { type: "builtin", id: meta.file };
  }
  return { type: "builtin", index };
}

function normalizeSampleRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  if (ref.type === "noise") return { type: "noise" };
  if (ref.type === "builtin") {
    if (typeof ref.id === "string") return { type: "builtin", id: ref.id };
    if (typeof ref.index === "number") return sampleRefFromLegacyIndex(ref.index);
  }
  if (ref.type === "user" && typeof ref.id === "string") {
    return { type: "user", id: ref.id };
  }
  return null;
}

function sampleRefToSelectValue(ref) {
  const normalized = normalizeSampleRef(ref) || { type: "noise" };
  if (normalized.type === "noise") return "noise";
  if (normalized.type === "builtin") {
    return `builtin:${encodeURIComponent(normalized.id ?? "")}`;
  }
  if (normalized.type === "user") {
    return `user:${encodeURIComponent(normalized.id)}`;
  }
  return "noise";
}

function sampleRefFromSelectValue(value) {
  if (value === "noise" || value === "-1") return { type: "noise" };
  if (value.startsWith("builtin:")) {
    return { type: "builtin", id: decodeURIComponent(value.slice(8)) };
  }
  if (value.startsWith("user:")) {
    return { type: "user", id: decodeURIComponent(value.slice(5)) };
  }
  const legacyIndex = Number.parseInt(value, 10);
  if (!Number.isNaN(legacyIndex)) {
    return legacyIndex < 0 ? { type: "noise" } : sampleRefFromLegacyIndex(legacyIndex);
  }
  return { type: "noise" };
}

function getObstacleSampleRef(obstacle) {
  const fromRef = normalizeSampleRef(obstacle?.sampleRef);
  if (fromRef) return fromRef;
  const legacy =
    obstacle && typeof obstacle.sampleIndex === "number"
      ? obstacle.sampleIndex
      : 0;
  return sampleRefFromLegacyIndex(legacy);
}

function getLegacyIndexForSampleRef(ref) {
  const normalized = normalizeSampleRef(ref);
  if (!normalized || normalized.type === "noise") return -1;
  if (normalized.type === "user") return -1;
  const index = sampleMetas.findIndex((meta) => meta.file === normalized.id);
  return index >= 0 ? index : -1;
}

function getBuiltinSampleIndexByRef(ref) {
  const normalized = normalizeSampleRef(ref);
  if (!normalized || normalized.type !== "builtin") return -1;
  if (typeof normalized.id === "string") {
    return sampleMetas.findIndex((meta) => meta.file === normalized.id);
  }
  return -1;
}

// ===== スライダーと表示のバインド =====

function bindSlider(sliderId, valueId, key, options = {}) {
  const slider = document.getElementById(sliderId);
  const valueEl = document.getElementById(valueId);

  if (!slider || !valueEl) {
    console.error("Missing slider or value element:", sliderId, valueId);
    return;
  }

  const {
    transform = (v) => parseFloat(v),
    format = (v) => v.toString(),
    onChange,
  } = options;

  const apply = () => {
    const raw = slider.value;
    const value = transform(raw);
    state[key] = value;
    valueEl.textContent = format(value);
    console.log(`[param] ${key} -> ${value}`);
    if (typeof onChange === "function") {
      onChange(value);
    }
  };

  slider.addEventListener("input", apply);
  apply(); // 初期同期
}

// 障害物の角度を再生成
function rebuildObstacles() {
  const previous = obstacles.map((obs) => ({
    angle: obs.angle,
    volume: obs.volume ?? 1,
    sampleIndex:
      typeof obs.sampleIndex === "number" ? obs.sampleIndex : 0,
    sampleRef: normalizeSampleRef(obs.sampleRef),
    enabled: obs.enabled !== false,
  }));
  obstacles = [];
  const count = Math.max(0, state.obstacleCount | 0);
  const availableSamples =
    Array.isArray(sampleBuffers) && sampleBuffers.length > 0
      ? sampleBuffers.length
      : 0;
  if (count === 0) {
    resetCollisionState();
    refreshObstacleUI();
    return;
  }

  for (let i = 0; i < count; i++) {
    const preserved = previous[i];
    let angle;
    if (preserved && typeof preserved.angle === "number") {
      angle = preserved.angle;
    } else {
      angle = (TWO_PI * i) / count;
    }
    angle = (angle % TWO_PI + TWO_PI) % TWO_PI;
    obstacles.push({
      angle,
      sampleIndex:
        preserved && typeof preserved.sampleIndex === "number"
          ? preserved.sampleIndex
          : availableSamples > 0
          ? i % availableSamples
          : -1,
      sampleRef:
        preserved && preserved.sampleRef
          ? preserved.sampleRef
          : availableSamples > 0
          ? sampleRefFromLegacyIndex(i % availableSamples)
          : { type: "noise" },
      volume: preserved ? preserved.volume : 1,
      enabled: preserved ? preserved.enabled !== false : true,
    });
  }
  resetCollisionState();
  refreshObstacleUI();
}

// スライダーのセットアップ
bindSlider("rpmSlider", "rpmValue", "rpm", {
  transform: (v) => parseFloat(v),
  format: (v) => Math.round(v).toString(),
  onChange: () => resetCollisionState(),
});

bindSlider("bladeSlider", "bladeValue", "bladeCount", {
  transform: (v) => parseInt(v, 10),
  format: (v) => v.toString(),
  onChange: () => {
    resetCollisionState();
  },
});

bindSlider("axisSlider", "axisValue", "axisJitter", {
  transform: (v) => parseFloat(v),
  format: (v) => Number(v).toFixed(2),
});

bindSlider("timingJitterSlider", "timingJitterValue", "timingJitter", {
  transform: (v) => clamp(parseFloat(v) / 100, 0, 1),
  format: (v) => `${Math.round((Number(v) || 0) * 100)}`,
  onChange: () => {
    console.log("[wobble] timingJitter =", state.timingJitter);
  },
});

bindSlider("wobbleFreqSlider", "wobbleFreqValue", "wobbleFreqHz", {
  transform: (v) => parseFloat(v),
  format: (v) => Number(v).toFixed(1),
});

bindSlider("thresholdSlider", "thresholdValue", "hitThreshold", {
  transform: (v) => parseFloat(v),
  format: (v) => Number(v).toFixed(2),
});

bindSlider("obstacleSlider", "obstacleValue", "obstacleCount", {
  transform: (v) => parseInt(v, 10),
  format: (v) => v.toString(),
  onChange: () => rebuildObstacles(),
});

bindSlider("tailSlider", "tailValue", "tailMs", {
  transform: (v) => parseFloat(v),
  format: (v) => `${Math.round(v)}`,
  onChange: () => {
    console.log(`[env] tailMs = ${state.tailMs} ms`);
  },
});

bindSlider(
  "impactDynamicsSlider",
  "impactDynamicsValue",
  "impactDynamics",
  {
    transform: (v) => clamp(parseFloat(v) / 100, 0, 1),
    format: (v) => `${Math.round((Number(v) || 0) * 100)}`,
    onChange: () => {
      console.log("[dynamics] impactDynamics =", state.impactDynamics);
    },
  }
);

bindSlider(
  "softHitLowCutSlider",
  "softHitLowCutValue",
  "softHitLowCut",
  {
    transform: (v) => clamp(parseFloat(v) / 100, 0, 1),
    format: (v) => `${Math.round((Number(v) || 0) * 100)}`,
    onChange: () => {
      console.log("[tone] softHitLowCut =", state.softHitLowCut);
    },
  }
);

preloadSampleManifestForUI();

// 初回の障害物生成
rebuildObstacles();
console.log("[vol2] init starting");
preloadSampleManifestForUI();
loadSampleBuffers().then(() => {
  console.log("[vol2] samples loaded at init", {
    sampleCount: sampleBuffers ? sampleBuffers.length : 0,
    metasCount: sampleMetas ? sampleMetas.length : 0,
  });
  refreshObstacleUI();
});
console.log("[vol2] default impactDynamics =", state.impactDynamics);
const versionEl = document.getElementById("appVersion");
if (versionEl) {
  versionEl.textContent = `Vent Fan Beat Simulator Vol.2 — ${APP_VERSION}`;
}
attachStepButtons();
initPresetControls();
initVoiceModeSelector();
initObstaclePositionControls();
initRecordingControls();
initUserSampleControls();

function attachStepButtons() {
  const buttons = document.querySelectorAll(
    "[data-slider][data-direction]"
  );
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const sliderId = button.dataset.slider;
      const slider = document.getElementById(sliderId);
      if (!slider) {
        console.warn("step button missing slider", sliderId);
        return;
      }
      const direction = Number(button.dataset.direction);
      if (!direction) return;
      let step = slider.step ? Number(slider.step) : 1;
      if (!Number.isFinite(step) || step === 0) {
        step = 1;
      }
      const min =
        slider.min !== "" ? Number(slider.min) : Number.NEGATIVE_INFINITY;
      const max =
        slider.max !== "" ? Number(slider.max) : Number.POSITIVE_INFINITY;
      const current = Number(slider.value);
      if (Number.isNaN(current)) return;
      const next = clamp(current + step * direction, min, max);
      if (next === current) return;
      slider.value = String(next);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

function resetHitStates() {
  wasInHitZone = [];
  lastHitRev = [];
  for (let b = 0; b < state.bladeCount; b += 1) {
    wasInHitZone[b] = new Array(obstacles.length).fill(false);
    lastHitRev[b] = new Array(obstacles.length).fill(-Infinity);
  }
}

function ensureHitStateSize() {
  if (
    wasInHitZone.length !== state.bladeCount ||
    lastHitRev.length !== state.bladeCount
  ) {
    resetHitStates();
    return;
  }
  for (let b = 0; b < state.bladeCount; b += 1) {
    if (
      !wasInHitZone[b] ||
      wasInHitZone[b].length !== obstacles.length ||
      !lastHitRev[b] ||
      lastHitRev[b].length !== obstacles.length
    ) {
      resetHitStates();
      return;
    }
  }
}

function resetWobblePhases() {
  wobblePhasePerBlade = [];
  const bladeCount = state.bladeCount || 0;
  if (bladeCount <= 0) return;

  for (let b = 0; b < bladeCount; b += 1) {
    wobblePhasePerBlade[b] = (TWO_PI * b) / bladeCount;
  }
  console.log("[wobble] reset phases (locked)");
}

function ensureWobblePhaseSize() {
  if (wobblePhasePerBlade.length !== state.bladeCount) {
    resetWobblePhases();
  }
}

function resetCollisionState() {
  resetHitStates();
  resetWobblePhases();
}

function formatVolumeLabel(value) {
  return `${Math.round(value * 100)}%`;
}

function renderObstacleVolumeControls() {
  if (!obstacleVolumeContainer) return;
  obstacleVolumeContainer.innerHTML = "";
  if (!obstacles.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "No obstacles. Increase the obstacle count to edit volumes.";
    obstacleVolumeContainer.appendChild(p);
    return;
  }

  const sampleOptions = getSampleOptions();

  obstacles.forEach((obstacle, index) => {
    const row = document.createElement("div");
    row.className = "obstacle-volume-row";

    const label = document.createElement("label");
    label.textContent = `Obstacle #${index + 1}`;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "150";
    slider.step = "1";
    const sliderValue = Math.round((obstacle.volume ?? 1) * 100);
    slider.value = `${sliderValue}`;

    const valueEl = document.createElement("span");
    valueEl.className = "obstacle-volume-value";
    valueEl.textContent = formatVolumeLabel(obstacle.volume ?? 1);

    slider.addEventListener("input", () => {
      const raw = Number.parseInt(slider.value, 10);
      const volumeFactor = clamp(
        Number.isFinite(raw) ? raw / 100 : 1,
        0,
        1.5
      );
      obstacle.volume = volumeFactor;
      valueEl.textContent = formatVolumeLabel(volumeFactor);
    });

    const select = document.createElement("select");
    sampleOptions.forEach((group) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.group;
      group.options.forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        optgroup.appendChild(opt);
      });
      select.appendChild(optgroup);
    });
    const currentRef = getObstacleSampleRef(obstacle);
    select.value = sampleRefToSelectValue(currentRef);
    if (!select.value) {
      select.value = "noise";
      obstacle.sampleRef = { type: "noise" };
      obstacle.sampleIndex = -1;
    }
    select.addEventListener("change", () => {
      const ref = sampleRefFromSelectValue(select.value);
      obstacle.sampleRef = ref;
      obstacle.sampleIndex = getLegacyIndexForSampleRef(ref);
      if (ref.type === "user" && !findUserSampleById(ref.id)) {
        console.warn("[user-samples] selected user sample is missing", ref.id);
      }
    });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "small-button obstacle-toggle";
    const updateToggle = () => {
      const enabled = obstacle.enabled !== false;
      toggle.textContent = enabled ? "On" : "Off";
      toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    };
    updateToggle();
    toggle.addEventListener("click", () => {
      obstacle.enabled = obstacle.enabled === false ? true : false;
      updateToggle();
      renderObstacleAngleControls();
      console.log("[obstacle] toggle enabled", {
        index,
        enabled: obstacle.enabled !== false,
      });
    });

    row.append(label, slider, valueEl, toggle, select);
    obstacleVolumeContainer.appendChild(row);
  });
}

function applyObstacleVolumes(volumes = []) {
  for (let i = 0; i < obstacles.length; i += 1) {
    const vol = volumes[i];
    obstacles[i].volume =
      typeof vol === "number" ? clamp(vol, 0, 1.5) : obstacles[i].volume ?? 1;
  }
}

function applyObstacleSamples(sampleIndices = []) {
  for (let i = 0; i < obstacles.length; i += 1) {
    const idx = sampleIndices[i];
    if (typeof idx === "number") {
      obstacles[i].sampleIndex = idx;
      obstacles[i].sampleRef = sampleRefFromLegacyIndex(idx);
    }
  }
}

function applyObstacleSampleRefs(sampleRefs = []) {
  for (let i = 0; i < obstacles.length; i += 1) {
    const ref = normalizeSampleRef(sampleRefs[i]);
    if (ref) {
      obstacles[i].sampleRef = ref;
      obstacles[i].sampleIndex = getLegacyIndexForSampleRef(ref);
      if (ref.type === "user" && !findUserSampleById(ref.id)) {
        console.warn(
          "[user-samples] preset references a missing user sample; noise fallback will be used",
          ref.id
        );
      }
    }
  }
}

function applyObstacleEnabled(enabledFlags = []) {
  for (let i = 0; i < obstacles.length; i += 1) {
    const flag = enabledFlags[i];
    if (typeof flag === "boolean") {
      obstacles[i].enabled = flag;
    }
  }
}

function applyObstacleAngles(anglesDeg = []) {
  for (let i = 0; i < obstacles.length; i += 1) {
    const deg = anglesDeg[i];
    if (typeof deg === "number") {
      const norm = normalizeDegrees(deg);
      obstacles[i].angle = degreesToRadians(norm);
    }
  }
}

function renderObstacleAngleControls() {
  if (!angleTrack) return;
  angleTrack.innerHTML = "";
  if (!obstacles.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "No obstacles. Increase the obstacle count to place them.";
    angleTrack.appendChild(p);
    return;
  }

  obstacles.forEach((obstacle, index) => {
    const thumb = document.createElement("div");
    thumb.className = "angle-thumb";
    if (obstacle.enabled === false) {
      thumb.classList.add("obstacle-thumb-disabled");
    }
    thumb.textContent = `${index + 1}`;
    const deg = normalizeDegrees(radiansToDegrees(obstacle.angle ?? 0));
    const percent = deg / 360;
    thumb.style.left = `${percent * 100}%`;

    thumb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const activePointerId = event.pointerId;

      const handlePointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== activePointerId) return;
        moveEvent.preventDefault();
        const rect = angleTrack.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = clamp(
          (moveEvent.clientX - rect.left) / rect.width,
          0,
          1
        );
        const rad = ratio * TWO_PI;
        obstacles[index].angle = rad;
        thumb.style.left = `${ratio * 100}%`;
        renderObstacleAngleList();
      };

      const handlePointerUp = (upEvent) => {
        if (upEvent.pointerId !== activePointerId) return;
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerUp);
        resetCollisionState();
        renderObstacleAngleList();
      };

      handlePointerMove(event);
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerUp);
    });

    angleTrack.appendChild(thumb);
  });
}

function refreshObstacleUI() {
  renderObstacleVolumeControls();
  renderObstacleAngleControls();
  renderObstacleAngleList();
}

function renderObstacleAngleList() {
  if (!angleList) return;
  angleList.innerHTML = "";
  if (!obstacles.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No obstacles.";
    angleList.appendChild(li);
    return;
  }
  obstacles.forEach((obstacle, index) => {
    const li = document.createElement("li");
    const deg = normalizeDegrees(radiansToDegrees(obstacle.angle ?? 0));
    li.textContent = `#${index + 1}: ${deg.toFixed(1)}°`;
    angleList.appendChild(li);
  });
}

function initVoiceModeSelector() {
  const select = document.getElementById("voiceModeSelect");
  if (!select) return;
  if (!state.voiceMode) {
    state.voiceMode = "mono";
  }
  select.value = state.voiceMode;
  setVoiceMode(select.value);
  select.addEventListener("change", (event) => {
    setVoiceMode(event.target.value);
  });
}

function initObstaclePositionControls() {
  const btn = document.getElementById("alignObstaclesToBlades");
  if (btn) {
    btn.addEventListener("click", () => {
      alignObstaclesToBlades();
    });
  }
}

function alignObstaclesToBlades() {
  if (!Array.isArray(obstacles) || obstacles.length === 0) return;
  const enabled = obstacles.filter((obs) => obs && obs.enabled !== false);
  const disabledCount = obstacles.length - enabled.length;
  console.log("[vol2] distributeEvenly", {
    total: obstacles.length,
    enabled: enabled.length,
    disabled: disabledCount,
  });
  if (enabled.length <= 0) {
    console.log("[vol2] distributeEvenly: no enabled obstacles, nothing to do");
    return;
  }
  const count = enabled.length;
  const step = TWO_PI / count;
  enabled.forEach((obs, idx) => {
    if (obs) {
      obs.angle = idx * step;
    }
  });
  resetCollisionState();
  refreshObstacleUI();
  console.log("[obstacles] distributed evenly over 0-360°", {
    obstacleCount: count,
  });
}

function setSliderValue(id, value) {
  const slider = document.getElementById(id);
  if (!slider) return;
  slider.value = `${value}`;
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

function snapshotCurrentPreset() {
  return {
    rpm: state.rpm,
    bladeCount: state.bladeCount,
    axisJitter: state.axisJitter,
    hitThreshold: state.hitThreshold,
    obstacleCount: state.obstacleCount,
    wobbleFreqHz: state.wobbleFreqHz,
    tailMs: state.tailMs,
    timingJitter: state.timingJitter,
    softHitLowCut: state.softHitLowCut,
    impactDynamics: state.impactDynamics,
    obstacleVolumes: obstacles.map((obs) => obs.volume ?? 1),
    obstacleSampleIndices: obstacles.map(
      (obs) =>
        (typeof obs.sampleIndex === "number" ? obs.sampleIndex : 0)
    ),
    obstacleSampleRefs: obstacles.map((obs) => getObstacleSampleRef(obs)),
    obstacleEnabled: obstacles.map((obs) => obs.enabled !== false),
    obstacleAnglesDeg: obstacles.map((obs) =>
      normalizeDegrees(radiansToDegrees(obs.angle ?? 0))
    ),
  };
}

function updatePresetSummaries() {
  for (let i = 0; i < MAX_PRESETS; i += 1) {
    const summaryEl = presetSummaryEls[i];
    if (!summaryEl) continue;
    const preset = presets[i];
    if (!preset) {
      summaryEl.textContent = "(empty)";
    } else {
      summaryEl.textContent = `${Math.round(preset.rpm)} rpm / ${preset.bladeCount} blades / ${preset.obstacleCount} obs`;
    }
  }
}

function savePreset(index) {
  if (presets[index]) {
    const ok = window.confirm(
      `Preset ${index + 1} already exists. Overwrite it?`
    );
    if (!ok) return;
  }
  presets[index] = snapshotCurrentPreset();
  persistPresets();
  updatePresetSummaries();
  console.log(`Preset ${index + 1} saved.`);
}

function applyPreset(preset) {
  setSliderValue("rpmSlider", preset.rpm);
  setSliderValue("bladeSlider", preset.bladeCount);
  setSliderValue("axisSlider", preset.axisJitter);
  if (preset.timingJitter != null) {
    const percent = clamp(preset.timingJitter, 0, 1) * 100;
    setSliderValue("timingJitterSlider", Math.round(percent));
  }
  if (preset.impactDynamics != null) {
    const percent = clamp(preset.impactDynamics, 0, 1) * 100;
    setSliderValue("impactDynamicsSlider", Math.round(percent));
  }
  if (preset.softHitLowCut != null) {
    const percent = clamp(preset.softHitLowCut, 0, 1) * 100;
    setSliderValue("softHitLowCutSlider", Math.round(percent));
  }
  setSliderValue("thresholdSlider", preset.hitThreshold);
  setSliderValue("wobbleFreqSlider", preset.wobbleFreqHz);
  if (preset.tailMs != null) {
    setSliderValue("tailSlider", preset.tailMs);
  }
  setSliderValue("obstacleSlider", preset.obstacleCount);
  applyObstacleVolumes(preset.obstacleVolumes || []);
  if (Array.isArray(preset.obstacleSampleRefs)) {
    applyObstacleSampleRefs(preset.obstacleSampleRefs);
  } else {
    applyObstacleSamples(preset.obstacleSampleIndices || []);
  }
  applyObstacleEnabled(preset.obstacleEnabled || []);
  applyObstacleAngles(preset.obstacleAnglesDeg || []);
  refreshObstacleUI();
  resetCollisionState();
}

function loadPreset(index) {
  const preset = presets[index];
  if (!preset) {
    console.warn(`Preset ${index + 1} is empty.`);
    return;
  }
  applyPreset(preset);
  console.log(`Preset ${index + 1} loaded.`);
}

function deletePreset(index) {
  if (!presets[index]) return;
  presets[index] = null;
  persistPresets();
  updatePresetSummaries();
  console.log(`Preset ${index + 1} deleted.`);
}

function persistPresets() {
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn("Failed to persist presets", err);
  }
}

function loadPresetsFromStorage() {
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (let i = 0; i < Math.min(parsed.length, MAX_PRESETS); i += 1) {
        presets[i] = parsed[i];
      }
    }
  } catch (err) {
    console.warn("Failed to load presets from storage", err);
  }
}

function initPresetControls() {
  for (let i = 0; i < MAX_PRESETS; i += 1) {
    const summaryEl = document.getElementById(`presetSummary${i}`);
    if (summaryEl) {
      presetSummaryEls[i] = summaryEl;
    }
    const saveBtn = document.querySelector(
      `.preset-save[data-preset="${i}"]`
    );
    if (saveBtn) {
      saveBtn.addEventListener("click", () => savePreset(i));
    }
    const loadBtn = document.querySelector(
      `.preset-load[data-preset="${i}"]`
    );
    if (loadBtn) {
      loadBtn.addEventListener("click", () => loadPreset(i));
    }
    const deleteBtn = document.querySelector(
      `.preset-delete[data-preset="${i}"]`
    );
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deletePreset(i));
    }
  }
  loadPresetsFromStorage();
  updatePresetSummaries();
}

// ===== User Samples =====

function setUserSampleStatus(message, stateClass = "") {
  if (!userSampleStatusEl) return;
  userSampleStatusEl.textContent = message;
  userSampleStatusEl.classList.remove("is-error", "is-ok");
  if (stateClass) {
    userSampleStatusEl.classList.add(stateClass);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  return `${value.toFixed(2)} sec`;
}

function findUserSampleById(id) {
  return userSamples.find((sample) => sample.id === id) || null;
}

function getApproxUserSampleStorageBytes() {
  return userSamples.reduce((sum, sample) => sum + (sample.size || 0), 0);
}

function renderUserSamples() {
  if (userSampleCountEl) {
    userSampleCountEl.textContent = `${userSamples.length} user sample${
      userSamples.length === 1 ? "" : "s"
    }`;
  }
  if (!userSampleListEl) return;
  userSampleListEl.innerHTML = "";
  if (!userSamples.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No user samples added.";
    userSampleListEl.appendChild(p);
    return;
  }

  userSamples.forEach((sample, index) => {
    const row = document.createElement("div");
    row.className = "user-sample-row";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "user-sample-name";
    name.textContent = `User ${index + 1}: ${sample.name}`;
    const meta = document.createElement("div");
    meta.className = "user-sample-meta";
    meta.textContent = `${formatDuration(sample.duration)} / ${formatBytes(
      sample.size
    )}`;
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "user-sample-row-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "small-button";
    preview.textContent = "Preview";
    preview.addEventListener("click", () => {
      previewUserSample(sample.id).catch((err) => {
        console.error("[user-samples] preview failed", err);
        setUserSampleStatus("Preview failed.", "is-error");
      });
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "small-button";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      deleteUserSample(sample.id).catch((err) => {
        console.error("[user-samples] delete failed", err);
        setUserSampleStatus("Delete failed.", "is-error");
      });
    });
    actions.append(preview, del);

    row.append(info, actions);
    userSampleListEl.appendChild(row);
  });
}

function initUserSampleControls() {
  if (userSampleInput) {
    userSampleInput.addEventListener("change", () => {
      const files = Array.from(userSampleInput.files || []);
      userSampleInput.value = "";
      addUserSampleFiles(files).catch((err) => {
        console.error("[user-samples] add failed", err);
        setUserSampleStatus("Failed to add user samples.", "is-error");
      });
    });
  }
  if (clearUserSamplesButton) {
    clearUserSamplesButton.addEventListener("click", () => {
      clearAllUserSamples().catch((err) => {
        console.error("[user-samples] clear failed", err);
        setUserSampleStatus("Clear failed.", "is-error");
      });
    });
  }
  renderUserSamples();
  initUserSamplePersistence().catch((err) => {
    console.warn("[user-samples] persistence unavailable", err);
    userSamplePersistenceAvailable = false;
    setUserSampleStatus(
      "Persistent storage unavailable. User samples will be kept for this session only.",
      "is-error"
    );
  });
}

async function initUserSamplePersistence() {
  if (!("indexedDB" in window)) {
    throw new Error("IndexedDB is not available.");
  }
  userSampleDb = await openUserSampleDb();
  userSamplePersistenceAvailable = true;
  const records = await getAllUserSampleRecords();
  userSamples = records.map((record) => ({
    ...record,
    buffer: null,
  }));
  renderUserSamples();
  refreshObstacleUI();
  setUserSampleStatus(
    userSamples.length
      ? `Restored ${userSamples.length} user sample(s).`
      : "Ready",
    userSamples.length ? "is-ok" : ""
  );
}

function openUserSampleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      USER_SAMPLE_DB_NAME,
      USER_SAMPLE_DB_VERSION
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(USER_SAMPLE_STORE)) {
        db.createObjectStore(USER_SAMPLE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getUserSampleStore(mode = "readonly") {
  if (!userSampleDb) return null;
  return userSampleDb.transaction(USER_SAMPLE_STORE, mode).objectStore(USER_SAMPLE_STORE);
}

function getAllUserSampleRecords() {
  return new Promise((resolve, reject) => {
    const store = getUserSampleStore("readonly");
    if (!store) {
      resolve([]);
      return;
    }
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putUserSampleRecord(record) {
  if (!userSamplePersistenceAvailable) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const store = getUserSampleStore("readwrite");
    if (!store) {
      resolve();
      return;
    }
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteUserSampleRecord(id) {
  if (!userSamplePersistenceAvailable) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const store = getUserSampleStore("readwrite");
    if (!store) {
      resolve();
      return;
    }
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearUserSampleRecords() {
  if (!userSamplePersistenceAvailable) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const store = getUserSampleStore("readwrite");
    if (!store) {
      resolve();
      return;
    }
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function addUserSampleFiles(files) {
  if (!files.length) return;
  const messages = [];
  for (const file of files) {
    if (userSamples.length >= MAX_USER_SAMPLES) {
      messages.push(`${file.name}: rejected, max ${MAX_USER_SAMPLES} user samples.`);
      continue;
    }
    if (file.size > MAX_USER_SAMPLE_BYTES) {
      messages.push(`${file.name}: rejected, file is over 10 MB.`);
      continue;
    }
    if (
      getApproxUserSampleStorageBytes() + file.size >
      APPROX_MAX_USER_SAMPLE_STORAGE_BYTES
    ) {
      messages.push(`${file.name}: rejected, user sample storage is over 50 MB.`);
      continue;
    }

    try {
      await ensureAudio();
      if (!audioContext) throw new Error("AudioContext is not available.");
      const audioData = await file.arrayBuffer();
      const buffer = await audioContext.decodeAudioData(audioData.slice(0));
      if (buffer.duration > MAX_USER_SAMPLE_SECONDS) {
        messages.push(`${file.name}: rejected, duration is over 5 sec.`);
        continue;
      }
      const record = {
        id: createUserSampleId(),
        name: file.name,
        mimeType: file.type || "audio/unknown",
        size: file.size,
        duration: buffer.duration,
        createdAt: new Date().toISOString(),
        audioData,
      };
      try {
        await putUserSampleRecord(record);
      } catch (err) {
        console.warn("[user-samples] persistence failed; keeping session only", err);
        userSamplePersistenceAvailable = false;
        userSampleDb = null;
      }
      userSamples.push({ ...record, buffer });
      messages.push(`${file.name}: added.`);
    } catch (err) {
      console.warn("[user-samples] failed to add", file.name, err);
      messages.push(`${file.name}: failed to decode.`);
    }
  }

  renderUserSamples();
  refreshObstacleUI();
  setUserSampleStatus(messages.join(" "), messages.some((m) => m.includes("rejected") || m.includes("failed")) ? "is-error" : "is-ok");
}

function createUserSampleId() {
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `user_sample_${random}`;
}

async function ensureUserSampleBuffer(sample) {
  if (sample.buffer) return sample.buffer;
  if (!sample.audioData) return null;
  await ensureAudio();
  if (!audioContext) return null;
  sample.buffer = await audioContext.decodeAudioData(sample.audioData.slice(0));
  return sample.buffer;
}

async function decodeUserSamplesForAudio() {
  if (!audioContext || !userSamples.length) return;
  for (const sample of userSamples) {
    if (sample.buffer || !sample.audioData) continue;
    try {
      sample.buffer = await audioContext.decodeAudioData(sample.audioData.slice(0));
    } catch (err) {
      console.warn("[user-samples] failed to restore decoded buffer", sample.name, err);
    }
  }
}

async function previewUserSample(id) {
  const sample = findUserSampleById(id);
  if (!sample) {
    setUserSampleStatus("User sample not found.", "is-error");
    return;
  }
  const buffer = await ensureUserSampleBuffer(sample);
  if (!buffer) {
    setUserSampleStatus("Preview failed.", "is-error");
    return;
  }
  if (audioContext) {
    await audioContext.resume();
  }
  playPreviewBuffer(buffer);
  setUserSampleStatus(`Previewing ${sample.name}.`, "is-ok");
}

function playPreviewBuffer(buffer) {
  const ctx = audioContext;
  if (!ctx || !masterGain) return;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  src.connect(gain).connect(masterGain);
  src.start(ctx.currentTime);
  src.stop(ctx.currentTime + Math.min(buffer.duration, MAX_USER_SAMPLE_SECONDS));
}

async function deleteUserSample(id) {
  await deleteUserSampleRecord(id);
  userSamples = userSamples.filter((sample) => sample.id !== id);
  replaceMissingUserSampleRefs();
  renderUserSamples();
  refreshObstacleUI();
  setUserSampleStatus("User sample deleted.", "is-ok");
}

async function clearAllUserSamples() {
  await clearUserSampleRecords();
  userSamples = [];
  replaceMissingUserSampleRefs();
  renderUserSamples();
  refreshObstacleUI();
  setUserSampleStatus("All user samples cleared.", "is-ok");
}

function replaceMissingUserSampleRefs() {
  obstacles.forEach((obstacle) => {
    const ref = normalizeSampleRef(obstacle.sampleRef);
    if (ref && ref.type === "user" && !findUserSampleById(ref.id)) {
      obstacle.sampleRef = { type: "noise" };
      obstacle.sampleIndex = -1;
    }
  });
}

// ===== WAV Recording =====

function setRecordingStatus(message, stateClass = "") {
  if (!recordingStatusEl) return;
  recordingStatusEl.textContent = message;
  recordingStatusEl.classList.remove("is-recording", "is-error");
  if (stateClass) {
    recordingStatusEl.classList.add(stateClass);
  }
}

function formatRecordingTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const tenths = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(
    wholeSeconds
  ).padStart(2, "0")}.${tenths}`;
}

function updateRecordingTimer() {
  if (!recordingTimeEl) return;
  const elapsed = isRecording
    ? (performance.now() - recordingStartedAt) / 1000
    : 0;
  recordingTimeEl.textContent = formatRecordingTime(elapsed);
  if (isRecording && elapsed >= MAX_RECORDING_SECONDS) {
    stopRecordingAndDownload("max-duration").catch((err) => {
      console.error("[recording] auto-stop failed", err);
      setRecordingStatus("Recording failed.", "is-error");
    });
  }
}

function updateRecordingButton() {
  if (!recordingButton) return;
  recordingButton.classList.toggle("is-recording", isRecording);
  if (!recorderSupported) {
    recordingButton.disabled = true;
    recordingButton.textContent = "Start Recording";
    return;
  }
  recordingButton.disabled = false;
  recordingButton.textContent = isRecording
    ? "Stop & Download WAV"
    : "Start Recording";
}

function setRecordingSupported(supported) {
  recorderSupported = supported;
  if (!supported) {
    setRecordingStatus("Recording is not supported in this browser.", "is-error");
  } else if (!isRecording) {
    setRecordingStatus("Ready");
  }
  updateRecordingButton();
}

async function initRecorderWorklet() {
  if (!audioContext || !masterGain) return false;
  if (recorderReady && recorderNode) return true;

  if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined") {
    recorderReady = false;
    setRecordingSupported(false);
    connectMasterDirect();
    return false;
  }

  try {
    await audioContext.audioWorklet.addModule("wav-recorder-worklet.js");
    recorderNode = new AudioWorkletNode(
      audioContext,
      "wav-recorder-processor",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
      }
    );
    recorderNode.port.onmessage = handleRecorderMessage;
    recorderNode.onprocessorerror = (event) => {
      console.error("[recording] AudioWorklet processor error", event);
      if (isRecording) {
        stopRecordingAndDownload("worklet-error").catch((err) =>
          console.error("[recording] failed after worklet error", err)
        );
      }
      recorderReady = false;
      setRecordingSupported(false);
      connectMasterDirect();
    };

    try {
      masterGain.disconnect();
    } catch (err) {
      // The node may not have an existing output yet.
    }
    masterGain.connect(recorderNode).connect(audioContext.destination);
    recorderReady = true;
    setRecordingSupported(true);
    return true;
  } catch (err) {
    console.warn("[recording] AudioWorklet initialization failed", err);
    recorderNode = null;
    recorderReady = false;
    setRecordingSupported(false);
    connectMasterDirect();
    return false;
  }
}

function connectMasterDirect() {
  if (!audioContext || !masterGain) return;
  try {
    masterGain.disconnect();
  } catch (err) {
    // A not-yet-connected node can throw in some browsers.
  }
  try {
    masterGain.connect(audioContext.destination);
  } catch (err) {
    console.error("[audio] failed to connect master output", err);
  }
}

function handleRecorderMessage(event) {
  const message = event.data || {};
  if (message.type !== "pcm" || !isRecording) return;
  if (message.samples instanceof Float32Array) {
    recordedChunks.push(message.samples);
  }
}

async function startRecording() {
  if (isRecording) return;
  if (!recorderSupported) {
    setRecordingStatus("Recording is not supported in this browser.", "is-error");
    updateRecordingButton();
    return;
  }

  if (!state.running) {
    await startSimulation();
    if (!state.running) {
      setRecordingStatus("Start the simulator before recording.", "is-error");
      return;
    }
  } else {
    await ensureAudio();
    if (audioContext) {
      await audioContext.resume();
    }
  }

  if (!recorderReady || !recorderNode) {
    const ok = await initRecorderWorklet();
    if (!ok) return;
  }

  recordedChunks = [];
  recordedSampleRate = audioContext ? audioContext.sampleRate : null;
  recordingStartedAt = performance.now();
  isRecording = true;
  recorderNode.port.postMessage({ type: "start" });
  setRecordingStatus("Recording...", "is-recording");
  updateRecordingButton();
  updateRecordingTimer();
  recordingTimerId = window.setInterval(updateRecordingTimer, 100);
  console.log("[recording] started", {
    sampleRate: recordedSampleRate,
    maxSeconds: MAX_RECORDING_SECONDS,
  });
}

async function stopRecordingAndDownload(reason = "manual") {
  if (!isRecording) return;
  isRecording = false;
  if (recordingTimerId != null) {
    window.clearInterval(recordingTimerId);
    recordingTimerId = null;
  }
  updateRecordingTimer();
  updateRecordingButton();
  setRecordingStatus("Rendering WAV...");

  if (recorderNode) {
    recorderNode.port.postMessage({ type: "stop" });
  }

  const chunks = recordedChunks;
  const sampleRate = recordedSampleRate || audioContext?.sampleRate || 44100;
  recordedChunks = [];
  recordedSampleRate = null;

  if (!chunks.length) {
    setRecordingStatus("No audio captured.", "is-error");
    console.warn("[recording] stopped with no captured chunks", { reason });
    return;
  }

  const wavBuffer = encodeWavMono(chunks, sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  downloadBlob(blob, createRecordingFilename());
  setRecordingStatus(
    reason === "max-duration" ? "Downloaded. Max length reached." : "Downloaded"
  );
  console.log("[recording] downloaded", {
    reason,
    chunks: chunks.length,
    sampleRate,
    bytes: wavBuffer.byteLength,
  });
}

function encodeWavMono(floatChunks, sampleRate) {
  let totalLength = 0;
  floatChunks.forEach((chunk) => {
    totalLength += chunk.length;
  });

  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = totalLength * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  floatChunks.forEach((chunk) => {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = clamp(chunk[i], -1, 1);
      const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, Math.round(pcm), true);
      offset += bytesPerSample;
    }
  });

  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function createRecordingFilename() {
  const now = new Date();
  const stamp =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}-` +
    `${String(now.getHours()).padStart(2, "0")}` +
    `${String(now.getMinutes()).padStart(2, "0")}` +
    `${String(now.getSeconds()).padStart(2, "0")}`;
  recordingFileCounter += 1;
  const suffix =
    recordingFileCounter > 1
      ? `-${String(recordingFileCounter).padStart(2, "0")}`
      : "";
  return `vent-beat-v2_${stamp}${suffix}.wav`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initRecordingControls() {
  if (!recordingButton) return;
  if (!recorderSupported) {
    setRecordingSupported(false);
  } else {
    setRecordingStatus("Ready");
    updateRecordingButton();
  }
  recordingButton.addEventListener("click", () => {
    if (isRecording) {
      stopRecordingAndDownload("manual").catch((err) => {
        console.error("[recording] stop failed", err);
        setRecordingStatus("Recording failed.", "is-error");
        updateRecordingButton();
      });
    } else {
      startRecording().catch((err) => {
        console.error("[recording] start failed", err);
        setRecordingStatus("Recording failed.", "is-error");
        updateRecordingButton();
      });
    }
  });
}

// ===== Web Audio の準備 =====

async function ensureAudio() {
  if (audioReadyPromise) return audioReadyPromise;

  audioReadyPromise = (async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      throw new Error("Web Audio API に対応していないブラウザです。");
    }

    audioContext = new AC();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.9;
    await initRecorderWorklet();
    noiseBuffer = createNoiseBuffer(audioContext);
    sampleBuffers = await loadSampleBuffers(audioContext);
    await decodeUserSamplesForAudio();
    if (!sampleBuffers.length) {
      console.warn("No samples loaded; using noise fallback only.");
    }
    refreshObstacleUI();
    return audioContext;
  })().catch((err) => {
    console.error("Audio initialization failed:", err);
    audioReadyPromise = null;
    throw err;
  });

  return audioReadyPromise;
}

async function loadSampleBuffers(ctx) {
  sampleMetas = [];
  const buffers = [];
  let manifest;
  try {
    const response = await fetch("../samples/manifest.json", {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    manifest = await response.json();
  } catch (error) {
    console.warn(
      "[audio] No manifest.json found or failed to load; using noise fallback only.",
      error
    );
    return buffers;
  }

  if (!Array.isArray(manifest) || !manifest.length) {
    console.warn(
      "[audio] manifest.json is empty or invalid; using noise fallback only."
    );
    return buffers;
  }

  for (let i = 0; i < manifest.length; i += 1) {
    const entry = manifest[i];
    if (!entry || !entry.file) {
      console.warn(`[audio] Manifest entry ${i} missing file property.`);
      continue;
    }
    const label = entry.label || entry.file;
    const url = `../samples/${entry.file}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[audio] Missing sample ${url} (${response.status}).`);
        continue;
      }
      const data = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      buffers.push(buffer);
      sampleMetas.push({ file: entry.file, label });
      console.log(
        `[audio] Loaded ${entry.file} as Sample ${sampleMetas.length} (${label})`
      );
    } catch (err) {
      console.warn("Failed to load sample:", url, err);
    }
  }

  return buffers;
}

async function preloadSampleManifestForUI() {
  try {
    const response = await fetch("../samples/manifest.json", {
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn("[vol2] UI preload manifest missing", response.status);
      return;
    }
    const manifest = await response.json();
    if (!Array.isArray(manifest) || !manifest.length) return;
    sampleMetas = manifest.map((entry) => ({
      file: entry.file,
      label: entry.label || entry.file,
    }));
    if (typeof refreshObstacleUI === "function") {
      refreshObstacleUI();
    }
  } catch (err) {
    console.warn("[vol2] UI preload failed", err);
  }
}

async function preloadSampleManifestForUI() {
  try {
    const response = await fetch("../samples/manifest.json", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const manifest = await response.json();
    if (!Array.isArray(manifest) || !manifest.length) return;
    sampleMetas = manifest.map((entry) => ({
      file: entry.file,
      label: entry.label || entry.file,
    }));
    refreshObstacleUI();
  } catch (err) {
    console.warn("[audio] UI preload failed", err);
  }
}

function createNoiseBuffer(ctx) {
  const duration = 0.3;
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    channel[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

// ===== シミュレーションループ =====

let lastTimestamp = null;
let simTime = 0;
let lastCollisionSimTime = -Infinity;

const COLLISION_COOLDOWN = 0; // seconds, intentionally 0 because edge detection prevents repeats

function stepSimulation(dt) {
  if (dt <= 0) return;

  const revPerSec = state.rpm / 60;
  const radPerSec = revPerSec * TWO_PI;
  if (radPerSec <= 0) return;

  const substeps = SIM_SUBSTEPS;
  const dtSub = dt / substeps;
  const deltaTheta = radPerSec * dtSub;
  const hitAngleTol = clamp(
    deltaTheta * HIT_ANGLE_TOL_MULT,
    MIN_HIT_ANGLE_TOL,
    MAX_HIT_ANGLE_TOL
  );

  ensureHitStateSize();
  ensureWobblePhaseSize();
  const wobbleOmega = TWO_PI * Math.max(state.wobbleFreqHz, 0);
  const noiseRatio = 0.15;
  const jitterFactor = clamp(Number(state.timingJitter) || 0, 0, 1);

  for (let s = 0; s < substeps; s++) {
    simTime += dtSub;
    const baseAngle = radPerSec * simTime;
    const revIndex = Math.floor(baseAngle / TWO_PI);

    for (let b = 0; b < state.bladeCount; b++) {
      const angle =
        (baseAngle + (TWO_PI * b) / state.bladeCount) % TWO_PI;
      const phase = wobblePhasePerBlade[b] ?? 0;
      const deterministicWobble =
        state.axisJitter *
        Math.sin(wobbleOmega * simTime + phase);
      const noise =
        state.axisJitter *
        noiseRatio *
        jitterFactor *
        (Math.random() * 2 - 1);
      const wobble = deterministicWobble + noise;

      for (let o = 0; o < obstacles.length; o += 1) {
        const obs = obstacles[o];
        const wobbleAdjustedAngle = angle + wobble;
        const angleDiff = smallestAngleDiff(wobbleAdjustedAngle, obs.angle);
        const diff = angleDiff;
        const inZone = diff > 0 && diff <= hitAngleTol;
        const rawStrength = inZone
          ? clamp(1 - diff / hitAngleTol, 0, 1)
          : 0;
        const prev = wasInHitZone[b]?.[o] ?? false;

        if (!prev && inZone) {
          if (!lastHitRev[b]) {
            lastHitRev[b] = new Array(obstacles.length).fill(-Infinity);
          }
          const lastRev = lastHitRev[b][o] ?? -Infinity;
          if (revIndex > lastRev) {
            registerCollision(rawStrength, obs, b, o, {
              diff,
              hitAngleTol,
              deltaTheta,
            });
            lastHitRev[b][o] = revIndex;
          }
        }

        if (!wasInHitZone[b]) {
          wasInHitZone[b] = new Array(obstacles.length).fill(false);
        }
        wasInHitZone[b][o] = inZone;
      }
    }
  }
}

function registerCollision(rawStrength, obstacle, bladeIndex, obstacleIndex, hitContext = {}) {
  const minStrength = 0.01;
  if (rawStrength < minStrength) return;
  const threshold = clamp(Number(state.hitThreshold) || 0, 0, 1);
  if (rawStrength < threshold) {
    return;
  }
  if (obstacle && obstacle.enabled === false) {
    return;
  }
  const denom = 1 - threshold;
  let normStrength;
  if (denom <= 1e-5) {
    normStrength = 1;
  } else {
    normStrength = (rawStrength - threshold) / denom;
  }
  const strength = clamp(normStrength, 0, 1);
  const impact = getImpactStrength(strength);
  hitCount += 1;
  const nowMs = performance.now();
  if (nowMs - lastHitRateLogTime > 1000) {
    console.log("[hitRate]", {
      threshold: threshold.toFixed(3),
      hitsLastSecond: hitCount,
    });
    hitCount = 0;
    lastHitRateLogTime = nowMs;
  }
  console.log("[dynamics] hit", {
    rawStrength,
    normStrength: strength,
    impactStrength: impact,
    impactDynamics: state.impactDynamics,
    threshold,
    hitAngleTol: hitContext.hitAngleTol,
    deltaTheta: hitContext.deltaTheta,
    diff: hitContext.diff,
  });
  if (!audioContext || !state.running) return;

  if (
    COLLISION_COOLDOWN > 0 &&
    simTime - lastCollisionSimTime < COLLISION_COOLDOWN
  ) {
    return;
  }
  lastCollisionSimTime = simTime;

  playClick({
    rawStrength,
    strength,
    obstacle,
    obstacleIndex,
    bladeIndex,
  });
  console.log("[collision]", {
    t: simTime.toFixed(3),
    rawStrength: rawStrength.toFixed(3),
    threshold: threshold.toFixed(3),
    normStrength: strength.toFixed(3),
    impactStrength: impact.toFixed(3),
    blade: bladeIndex ?? "?",
    obstacle: obstacleIndex ?? "?",
    sample: obstacle?.sampleIndex ?? 0,
  });
}

function playClick({ rawStrength, strength, obstacle, obstacleIndex, bladeIndex }) {
  const ctx = audioContext;
  if (!ctx || !masterGain) return;

  const now = ctx.currentTime;

  const buffer = getSampleBufferForObstacle(obstacle);
  if (buffer) {
    playSampleHit(buffer, {
      rawStrength,
      strength,
      now,
      obstacle,
      obstacleIndex,
    });
  } else {
    playNoiseHit({
      rawStrength,
      strength,
      now,
      obstacle,
      obstacleIndex,
    });
  }
}

function getSampleBufferForObstacle(obstacle) {
  const ref = getObstacleSampleRef(obstacle);
  if (ref.type === "noise") return null;
  if (ref.type === "user") {
    const sample = findUserSampleById(ref.id);
    if (!sample || !sample.buffer) {
      console.warn("[user-samples] missing user sample, using noise fallback", ref.id);
      return null;
    }
    return sample.buffer;
  }
  const index = getBuiltinSampleIndexByRef(ref);
  const fallbackIndex =
    index >= 0
      ? index
      : obstacle && typeof obstacle.sampleIndex === "number"
      ? obstacle.sampleIndex
      : -1;
  if (fallbackIndex < 0 || fallbackIndex >= sampleBuffers.length) {
    return null;
  }
  return sampleBuffers[fallbackIndex] ?? null;
}

function playSampleHit(buffer, { rawStrength, strength, now, obstacle, obstacleIndex }) {
  const ctx = audioContext;
  if (!ctx || !masterGain) return;
  const impact = getImpactStrength(strength);
  const lowCutFactor = getSoftHitLowCutFactor(strength);
  console.log(
    "[tone] sample",
    "rawStrength=" + rawStrength.toFixed(3),
    "strength=" + strength.toFixed(3),
    "impactStrength=" + impact.toFixed(3),
    "lowCutFactor=" + lowCutFactor.toFixed(3)
  );
  if (state.voiceMode === "mono" && obstacleIndex != null && obstacleIndex >= 0) {
    stopActiveVoice(activeVoices.sample, obstacleIndex, "sample");
  }
  console.log("[audio] playSampleHit", {
    mode: state.voiceMode,
    obstacleIndex,
    strength,
  });
  console.log("[dynamics] hit(sample)", {
    rawStrength,
    impactStrength: impact,
    impactDynamics: state.impactDynamics,
  });
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const gain = ctx.createGain();
  const baseGain = 0.3;
  const maxGain = 1.0;
  const obstacleVolume =
    obstacle && typeof obstacle.volume === "number" ? obstacle.volume : 1;
  let targetGain = baseGain + impact * (maxGain - baseGain);
  targetGain *= obstacleVolume;
  targetGain = clamp(targetGain, 0, maxGain * 1.5);
  const strengthNorm = clamp(impact, 0, 1);
  const baseDuration = getTailSeconds();
  const duration = baseDuration * (0.8 + 0.4 * strengthNorm);

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  const baseHp = 20;
  const maxHp = 1400;
  hp.frequency.value = baseHp + (maxHp - baseHp) * lowCutFactor;
  hp.Q.value = 0.707;

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(targetGain, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  src.connect(hp).connect(gain).connect(masterGain);

  src.start(now);
  src.stop(now + duration + 0.1);
  if (state.voiceMode === "mono" && obstacleIndex != null && obstacleIndex >= 0) {
    activeVoices.sample[obstacleIndex] = { source: src, gain };
    src.addEventListener("ended", () => {
      if (activeVoices.sample[obstacleIndex]?.source === src) {
        activeVoices.sample[obstacleIndex] = null;
      }
    });
  }

  console.log(
    `[audio] sample hit idx=${obstacle?.sampleIndex ?? 0} gain=${targetGain.toFixed(
      2
    )}`
  );
}

function playNoiseHit({ rawStrength, strength, now, obstacle, obstacleIndex }) {
  const ctx = audioContext;
  if (!ctx || !noiseBuffer || !masterGain) return;
  const impact = getImpactStrength(strength);
  const lowCutFactor = getSoftHitLowCutFactor(strength);
  console.log(
    "[tone] noise",
    "rawStrength=" + rawStrength.toFixed(3),
    "strength=" + strength.toFixed(3),
    "impactStrength=" + impact.toFixed(3),
    "lowCutFactor=" + lowCutFactor.toFixed(3)
  );
  if (state.voiceMode === "mono" && obstacleIndex != null && obstacleIndex >= 0) {
    stopActiveVoice(activeVoices.noise, obstacleIndex, "noise");
  }
  console.log("[audio] playNoiseHit", {
    mode: state.voiceMode,
    obstacleIndex,
    strength,
  });
  console.log("[dynamics] hit(noise)", {
    rawStrength,
    impactStrength: impact,
    impactDynamics: state.impactDynamics,
  });
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  const baseHp = 40;
  const maxHp = 1600;
  hp.frequency.value = baseHp + (maxHp - baseHp) * lowCutFactor;
  hp.Q.value = 0.707;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  const bandBase = 1800 + strength * 2200;
  filter.frequency.value = bandBase + lowCutFactor * 1200;
  filter.Q.value = 1.4;

  const gain = ctx.createGain();
  const maxGain = 0.6;
  const g = Math.min(maxGain, 0.12 + impact * 0.6);
  const strengthNorm = clamp(impact, 0, 1);
  const baseDuration = getTailSeconds();
  const duration = baseDuration * (0.6 + 0.3 * strengthNorm);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(g, now + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  src.connect(hp).connect(filter).connect(gain).connect(masterGain);
  src.start(now);
  src.stop(now + duration + 0.05);
  if (state.voiceMode === "mono" && obstacleIndex >= 0) {
    activeVoices.noise[obstacleIndex] = { source: src, gain };
    src.addEventListener("ended", () => {
      if (activeVoices.noise[obstacleIndex]?.source === src) {
        activeVoices.noise[obstacleIndex] = null;
      }
    });
  }

  console.log("[audio] noise fallback hit");
}

function stopActiveVoice(store, index, kind = "sample") {
  const voice = store[index];
  if (!voice) return;
  console.log("[audio] stopActiveVoice", {
    mode: state.voiceMode,
    obstacleIndex: index,
    kind,
  });
  try {
    const ctx = audioContext;
    if (ctx && voice.gain) {
      const now = ctx.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
    }
    if (voice.source) {
      voice.source.stop(audioContext ? audioContext.currentTime + 0.03 : 0);
    }
  } catch (err) {
    console.warn("[audio] error stopping voice", err);
  }
  store[index] = null;
}

function getSoftHitLowCutFactor(strength = 0) {
  const bias = clamp(Number(state.softHitLowCut) || 0, 0, 1);
  const strength01 = clamp(Number(strength) || 0, 0, 1);
  const softness = 1 - strength01;
  return bias * softness;
}

function getImpactStrength(rawStrength = 0) {
  const dyn = clamp(Number(state.impactDynamics) || 0, 0, 1);
  const r = clamp(Number(rawStrength) || 0, 0, 1);
  return 1 - dyn * (1 - r);
}

// ===== Start / Stop ボタン =====

const toggleButton = document.getElementById("toggleButton");
if (!toggleButton) {
  console.error("Start/Stop button element not found");
}

async function startSimulation() {
  if (state.running) return;
  try {
    await ensureAudio();
  } catch (err) {
    alert("Audio を初期化できませんでした。コンソールを確認してください。");
    return;
  }
  if (!audioContext) return;

  await audioContext.resume();
  state.running = true;
  lastTimestamp = null;
  if (toggleButton) {
    toggleButton.textContent = "Stop";
  }
  console.log("Simulation started");
  requestAnimationFrame(loop);
}

async function stopSimulation() {
  if (!state.running) return;
  if (isRecording) {
    await stopRecordingAndDownload("simulation-stop");
  }
  state.running = false;
  if (toggleButton) {
    toggleButton.textContent = "Start";
  }
  if (audioContext) {
    audioContext.suspend();
  }
  console.log("Simulation stopped");
}

if (toggleButton) {
  toggleButton.addEventListener("click", () => {
    if (state.running) {
      stopSimulation().catch((err) =>
        console.error("stopSimulation error", err)
      );
    } else {
      startSimulation().catch((err) =>
        console.error("startSimulation error", err)
      );
    }
  });
}

function loop(timestamp) {
  if (!state.running) return;

  if (lastTimestamp == null) {
    lastTimestamp = timestamp;
    requestAnimationFrame(loop);
    return;
  }

  const dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  stepSimulation(dt);
  requestAnimationFrame(loop);
}
