/**
 * app.js  —  CBA Biometric Gaming Arena
 * Combines:
 *  1. Dynamic Target Challenge (45s continuous 3-phase mouse reflex game)
 *  2. Speed Typer Arena (interactive keystroke dynamics game)
 *  3. Cyber Scroll Runner (rhythm, scroll velocity & click intervals)
 *  4. CBA SDK passive behavioral monitoring, live risk gauge, and enrollment polling
 */

const API = "http://localhost:8080/api/v1";

// ─── GLOBAL APPLICATION STATE ────────────────────────────────
let jwt       = null;
let sessionId = null;
let sdk       = null;
let enrollmentTimer = null;

// Telemetry tracker for live chip calculation
const _tel = {
  keyHold: [], flight: [], lastKeyDown: null, lastKeyUp: null,
  vel: [], lastMouseT: null, lastMouseX: null, lastMouseY: null,
  clickIntervals: [], lastClickT: null,
  scrollSpeeds: [], lastScrollT: null, lastScrollX: null, lastScrollY: null,
  idleGaps: [], lastEventT: null,
  keyEvents: 0, mouseEvents: 0, scrollEvents: 0
};

// ─── AUDIO SYNTHESIS ENGINE (Web Audio API) ──────────────────
let audioCtx = null;
let dtcSoundEnabled = true;

function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
}

function playTone(freq, type="sine", duration=0.08, rampTo=null) {
  if (!dtcSoundEnabled) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (rampTo) {
      osc.frequency.exponentialRampToValueAtTime(rampTo, audioCtx.currentTime + duration);
    }
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch(_) {}
}

function playSound(name) {
  if (name === "hit") {
    playTone(520, "sine", 0.08, 880);
  } else if (name === "miss") {
    playTone(180, "sawtooth", 0.12, 120);
  } else if (name === "phase") {
    playTone(440, "sine", 0.1);
    setTimeout(() => playTone(660, "sine", 0.1), 100);
    setTimeout(() => playTone(880, "sine", 0.15), 200);
  } else if (name === "victory") {
    playTone(523, "triangle", 0.1);
    setTimeout(() => playTone(659, "triangle", 0.1), 120);
    setTimeout(() => playTone(784, "triangle", 0.1), 240);
    setTimeout(() => playTone(1046, "triangle", 0.25), 360);
  }
}

function toggleDtcSound() {
  dtcSoundEnabled = !dtcSoundEnabled;
  const btn = document.getElementById("dtc-sound-btn");
  if (btn) btn.textContent = dtcSoundEnabled ? "🔊" : "🔇";
}

// ─── UTILITY HELPERS ─────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length);
}
function fmt(v, unit="ms") {
  if (!isFinite(v) || v === 0) return "—";
  return v.toFixed(1) + unit;
}
function now() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

// ─── LOGGING ─────────────────────────────────────────────────
function log(msg, type="info") {
  const box = document.getElementById("activity-log");
  if (!box) return;
  const el = document.createElement("div");
  el.className = `log-entry ${type}`;
  el.innerHTML = `<span class="log-time">[${now()}]</span> ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function clearLog() {
  const box = document.getElementById("activity-log");
  if (box) box.innerHTML = "";
}

// ─── ARENA GAME TAB SWITCHER ─────────────────────────────────
function switchArenaGame(gameId) {
  const tabs = {
    mouse:     { tab: "tab-game-mouse",     view: "view-game-mouse" },
    typing:    { tab: "tab-game-typing",    view: "view-game-typing" },
    scroll:    { tab: "tab-game-scroll",    view: "view-game-scroll" },
    telemetry: { tab: "tab-game-telemetry", view: "view-game-telemetry" }
  };

  Object.entries(tabs).forEach(([key, config]) => {
    const tabEl  = document.getElementById(config.tab);
    const viewEl = document.getElementById(config.view);
    if (tabEl)  tabEl.classList.toggle("active", key === gameId);
    if (viewEl) viewEl.classList.toggle("hidden", key !== gameId);
  });

  if (gameId === "typing") {
    setTimeout(focusTyperInput, 100);
  }
}

// ─── AUTH TAB SWITCH ─────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("register-error").classList.add("hidden");
}

// ─── REGISTRATION & LOGIN ───────────────────────────────────
async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById("register-btn");
  setLoading(btn, true);
  clearError("register-error");
  const body = {
    username: document.getElementById("reg-username").value.trim(),
    email:    document.getElementById("reg-email").value.trim(),
    password: document.getElementById("reg-password").value
  };
  try {
    const res = await fetch(`${API}/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Registration failed");
    jwt = data.token;
    onLoginSuccess(body.username);
  } catch(err) {
    showError("register-error", err.message);
  } finally { setLoading(btn, false); }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  setLoading(btn, true);
  clearError("login-error");
  const body = {
    username: document.getElementById("login-username").value.trim(),
    password: document.getElementById("login-password").value
  };
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Login failed");
    jwt = data.token;
    onLoginSuccess(body.username);
  } catch(err) {
    showError("login-error", err.message);
  } finally { setLoading(btn, false); }
}

