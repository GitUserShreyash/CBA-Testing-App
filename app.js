/**
 * app.js  —  CBA Test Lab main application
 * Handles: auth (register/login/logout), session start,
 *           SDK init, live UI updates, enrollment polling,
 *           feature chip live estimates.
 */

const API = "http://localhost:8080/api/v1";

// ─── STATE ──────────────────────────────────────────────────
let jwt       = null;
let sessionId = null;
let sdk       = null;
let enrollmentTimer = null;

// Local telemetry counters for live chip estimates
const _tel = {
  keyHold: [], flight: [], lastKeyDown: null, lastKeyUp: null,
  vel: [], lastMouseT: null, lastMouseX: null, lastMouseY: null,
  clickIntervals: [], lastClickT: null,
  scrollSpeeds: [], lastScrollT: null, lastScrollX: null, lastScrollY: null,
  idleGaps: [], lastEventT: null,
  keyEvents: 0, mouseEvents: 0, scrollEvents: 0
};

// ─── HELPERS ────────────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,v)=>s+Math.pow(v-m,2),0) / arr.length);
}
function fmt(v, unit="ms") {
  if (!isFinite(v) || v === 0) return "—";
  return v.toFixed(1) + unit;
}
function now() {
  return new Date().toLocaleTimeString("en-IN", {hour12:false});
}

