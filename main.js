/* Fix note: loading main.js as a module via file:// prevented it from running at all, so the script now loads via a deferred classic tag; logging hooks were left in place to make slider/input activity easy to trace. */
const TWO_PI = Math.PI * 2;
const HIT_ANGLE_TOL = 0.25; // radians, angular tolerance for raw hit strength

/*
 * DEBUG DUMP: collision/audio pipeline as of 2024-05-26
 *
 * rawStrength source (stepSimulation inner loop):
 *   - angleDiff = smallestAngleDiff(bladeAngleWithWobble, obstacle.angle)
 *   - rawStrength = clamp(1 - Math.abs(angleDiff) / HIT_ANGLE_TOL, 0, 1)
 *   - registerCollision(rawStrength, obstacle, bladeIndex, obstacleIndex) when rawStrength > 0 and we enter zone.
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
const MAX_PRESETS = 10;
const PRESET_STORAGE_KEY = "ventBeatSimVol2.presets";
const presets = new Array(MAX_PRESETS).fill(null);
const presetSummaryEls = [];
let sampleBuffers = [];
let sampleMetas = [];
const activeVoices = {
  sample: [],
  noise: [],
};

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
  const metaCount = Array.isArray(sampleMetas) ? sampleMetas.length : 0;
  const count =
    metaCount > 0
      ? metaCount
      : Array.isArray(sampleBuffers)
      ? sampleBuffers.length
      : 0;
  if (count === 0) {
    return [{ value: -1, label: "Noise" }];
  }
  const options = [];
  for (let i = 0; i < count; i += 1) {
    const meta = sampleMetas[i];
    const baseLabel = meta && meta.label ? meta.label : `Sample ${i + 1}`;
    options.push({ value: i, label: `${i + 1}: ${baseLabel}` });
  }
  options.push({ value: -1, label: "Noise" });
  return options;
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
    enabled: obs.enabled !== false,
  }));
  obstacles = [];
  const count = Math.max(0, state.obstacleCount | 0);
  const availableSamples =
    (Array.isArray(sampleBuffers) && sampleBuffers.length > 0
      ? sampleBuffers.length
      : 0) ||
    (Array.isArray(sampleMetas) && sampleMetas.length > 0
      ? sampleMetas.length
      : 0);
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

// 初回の障害物生成
rebuildObstacles();
attachStepButtons();
initPresetControls();
initWobbleModeControl();
initVoiceModeSelector();
initObstaclePositionControls();

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
      obstacle.enabled = obstacle.enabled === false;
      updateToggle();
      renderObstacleAngleControls();
    });

    const select = document.createElement("select");
    sampleOptions.forEach((option) => {
      const opt = document.createElement("option");
      opt.value = `${option.value}`;
      opt.textContent = option.label;
      select.appendChild(opt);
    });
    const currentSample =
      typeof obstacle.sampleIndex === "number" ? obstacle.sampleIndex : 0;
    select.value = `${currentSample}`;
    select.addEventListener("change", () => {
      const parsed = Number.parseInt(select.value, 10);
      if (Number.isNaN(parsed)) return;
      obstacle.sampleIndex = parsed;
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

function initWobbleModeControl() {
  const select = document.getElementById("wobbleMode");
  if (!select) return;
  const initialMode = state.wobbleMode === "chaotic" ? "chaotic" : "locked";
  select.value = initialMode;
  select.addEventListener("change", (event) => {
    setWobbleMode(event.target.value);
  });
  setWobbleMode(initialMode);
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
  const count = enabled.length;
  if (count <= 0) return;
  const step = TWO_PI / count;
  let idx = 0;
  for (let i = 0; i < obstacles.length; i += 1) {
    const obs = obstacles[i];
    if (!obs || obs.enabled === false) continue;
    obs.angle = idx * step;
    idx += 1;
  }
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
    wobbleMode: state.wobbleMode,
    timingJitter: state.timingJitter,
    softHitLowCut: state.softHitLowCut,
    impactDynamics: state.impactDynamics,
    obstacleVolumes: obstacles.map((obs) => obs.volume ?? 1),
    obstacleSampleIndices: obstacles.map(
      (obs) =>
        (typeof obs.sampleIndex === "number" ? obs.sampleIndex : 0)
    ),
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
  setWobbleMode(preset.wobbleMode || "locked");
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
  applyObstacleSamples(preset.obstacleSampleIndices || []);
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

// ===== Web Audio の準備 =====

let audioContext = null;
let masterGain = null;
let noiseBuffer = null;
let audioReadyPromise = null;

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
    masterGain.connect(audioContext.destination);
    noiseBuffer = createNoiseBuffer(audioContext);
    sampleBuffers = await loadSampleBuffers(audioContext);
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
    const response = await fetch("samples/manifest.json", {
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
    const url = `samples/${entry.file}`;
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

  const omega = (state.rpm / 60) * TWO_PI;
  if (omega <= 0) return;

  const substeps = 4;
  const h = dt / substeps;

  ensureHitStateSize();
  ensureWobblePhaseSize();
  const wobbleOmega = TWO_PI * Math.max(state.wobbleFreqHz, 0);
  const noiseRatio = 0.15;
  const jitterFactor = clamp(Number(state.timingJitter) || 0, 0, 1);

  for (let s = 0; s < substeps; s++) {
    simTime += h;
    const baseAngle = omega * simTime;
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
        const effective = Math.abs(angleDiff);
        const rawStrength = clamp(1 - effective / HIT_ANGLE_TOL, 0, 1);
        const inZone = rawStrength > 0;
        const prev = wasInHitZone[b]?.[o] ?? false;

        if (!prev && inZone) {
          if (!lastHitRev[b]) {
            lastHitRev[b] = new Array(obstacles.length).fill(-Infinity);
          }
          const lastRev = lastHitRev[b][o] ?? -Infinity;
          if (revIndex > lastRev) {
            registerCollision(rawStrength, obs, b, o);
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

function registerCollision(rawStrength, obstacle, bladeIndex, obstacleIndex) {
  const minStrength = 0.01;
  if (rawStrength < minStrength) return;
  const threshold = clamp(Number(state.hitThreshold) || 0, 0, 1);
  if (rawStrength < threshold) {
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
  if (!sampleBuffers.length) return null;
  const raw =
    obstacle && typeof obstacle.sampleIndex === "number"
      ? obstacle.sampleIndex
      : 0;
  if (raw < 0 || raw >= sampleBuffers.length) {
    return null;
  }
  return sampleBuffers[raw] ?? null;
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

function stopSimulation() {
  if (!state.running) return;
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
      stopSimulation();
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