async function onLoginSuccess(username) {
  document.getElementById("nav-username").textContent = username;
  document.getElementById("auth-overlay").classList.remove("active");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("session-badge").textContent = "Starting session…";

  log(`✅ Signed in as <strong>${username}</strong>`, "success");

  // Enable buttons
  const flushBtn = document.getElementById("flush-btn");
  const refEnrBtn = document.getElementById("refresh-enrollment-btn");
  const refRiskBtn = document.getElementById("refresh-risk-btn");
  if (flushBtn) flushBtn.disabled = false;
  if (refEnrBtn) refEnrBtn.disabled = false;
  if (refRiskBtn) refRiskBtn.disabled = false;

  await startSession();
}

// ─── SESSION START ───────────────────────────────────────────
async function startSession() {
  try {
    const res = await fetch(`${API}/session/start`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + jwt }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Could not start session");
    sessionId = data.sessionId;

    document.getElementById("info-session-id").textContent = sessionId;
    document.getElementById("session-badge").textContent   = "Session Active";
    document.getElementById("session-badge").classList.add("active");
    document.getElementById("pulse-dot").classList.add("active");

    log(`🚀 Session started — ID: <strong>${sessionId}</strong>`, "success");
    initSDK();
    startEnrollmentPolling();
  } catch(err) {
    document.getElementById("session-badge").textContent = "Session Error";
    log(`❌ Session start failed: ${err.message}`, "error");
  }
}

// ─── SDK INITIALIZATION ──────────────────────────────────────
function initSDK() {
  sdk = new window.CBASDK();
  sdk.init({
    token:     jwt,
    apiKey:    "",
    sessionId: sessionId,
    baseUrl:   API,
    onRiskDecision: handleRiskDecision
  });

  log("🧠 CBA SDK active — background telemetry streaming enabled", "info");

  setInterval(updateSDKStats, 1000);
  attachLocalTelemetry();
}

// ─── RISK DECISION HANDLER & GAUGE ───────────────────────────
function handleRiskDecision(data) {
  const score = data.riskScore ?? 0;
  const level = (data.riskLevel || "WAITING").toUpperCase();
  const status= data.status || "OK";

  updateGauge(score, level);
  document.getElementById("risk-score-val").textContent = score.toFixed(1);
  document.getElementById("risk-level-badge").textContent = level;
  document.getElementById("risk-level-badge").dataset.level = level;
  document.getElementById("risk-status").textContent = `Status: ${status}`;
  document.getElementById("last-decision-json").textContent = JSON.stringify(data, null, 2);
  document.getElementById("info-batches").textContent = sdk ? sdk.batchesSent : 0;

  const type = level === "CRITICAL" ? "critical" : level === "HIGH" ? "warn" : "success";
  log(`📊 Live Risk: <strong>${score.toFixed(1)}</strong> &bull; Level: <strong>${level}</strong> &bull; Status: ${status}`, type);
}

function updateGauge(score, level) {
  const arc    = document.getElementById("gauge-arc");
  const needle = document.getElementById("gauge-needle");
  const stop1  = document.getElementById("arc-stop1");
  const stop2  = document.getElementById("arc-stop2");

  const pct    = Math.min(score, 100) / 100;
  const offset = 251.2 * (1 - pct);
  if (arc) arc.style.strokeDashoffset = offset;

  const angle = -90 + pct * 180;
  if (needle) needle.style.transform = `rotate(${angle}deg)`;

  const colors = {
    LOW:      ["#10b981", "#34d399"],
    MEDIUM:   ["#f59e0b", "#fbbf24"],
    HIGH:     ["#ef4444", "#f87171"],
    CRITICAL: ["#dc2626", "#ef4444"],
    WAITING:  ["#6366f1", "#8b5cf6"]
  };
  const [c1, c2] = colors[level] || colors.WAITING;
  if (stop1) stop1.setAttribute("stop-color", c1);
  if (stop2) stop2.setAttribute("stop-color", c2);
}

// ─── ENROLLMENT POLLING ──────────────────────────────────────
function startEnrollmentPolling() {
  refreshEnrollment();
  enrollmentTimer = setInterval(refreshEnrollment, 8000);
}