// ─── LOG ────────────────────────────────────────────────────
function log(msg, type="info") {
  const box = document.getElementById("activity-log");
  const el  = document.createElement("div");
  el.className = `log-entry ${type}`;
  el.innerHTML = `<span class="log-time">[${now()}]</span> ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function clearLog() {
  document.getElementById("activity-log").innerHTML = "";
}

// ─── AUTH TAB SWITCH ────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("login-form").classList.toggle("hidden",    tab !== "login");
  document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
  document.getElementById("tab-login").classList.toggle("active",    tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("register-error").classList.add("hidden");
}

// ─── REGISTER ───────────────────────────────────────────────
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
      method:"POST", headers:{"Content-Type":"application/json"},
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

// ─── LOGIN ───────────────────────────────────────────────────
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
      method:"POST", headers:{"Content-Type":"application/json"},
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

// ─── POST-LOGIN FLOW ─────────────────────────────────────────
async function onLoginSuccess(username) {
  document.getElementById("nav-username").textContent = username;
  document.getElementById("auth-overlay").classList.remove("active");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("session-badge").textContent = "Starting session…";

  log(`✅ Signed in as <strong>${username}</strong>`, "success");

  // Enable buttons
  document.getElementById("flush-btn").disabled = false;
  document.getElementById("refresh-enrollment-btn").disabled = false;
  document.getElementById("refresh-risk-btn").disabled = false;

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

// ─── SDK INIT ────────────────────────────────────────────────
function initSDK() {
  sdk = new window.CBASDK();
  sdk.init({
    token:     jwt,
    apiKey:    "",
    sessionId: sessionId,
    baseUrl:   API,
    onRiskDecision: handleRiskDecision
  });

  log("🧠 CBA SDK initialized — behavioral monitoring active", "info");

  // Start UI ticker
  setInterval(updateSDKStats, 1000);

  // Attach local telemetry listeners (for live chip estimates)
  attachLocalTelemetry();
}

// ─── RISK DECISION CALLBACK ──────────────────────────────────
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
  log(`📊 Risk: <strong>${score.toFixed(1)}</strong> — Level: <strong>${level}</strong> — Status: ${status}`, type);
}

// ─── GAUGE UPDATE ─────────────────────────────────────────────
function updateGauge(score, level) {
  const arc      = document.getElementById("gauge-arc");
  const needle   = document.getElementById("gauge-needle");
  const stop1    = document.getElementById("arc-stop1");
  const stop2    = document.getElementById("arc-stop2");

  // Arc: 251.2 is full circumference of the half-arc
  const pct     = Math.min(score, 100) / 100;
  const offset  = 251.2 * (1 - pct);
  arc.style.strokeDashoffset = offset;

  // Needle: -90deg = 0, +90deg = 100
  const angle = -90 + pct * 180;
  needle.style.transform = `rotate(${angle}deg)`;

  // Color by level
  const colors = {
    LOW:      ["#10b981","#34d399"],
    MEDIUM:   ["#f59e0b","#fbbf24"],
    HIGH:     ["#ef4444","#f87171"],
    CRITICAL: ["#dc2626","#ef4444"],
    WAITING:  ["#6366f1","#8b5cf6"]
  };
  const [c1, c2] = colors[level] || colors.WAITING;
  stop1.setAttribute("stop-color", c1);
  stop2.setAttribute("stop-color", c2);
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

// ─── RISK MANUAL REFRESH ─────────────────────────────────────
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

// ─── SDK STATS TICKER ─────────────────────────────────────────
function updateSDKStats() {
  if (!sdk) return;
  document.getElementById("info-window").textContent   = sdk.windowNumber;
  document.getElementById("info-batches").textContent  = sdk.batchesSent;
  document.getElementById("info-buffered").textContent = sdk.bufferedCount;
}

// ─── MANUAL FLUSH ─────────────────────────────────────────────
function manualFlush() {
  if (!sdk) return;
  log("⚡ Manual flush triggered", "info");
  sdk.flush();
}

// ─── LOCAL TELEMETRY (chip estimates) ────────────────────────
function attachLocalTelemetry() {
  window.addEventListener("keydown", e => {
    _tel.keyEvents++;
    document.getElementById("key-counter").textContent = _tel.keyEvents + " events";
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
    document.getElementById("mouse-counter").textContent = _tel.mouseEvents + " events";
    document.getElementById("cursor-pos").textContent = `x: ${e.clientX}  y: ${e.clientY}`;
    const t = Date.now();
    if (_tel.lastMouseT && _tel.lastMouseX !== null) {
      const dx = e.clientX - _tel.lastMouseX;
      const dy = e.clientY - _tel.lastMouseY;
      const dt = t - _tel.lastMouseT;
      if (dt > 0) _tel.vel.push(Math.sqrt(dx*dx+dy*dy)/dt);
    }
    _tel.lastMouseT = t; _tel.lastMouseX = e.clientX; _tel.lastMouseY = e.clientY;
    updateIdleGap(t);
    updateMouseChips();
  }, { passive: true });

  window.addEventListener("scroll", () => {
    _tel.scrollEvents++;
    document.getElementById("scroll-counter").textContent = _tel.scrollEvents + " events";
    const t  = Date.now();
    const sx = window.scrollX, sy = window.scrollY;
    if (_tel.lastScrollT && _tel.lastScrollX !== null) {
      const dx = sx - _tel.lastScrollX, dy = sy - _tel.lastScrollY;
      const dt = t - _tel.lastScrollT;
      if (dt > 0) _tel.scrollSpeeds.push(Math.sqrt(dx*dx+dy*dy)/dt);
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
  document.getElementById("feat-hold").textContent     = fmt(mean(_tel.keyHold));
  document.getElementById("feat-hold-std").textContent = fmt(stdDev(_tel.keyHold));
  document.getElementById("feat-flight").textContent   = fmt(mean(_tel.flight));
  document.getElementById("feat-flight-std").textContent= fmt(stdDev(_tel.flight));
}
function updateMouseChips() {
  document.getElementById("feat-vel").textContent     = fmt(mean(_tel.vel), " px/ms");
  document.getElementById("feat-vel-std").textContent = fmt(stdDev(_tel.vel), " px/ms");
  // Acceleration estimate
  const v = _tel.vel;
  const accels = v.slice(1).map((vi,i)=>vi - v[i]);
  document.getElementById("feat-accel").textContent  = fmt(mean(accels), " px/ms²");
}
function updateScrollChips() {
  document.getElementById("feat-click").textContent  = fmt(mean(_tel.clickIntervals));
  document.getElementById("feat-scroll").textContent = fmt(mean(_tel.scrollSpeeds), " px/ms");
  document.getElementById("feat-idle").textContent   = fmt(mean(_tel.idleGaps));
}

// ─── TARGET CLICK ANIMATION ──────────────────────────────────
function targetClicked(id) {
  const el = document.getElementById(id);
  el.classList.remove("hit");
  void el.offsetWidth;
  el.classList.add("hit");
  log(`🎯 Mouse target <strong>${id}</strong> clicked`, "info");
}

function clickCardHit(el) {
  el.classList.remove("hit");
  void el.offsetWidth;
  el.classList.add("hit");
}

// ─── LOGOUT ──────────────────────────────────────────────────
async function handleLogout() {
  if (sdk) { sdk.flush(); sdk.stopMonitoring(); sdk = null; }
  if (sessionId && jwt) {
    fetch(`${API}/session/${sessionId}/terminate`, {
      method:"POST", headers:{"Authorization":"Bearer "+jwt}
    }).catch(()=>{});
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
  log("👋 Logged out", "info");
  switchTab("login");
}

// ─── FORM UTILS ──────────────────────────────────────────────
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