async function refreshEnrollment() {
  if (!jwt) return;
  try {
    const res  = await fetch(`${API}/enrollment/status`, {
      headers: { "Authorization": "Bearer " + jwt }
    });
    const data = await res.json();
    if (!res.ok) return;

    const pct   = Math.min(data.progressPercent ?? 0, 100);
    const state = data.enrollmentState || "NOT_STARTED";
    const count = data.interactionCount ?? 0;

    document.getElementById("enrollment-bar").style.width = pct + "%";
    document.getElementById("enrollment-count").textContent = count.toLocaleString();
    document.getElementById("enrollment-pct").textContent   = pct.toFixed(1) + "% enrolled";

    const tag = document.getElementById("enrollment-state-tag");
    tag.textContent   = state;
    tag.dataset.state = state;
  } catch(_) {}
}

async function refreshRisk() {
  if (!jwt || !sessionId) return;
  try {
    const res  = await fetch(`${API}/risk/decision/${sessionId}`, {
      headers: { "Authorization": "Bearer " + jwt }
    });
    const data = await res.json();
    if (res.ok) handleRiskDecision(data);
  } catch(_) {}
}

function updateSDKStats() {
  if (!sdk) return;
  document.getElementById("info-window").textContent   = sdk.windowNumber;
  document.getElementById("info-batches").textContent  = sdk.batchesSent;
  document.getElementById("info-buffered").textContent = sdk.bufferedCount;
}

function manualFlush() {
  if (!sdk) return;
  log("⚡ Manual telemetry flush executed", "info");
  sdk.flush();
}

// ─── LOCAL TELEMETRY EVENT LISTENERS ─────────────────────────
function attachLocalTelemetry() {
  window.addEventListener("keydown", e => {
    _tel.keyEvents++;
    const el = document.getElementById("key-counter");
    if (el) el.textContent = _tel.keyEvents + " events";
    const t = Date.now();
    if (_tel.lastKeyUp !== null) _tel.flight.push(t - _tel.lastKeyUp);
    _tel.lastKeyDown = t;
    updateIdleGap(t);
    updateKeyChips();
  }, { passive: true });

  window.addEventListener("keyup", e => {
    const t = Date.now();
    if (_tel.lastKeyDown !== null) _tel.keyHold.push(t - _tel.lastKeyDown);
    _tel.lastKeyUp = t;
    updateIdleGap(t);
    updateKeyChips();
  }, { passive: true });

  window.addEventListener("mousemove", e => {
    _tel.mouseEvents++;
    const cnt = document.getElementById("mouse-counter");
    if (cnt) cnt.textContent = _tel.mouseEvents + " events";
    const cur = document.getElementById("cursor-pos");
    if (cur) cur.textContent = `x: ${e.clientX}  y: ${e.clientY}`;

    const t = Date.now();
    if (_tel.lastMouseT && _tel.lastMouseX !== null) {
      const dx = e.clientX - _tel.lastMouseX;
      const dy = e.clientY - _tel.lastMouseY;
      const dt = t - _tel.lastMouseT;
      if (dt > 0) _tel.vel.push(Math.sqrt(dx * dx + dy * dy) / dt);
    }
    _tel.lastMouseT = t; _tel.lastMouseX = e.clientX; _tel.lastMouseY = e.clientY;
    updateIdleGap(t);
    updateMouseChips();
  }, { passive: true });

  window.addEventListener("scroll", () => {
    _tel.scrollEvents++;
    const el = document.getElementById("scroll-counter");
    if (el) el.textContent = _tel.scrollEvents + " events";
    const t  = Date.now();
    const sx = window.scrollX, sy = window.scrollY;
    if (_tel.lastScrollT && _tel.lastScrollX !== null) {
      const dx = sx - _tel.lastScrollX, dy = sy - _tel.lastScrollY;
      const dt = t - _tel.lastScrollT;
      if (dt > 0) _tel.scrollSpeeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
    }
    _tel.lastScrollT = t; _tel.lastScrollX = sx; _tel.lastScrollY = sy;
    updateIdleGap(t);
    updateScrollChips();
  }, { passive: true });

  window.addEventListener("mousedown", e => {
    const t = Date.now();
    if (_tel.lastClickT) _tel.clickIntervals.push(t - _tel.lastClickT);
    _tel.lastClickT = t;
    updateIdleGap(t);
    updateScrollChips();
  }, { passive: true });
}

function updateIdleGap(t) {
  if (_tel.lastEventT) _tel.idleGaps.push(t - _tel.lastEventT);
  _tel.lastEventT = t;
}

function updateKeyChips() {
  const h = document.getElementById("feat-hold");
  const hs = document.getElementById("feat-hold-std");
  const f = document.getElementById("feat-flight");
  const fs = document.getElementById("feat-flight-std");
  if (h)  h.textContent  = fmt(mean(_tel.keyHold));
  if (hs) hs.textContent = fmt(stdDev(_tel.keyHold));
  if (f)  f.textContent  = fmt(mean(_tel.flight));
  if (fs) fs.textContent = fmt(stdDev(_tel.flight));
}

function updateMouseChips() {
  const v = document.getElementById("feat-vel");
  const vs = document.getElementById("feat-vel-std");
  const a = document.getElementById("feat-accel");
  if (v)  v.textContent  = fmt(mean(_tel.vel), " px/ms");
  if (vs) vs.textContent = fmt(stdDev(_tel.vel), " px/ms");
  const accels = _tel.vel.slice(1).map((vi, i) => vi - _tel.vel[i]);
  if (a)  a.textContent  = fmt(mean(accels), " px/ms²");
}

function updateScrollChips() {
  const c = document.getElementById("feat-click");
  const s = document.getElementById("feat-scroll");
  const i = document.getElementById("feat-idle");
  if (c) c.textContent = fmt(mean(_tel.clickIntervals));
  if (s) s.textContent = fmt(mean(_tel.scrollSpeeds), " px/ms");
  if (i) i.textContent = fmt(mean(_tel.idleGaps));
}


// =========================================================================
// GAME 1: DYNAMIC TARGET CHALLENGE (MOUSE BEHAVIOUR ARENA)
// Continuous 45s game across 3 dynamic phases
// =========================================================================
const DTC_CONFIG = {
  totalDuration: 45, // seconds
  p1Duration: 15,    // 0-15s: Single Target
  p2Duration: 15,    // 15-30s: Shape Selection
  p3Duration: 15     // 30-45s: Speed Rush
};

let dtcRunning = false;
let dtcTimeLeft = DTC_CONFIG.totalDuration;
let dtcInterval = null;
let dtcScore = 0;
let dtcHits = 0;
let dtcMisses = 0;
let dtcCurrentPhase = 1;
let dtcLastTargetPos = null;
let dtcTargetTimer = null;
let dtcExpectedShape = null;

function startDtcGame() {
  initAudio();
  resetDtcGame();

  dtcRunning = true;
  dtcTimeLeft = DTC_CONFIG.totalDuration;
  document.getElementById("dtc-start-overlay").classList.add("hidden");
  document.getElementById("dtc-end-overlay").classList.add("hidden");

  setDtcPhase(1);
  spawnDtcTargets();

  dtcInterval = setInterval(dtcTick, 1000);
  log("🎯 Dynamic Target Challenge started — Phase 1: Single Target", "info");
}

function resetDtcGame() {
  dtcRunning = false;
  if (dtcInterval) clearInterval(dtcInterval);
  if (dtcTargetTimer) clearTimeout(dtcTargetTimer);

  dtcTimeLeft = DTC_CONFIG.totalDuration;
  dtcScore = 0;
  dtcHits = 0;
  dtcMisses = 0;
  dtcCurrentPhase = 1;
  dtcLastTargetPos = null;

  updateDtcHud();
  clearDtcBoard();

  const startOverlay = document.getElementById("dtc-start-overlay");
  const endOverlay = document.getElementById("dtc-end-overlay");
  if (startOverlay) startOverlay.classList.remove("hidden");
  if (endOverlay) endOverlay.classList.add("hidden");

  const instr = document.getElementById("dtc-instruction-text");
  if (instr) instr.textContent = "CLICK START CHALLENGE TO BEGIN";
}

function dtcTick() {
  if (!dtcRunning) return;
  dtcTimeLeft--;

  const elapsed = DTC_CONFIG.totalDuration - dtcTimeLeft;
  const progressPct = (elapsed / DTC_CONFIG.totalDuration) * 100;
  const fill = document.getElementById("dtc-progress-fill");
  if (fill) fill.style.width = Math.min(progressPct, 100) + "%";

  // Check phase transitions
  if (dtcTimeLeft <= 15 && dtcCurrentPhase < 3) {
    setDtcPhase(3);
  } else if (dtcTimeLeft <= 30 && dtcTimeLeft > 15 && dtcCurrentPhase < 2) {
    setDtcPhase(2);
  }

  updateDtcHud();

  if (dtcTimeLeft <= 0) {
    endDtcGame();
  }
}

function setDtcPhase(phaseNum) {
  dtcCurrentPhase = phaseNum;
  playSound("phase");

  const titles = {
    1: "Phase 1 of 3: Single Target Calibration",
    2: "Phase 2 of 3: Shape & Color Selection",
    3: "Phase 3 of 3: Speed & Precision Rush"
  };
  const flashTexts = {
    1: "PHASE 1: SINGLE TARGET CALIBRATION",
    2: "⚡ PHASE 2: SHAPE & COLOR SELECTION",
    3: "🔥 PHASE 3: SPEED & PRECISION RUSH"
  };

  const titleEl = document.getElementById("dtc-phase-title");
  if (titleEl) titleEl.textContent = titles[phaseNum];

  // Update phase markers
  ["marker-p1", "marker-p2", "marker-p3"].forEach((id, idx) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", idx + 1 === phaseNum);
  });

  // Flash banner
  const banner = document.getElementById("dtc-phase-flash");
  const textEl = document.getElementById("dtc-flash-text");
  if (banner && textEl) {
    textEl.textContent = flashTexts[phaseNum];
    banner.classList.remove("hidden");
    banner.style.animation = "none";
    void banner.offsetWidth;
    banner.style.animation = "flashIn 1.4s ease forwards";
  }

  clearDtcBoard();
  spawnDtcTargets();
  log(`⚡ ${flashTexts[phaseNum]} initiated`, "info");
}

function updateDtcHud() {
  const min = Math.floor(dtcTimeLeft / 60);
  const sec = dtcTimeLeft % 60;
  const timeStr = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;

  const timeEl = document.getElementById("dtc-time");
  const scoreEl = document.getElementById("dtc-score");
  const hitsEl = document.getElementById("dtc-hits");
  const accEl = document.getElementById("dtc-acc");

  if (timeEl) timeEl.textContent = timeStr;
  if (scoreEl) scoreEl.textContent = dtcScore;
  if (hitsEl) hitsEl.textContent = dtcHits;

  const totalAttempts = dtcHits + dtcMisses;
  const acc = totalAttempts > 0 ? Math.round((dtcHits / totalAttempts) * 100) : 100;
  if (accEl) accEl.textContent = acc + "%";
}

function clearDtcBoard() {
  if (dtcTargetTimer) clearTimeout(dtcTargetTimer);
  const board = document.getElementById("dtc-board");
  if (!board) return;
  const targets = board.querySelectorAll(".dtc-target, .dtc-score-popup");
  targets.forEach(t => t.remove());
}

function getRandomBoardPos(targetSize=42) {
  const board = document.getElementById("dtc-board");
  const rect = board.getBoundingClientRect();
  const padding = 36;
  const maxX = Math.max(rect.width - targetSize - padding, 20);
  const maxY = Math.max(rect.height - targetSize - padding, 20);

  let attempts = 0;
  let x = padding + Math.random() * (maxX - padding);
  let y = padding + Math.random() * (maxY - padding);

  // Ensure minimum distance from last position to force diverse trajectories
  if (dtcLastTargetPos) {
    while (attempts < 10) {
      const dx = x - dtcLastTargetPos.x;
      const dy = y - dtcLastTargetPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 140) break;
      x = padding + Math.random() * (maxX - padding);
      y = padding + Math.random() * (maxY - padding);
      attempts++;
    }
  }
  dtcLastTargetPos = { x, y };
  return { x, y };
}

function spawnDtcTargets() {
  if (!dtcRunning) return;
  clearDtcBoard();

  const board = document.getElementById("dtc-board");
  const instr = document.getElementById("dtc-instruction-text");

  // PHASE 1: Single Target (0-15s)
  if (dtcCurrentPhase === 1) {
    if (instr) instr.textContent = "CLICK THE TARGET TO CALIBRATE VELOCITY";
    const pos = getRandomBoardPos(44);
    const target = createTargetElement({
      shape: "shape-circle",
      color: "color-blue",
      size:  "size-medium",
      x: pos.x, y: pos.y,
      onClick: (e) => {
        handleTargetHit(target, 10, e.clientX, e.clientY);
        spawnDtcTargets();
      }
    });
    board.appendChild(target);
  }

  // PHASE 2: Shape Selection (15-30s)
  else if (dtcCurrentPhase === 2) {
    const shapeTypes = ["circle", "square", "triangle", "diamond"];
    const colorTypes = ["red", "blue", "yellow", "green", "purple"];

    // Pick 3 or 4 distinct shapes
    const numShapes = 3;
    const items = [];
    const usedCombos = new Set();

    while (items.length < numShapes) {
      const s = shapeTypes[Math.floor(Math.random() * shapeTypes.length)];
      const c = colorTypes[Math.floor(Math.random() * colorTypes.length)];
      const key = `${c}-${s}`;
      if (!usedCombos.has(key)) {
        usedCombos.add(key);
        items.push({ shape: s, color: c });
      }
    }

    // Pick one as the requested target
    const targetItem = items[Math.floor(Math.random() * items.length)];
    dtcExpectedShape = targetItem;
    if (instr) {
      instr.innerHTML = `CLICK THE <span style="color:var(--amber);text-transform:uppercase">${targetItem.color} ${targetItem.shape}</span>`;
    }

    // Spawn shapes with spread
    items.forEach(item => {
      const pos = getRandomBoardPos(44);
      const isCorrect = (item.shape === targetItem.shape && item.color === targetItem.color);
      const targetEl = createTargetElement({
        shape: `shape-${item.shape}`,
        color: `color-${item.color}`,
        size:  "size-medium",
        x: pos.x, y: pos.y,
        onClick: (e) => {
          if (isCorrect) {
            handleTargetHit(targetEl, 15, e.clientX, e.clientY);
            spawnDtcTargets();
          } else {
            handleTargetMiss(targetEl, 5, e.clientX, e.clientY);
          }
        }
      });
      board.appendChild(targetEl);
    });
  }

  // PHASE 3: Speed Rush with Disappearing Targets (30-45s)
  else if (dtcCurrentPhase === 3) {
    if (instr) instr.textContent = "⚡ CLICK BEFORE TARGETS VANISH!";
    const sizes = [
      { cls: "size-large",  pts: 10, px: 56 },
      { cls: "size-medium", pts: 15, px: 42 },
      { cls: "size-small",  pts: 25, px: 26 } // High precision small targets
    ];
    const chosenSize = sizes[Math.floor(Math.random() * sizes.length)];
    const colors = ["color-red", "color-yellow", "color-green", "color-purple"];
    const chosenColor = colors[Math.floor(Math.random() * colors.length)];
    const pos = getRandomBoardPos(chosenSize.px);

    const targetEl = createTargetElement({
      shape: "shape-circle",
      color: chosenColor,
      size:  chosenSize.cls,
      x: pos.x, y: pos.y,
      onClick: (e) => {
        if (dtcTargetTimer) clearTimeout(dtcTargetTimer);
        handleTargetHit(targetEl, chosenSize.pts, e.clientX, e.clientY);
        spawnDtcTargets();
      }
    });
    board.appendChild(targetEl);

    // Target disappears after 1.2 to 1.6 seconds!
    const lifespan = 1200 + Math.random() * 400;
    dtcTargetTimer = setTimeout(() => {
      if (dtcRunning && dtcCurrentPhase === 3) {
        targetEl.remove();
        spawnDtcTargets();
      }
    }, lifespan);
  }
}

function createTargetElement({ shape, color, size, x, y, onClick }) {
  const el = document.createElement("div");
  el.className = `dtc-target ${shape} ${color} ${size} spawn-anim`;
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  el.addEventListener("click", onClick);
  return el;
}

function handleTargetHit(targetEl, points, clientX, clientY) {
  dtcScore += points;
  dtcHits++;
  playSound("hit");

  targetEl.classList.remove("spawn-anim");
  targetEl.classList.add("hit-anim");

  showScorePopup(`+${points}`, clientX, clientY, true);
  updateDtcHud();
}

function handleTargetMiss(targetEl, penalty, clientX, clientY) {
  dtcScore = Math.max(0, dtcScore - penalty);
  dtcMisses++;
  playSound("miss");

  targetEl.classList.remove("spawn-anim");
  targetEl.classList.add("miss-anim");
  setTimeout(() => targetEl.classList.remove("miss-anim"), 320);

  showScorePopup(`-${penalty}`, clientX, clientY, false);
  updateDtcHud();
}

function showScorePopup(text, clientX, clientY, isPositive) {
  const board = document.getElementById("dtc-board");
  if (!board) return;
  const rect = board.getBoundingClientRect();
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;

  const popup = document.createElement("div");
  popup.className = `dtc-score-popup ${isPositive ? "positive" : "negative"}`;
  popup.textContent = text;
  popup.style.left = `${relX}px`;
  popup.style.top  = `${relY}px`;
  board.appendChild(popup);

  setTimeout(() => popup.remove(), 700);
}

function endDtcGame() {
  dtcRunning = false;
  if (dtcInterval) clearInterval(dtcInterval);
  if (dtcTargetTimer) clearTimeout(dtcTargetTimer);

  playSound("victory");
  clearDtcBoard();

  const totalAttempts = dtcHits + dtcMisses;
  const acc = totalAttempts > 0 ? Math.round((dtcHits / totalAttempts) * 100) : 100;

  document.getElementById("sum-score").textContent  = dtcScore;
  document.getElementById("sum-hits").textContent   = `${dtcHits} / ${totalAttempts}`;
  document.getElementById("sum-acc").textContent    = `${acc}%`;
  document.getElementById("sum-events").textContent = _tel.mouseEvents;

  document.getElementById("dtc-end-overlay").classList.remove("hidden");

  // Force SDK flush so telemetry evaluates in Spring Boot immediately
  if (sdk) {
    sdk.flush();
    log(`🏆 Dynamic Target Challenge completed! Final Score: <strong>${dtcScore}</strong> &bull; Hits: <strong>${dtcHits}</strong> &bull; Accuracy: <strong>${acc}%</strong>`, "success");
  }
}


// =========================================================================
// GAME 2: SPEED TYPER ARENA (KEYSTROKE DYNAMICS)
// =========================================================================
const TYPER_PRESETS = {
  cyber: "Continuous authentication continuously verifies identity via passive biometrics rather than static passwords.",
  neuro: "Human keystroke hold times and inter-key flights exhibit unique neuromotor rhythms influenced by muscle memory.",
  code:  "Distributed consensus algorithms ensure data consistency across Byzantine fault tolerant multi-tenant clusters."
};

let typerCurrentText = TYPER_PRESETS.cyber;
let typerCharIndex = 0;
let typerErrors = 0;
let typerStartTime = null;
let typerTimer = null;
let typerTimeLeft = 30;

function initTyper() {
  renderTyperPrompt();
  const input = document.getElementById("typer-hidden-input");
  if (input) {
    input.addEventListener("input", handleTyperInput);
    input.addEventListener("keydown", handleTyperKeyDown);
  }
}

function loadTyperPreset(key) {
  if (TYPER_PRESETS[key]) {
    typerCurrentText = TYPER_PRESETS[key];
    document.querySelectorAll(".typer-controls-bar .btn-tag").forEach(b => b.classList.remove("active"));
    const activeBtn = Array.from(document.querySelectorAll(".typer-controls-bar .btn-tag")).find(b => b.textContent.toLowerCase().includes(key));
    if (activeBtn) activeBtn.classList.add("active");
    resetTyperGame();
  }
}

function resetTyperGame() {
  typerCharIndex = 0;
  typerErrors = 0;
  typerStartTime = null;
  if (typerTimer) clearInterval(typerTimer);
  typerTimeLeft = 30;

  document.getElementById("typer-time").textContent  = "00:30";
  document.getElementById("typer-wpm").textContent   = "0";
  document.getElementById("typer-acc").textContent   = "100%";
  document.getElementById("typer-chars").textContent = "0";

  const input = document.getElementById("typer-hidden-input");
  if (input) input.value = "";

  renderTyperPrompt();
  focusTyperInput();
}

function renderTyperPrompt() {
  const container = document.getElementById("typer-prompt");
  if (!container) return;
  container.innerHTML = "";

  const words = typerCurrentText.split(" ");
  words.forEach((word, wIdx) => {
    const wordSpan = document.createElement("span");
    wordSpan.className = "word";
    for (let i = 0; i < word.length; i++) {
      const charSpan = document.createElement("span");
      charSpan.className = "char";
      charSpan.textContent = word[i];
      wordSpan.appendChild(charSpan);
    }
    // Add space
    if (wIdx < words.length - 1) {
      const spaceSpan = document.createElement("span");
      spaceSpan.className = "char";
      spaceSpan.textContent = " ";
      wordSpan.appendChild(spaceSpan);
    }
    container.appendChild(wordSpan);
  });

  updateTyperCaret();
}

function updateTyperCaret() {
  const allChars = document.querySelectorAll("#typer-prompt .char");
  allChars.forEach((c, idx) => {
    c.classList.toggle("current", idx === typerCharIndex);
  });
}

function focusTyperInput() {
  const input = document.getElementById("typer-hidden-input");
  if (input) input.focus();
}

function handleTyperKeyDown(e) {
  if (e.key === "Backspace") {
    if (typerCharIndex > 0) {
      typerCharIndex--;
      const allChars = document.querySelectorAll("#typer-prompt .char");
      const targetChar = allChars[typerCharIndex];
      if (targetChar) {
        targetChar.classList.remove("correct", "incorrect");
      }
      updateTyperCaret();
    }
  }
}

function handleTyperInput(e) {
  if (!typerStartTime) {
    typerStartTime = Date.now();
    typerTimer = setInterval(typerTick, 1000);
  }

  const typedVal = e.target.value;
  const lastChar = typedVal.slice(-1);
  const allChars = document.querySelectorAll("#typer-prompt .char");

  if (typerCharIndex < allChars.length) {
    const expected = allChars[typerCharIndex].textContent;
    if (lastChar === expected) {
      allChars[typerCharIndex].classList.add("correct");
    } else {
      allChars[typerCharIndex].classList.add("incorrect");
      typerErrors++;
    }
    typerCharIndex++;
    updateTyperCaret();
    updateTyperStats();

    // Sentence completed!
    if (typerCharIndex >= allChars.length) {
      if (typerTimer) clearInterval(typerTimer);
      playSound("victory");
      if (sdk) sdk.flush();
      log(`⌨️ Speed Typer completed! Final WPM: <strong>${document.getElementById("typer-wpm").textContent}</strong> &bull; Keystrokes: <strong>${typerCharIndex}</strong>`, "success");
    }
  }
}

function typerTick() {
  if (!typerStartTime) return;
  typerTimeLeft--;
  const min = Math.floor(typerTimeLeft / 60);
  const sec = typerTimeLeft % 60;
  document.getElementById("typer-time").textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;

  updateTyperStats();

  if (typerTimeLeft <= 0) {
    clearInterval(typerTimer);
    if (sdk) sdk.flush();
  }
}

function updateTyperStats() {
  if (!typerStartTime) return;
  const elapsedMinutes = (Date.now() - typerStartTime) / 60000;
  if (elapsedMinutes <= 0) return;

  const wordsTyped = typerCharIndex / 5;
  const wpm = Math.round(wordsTyped / elapsedMinutes);
  const acc = typerCharIndex > 0 ? Math.round(((typerCharIndex - typerErrors) / typerCharIndex) * 100) : 100;

  document.getElementById("typer-wpm").textContent   = wpm;
  document.getElementById("typer-acc").textContent   = Math.max(0, acc) + "%";
  document.getElementById("typer-chars").textContent = typerCharIndex;
}


// =========================================================================
// GAME 3: CYBER SCROLL RUNNER (RHYTHM & INTERACTION)
// =========================================================================
let harvestedNodes = 0;

function harvestDataNode(el, nodeNum) {
  if (el.classList.contains("harvested")) return;
  el.classList.add("harvested");
  harvestedNodes++;

  playSound("hit");
  const scoreEl = document.getElementById("csr-score");
  if (scoreEl) scoreEl.textContent = `${harvestedNodes} / 5`;

  const btn = el.querySelector(".btn-harvest");
  if (btn) btn.textContent = "Harvested ✓";

  log(`📜 Harvested Behavioral Data Capsule #${nodeNum}`, "success");
  if (harvestedNodes >= 5) {
    playSound("victory");
    if (sdk) sdk.flush();
  }
}

function resetScrollGame() {
  harvestedNodes = 0;
  const scoreEl = document.getElementById("csr-score");
  if (scoreEl) scoreEl.textContent = "0 / 5";

  document.querySelectorAll(".csr-node").forEach(node => {
    node.classList.remove("harvested");
    const btn = node.querySelector(".btn-harvest");
    if (btn) btn.textContent = "Harvest";
  });

  const feed = document.getElementById("csr-feed");
  if (feed) feed.scrollTop = 0;
}

function attachScrollFeedTracker() {
  const feed = document.getElementById("csr-feed");
  if (!feed) return;
  feed.addEventListener("scroll", () => {
    const depthEl = document.getElementById("csr-depth");
    const speedEl = document.getElementById("csr-speed");
    if (depthEl) depthEl.textContent = `${Math.round(feed.scrollTop)} px`;
    if (speedEl && _tel.scrollSpeeds.length) {
      speedEl.textContent = `${mean(_tel.scrollSpeeds).toFixed(2)} px/ms`;
    }
  }, { passive: true });
}


// ─── LOGOUT FLOW ─────────────────────────────────────────────
async function handleLogout() {
  if (sdk) { sdk.flush(); sdk.stopMonitoring(); sdk = null; }
  if (sessionId && jwt) {
    fetch(`${API}/session/${sessionId}/terminate`, {
      method: "POST", headers: { "Authorization": "Bearer " + jwt }
    }).catch(() => {});
  }
  if (enrollmentTimer) clearInterval(enrollmentTimer);
  jwt = null; sessionId = null;

  document.getElementById("app").classList.add("hidden");
  document.getElementById("auth-overlay").classList.add("active");
  document.getElementById("session-badge").classList.remove("active");
  document.getElementById("pulse-dot").classList.remove("active");
  document.getElementById("session-badge").textContent = "Initializing…";
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";

  resetDtcGame();
  resetTyperGame();

  log("👋 Logged out from Gaming Arena", "info");
  switchTab("login");
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector(".btn-text").style.display    = loading ? "none"  : "";
  btn.querySelector(".btn-spinner").style.display = loading ? "inline-block" : "none";
  btn.querySelector(".btn-spinner").classList.toggle("hidden", !loading);
}
function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearError(id) {
  const el = document.getElementById(id);
  el.textContent = "";
  el.classList.add("hidden");
}

// ─── INITIALIZATION ──────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initTyper();
  attachScrollFeedTracker();
});
