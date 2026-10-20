/**
 * app.js  —  CBA SaaS Workspace Application
 * Realistic Enterprise IAM & Security Operations Portal
 * Telemetry collected:
 *  - Form entry: natural typing cadence, keystroke hold and flight intervals (x1–x4)
 *  - Directory table: pointer navigation, hover targeting, button click cadence (x5–x7)
 *  - Policy reader: realistic unhurried document reading, scroll velocity, cognitive pauses (x8–x10)
 */

const API = "http://localhost:8080/api/v1";

// ─── STATE ──────────────────────────────────────────────────
let jwt       = null;
let sessionId = null;
let sdk       = null;
let enrollmentTimer = null;

// Telemetry counters for live chip calculation
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

// ─── LOGGING ────────────────────────────────────────────────
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

// ─── WORKSPACE TAB SWITCHER ─────────────────────────────────
function switchWorkspaceTab(tabId) {
  const tabs = {
    form:        { tab: "tab-ws-form",        view: "view-ws-form" },
    table:       { tab: "tab-ws-table",       view: "view-ws-table" },
    docs:        { tab: "tab-ws-docs",        view: "view-ws-docs" },
    diagnostics: { tab: "tab-ws-diagnostics", view: "view-ws-diagnostics" }
  };

  Object.entries(tabs).forEach(([key, config]) => {
    const tabEl  = document.getElementById(config.tab);
    const viewEl = document.getElementById(config.view);
    if (tabEl)  tabEl.classList.toggle("active", key === tabId);
    if (viewEl) viewEl.classList.toggle("hidden", key !== tabId);
  });
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

  log(`✅ Signed in as <strong>${username}</strong> to SaaS Workspace`, "success");

  // Enable manual pipeline buttons
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

  log("🧠 CBA Passive SDK active — streaming authentic web interaction telemetry", "info");

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
  log("⚡ Manual telemetry flush triggered", "info");
  sdk.flush();
}

// ─── LOCAL TELEMETRY LISTENERS ───────────────────────────────
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
// TAB 1: INCIDENT REPORT FORM (AUTHENTIC TYPING CADENCE)
// =========================================================================
function populateSampleText() {
  const subjects = [
    "Unusual token refresh spike from primary cluster IP",
    "Continuous authentication triggered step-up on user ID 14",
    "Degraded ML inference latency in isolation forest microservice",
    "Audit log review: cross-tenant JWT authorization attempt"
  ];
  const descriptions = [
    "During regular audit review between 14:00 and 14:30 UTC, we observed anomalous session activity originating from an unmapped subnet. The continuous behavioral engine recorded sudden divergence in pointer velocity and keystroke hold times, pushing the moving average risk from 14.2% up into the high tier. Recommend immediate credential revocation and token invalidation.",
    "The client SDK reported consecutive batch drops due to network throttling. After restoring connection, telemetry buffering resumed normally and risk evaluation returned to baseline levels. No data loss observed across PostgreSQL tables."
  ];

  document.getElementById("ticket-subject").value = subjects[Math.floor(Math.random() * subjects.length)];
  document.getElementById("ticket-description").value = descriptions[Math.floor(Math.random() * descriptions.length)];
  document.getElementById("ticket-remediation").value = "Session flagged; monitored by SOC; biometric profile intact.";
  log("📋 Sample ticket scenario loaded into form", "info");
}

function resetFormFields() {
  document.getElementById("ticket-subject").value = "";
  document.getElementById("ticket-description").value = "";
  document.getElementById("ticket-remediation").value = "";
  document.getElementById("form-toast").classList.add("hidden");
}

function handleFormSubmit(e) {
  e.preventDefault();
  const toast = document.getElementById("form-toast");
  if (toast) {
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 3500);
  }
  if (sdk) sdk.flush();
  log("📝 Incident ticket submitted. Form interaction telemetry flushed to backend.", "success");
}


// =========================================================================
// TAB 2: USER DIRECTORY TABLE (POINTER TARGETING & CLICK DYNAMICS)
// =========================================================================
const DIRECTORY_USERS = [
  { id: 101, username: "alex.mercer", role: "Admin", status: "ACTIVE", lastSeen: "2 mins ago", email: "alex.m@cloudsecure.io", mfa: "Enabled (TOTP)" },
  { id: 102, username: "sarah.chen", role: "Analyst", status: "ACTIVE", lastSeen: "5 mins ago", email: "sarah.c@cloudsecure.io", mfa: "Enabled (FIDO2)" },
  { id: 103, username: "david.ross", role: "Auditor", status: "PENDING", lastSeen: "1 hour ago", email: "david.r@cloudsecure.io", mfa: "Not Configured" },
  { id: 104, username: "priya.sharma", role: "Admin", status: "ACTIVE", lastSeen: "12 mins ago", email: "priya.s@cloudsecure.io", mfa: "Enabled (WebAuthn)" },
  { id: 105, username: "marcus.vance", role: "Analyst", status: "SUSPENDED", lastSeen: "2 days ago", email: "marcus.v@cloudsecure.io", mfa: "Revoked" },
  { id: 106, username: "elena.rostova", role: "Auditor", status: "ACTIVE", lastSeen: "28 mins ago", email: "elena.r@cloudsecure.io", mfa: "Enabled (TOTP)" },
  { id: 107, username: "kevin.patel", role: "Analyst", status: "ACTIVE", lastSeen: "Just now", email: "kevin.p@cloudsecure.io", mfa: "Enabled (FIDO2)" },
  { id: 108, username: "rachel.adams", role: "Admin", status: "PENDING", lastSeen: "3 hours ago", email: "rachel.a@cloudsecure.io", mfa: "Pending Setup" }
];

let tableSortDir = 1;

function renderDirectoryTable(users) {
  const tbody = document.getElementById("directory-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  users.forEach(u => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">#${u.id}</td>
      <td><strong>${u.username}</strong><br/><small style="color:var(--text3)">${u.email}</small></td>
      <td><span class="role-tag">${u.role}</span></td>
      <td><span class="status-pill ${u.status.toLowerCase()}">${u.status}</span></td>
      <td style="color:var(--text2)">${u.lastSeen}</td>
      <td>
        <button class="btn-table-action" onclick="inspectUser(${u.id})">Inspect</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function filterDirectoryTable() {
  const query = (document.getElementById("table-search")?.value || "").toLowerCase();
  const roleFilter = document.getElementById("table-filter-role")?.value || "all";
  const statusFilter = document.getElementById("table-filter-status")?.value || "all";

  const filtered = DIRECTORY_USERS.filter(u => {
    const matchesQuery = u.username.toLowerCase().includes(query) || u.email.toLowerCase().includes(query);
    const matchesRole = roleFilter === "all" || u.role === roleFilter;
    const matchesStatus = statusFilter === "all" || u.status === statusFilter;
    return matchesQuery && matchesRole && matchesStatus;
  });

  renderDirectoryTable(filtered);
}

function sortTable(colIndex) {
  tableSortDir = -tableSortDir;
  const sorted = [...DIRECTORY_USERS].sort((a, b) => {
    let valA, valB;
    if (colIndex === 0) { valA = a.id; valB = b.id; }
    else if (colIndex === 1) { valA = a.username; valB = b.username; }
    else if (colIndex === 2) { valA = a.role; valB = b.role; }
    else if (colIndex === 3) { valA = a.status; valB = b.status; }
    else { valA = a.lastSeen; valB = b.lastSeen; }

    if (valA < valB) return -1 * tableSortDir;
    if (valA > valB) return 1 * tableSortDir;
    return 0;
  });
  renderDirectoryTable(sorted);
}

function inspectUser(userId) {
  const u = DIRECTORY_USERS.find(x => x.id === userId);
  if (!u) return;

  const drawer = document.getElementById("inspect-drawer");
  const title = document.getElementById("drawer-title");
  const body = document.getElementById("drawer-body");

  if (title) title.textContent = `User Profile Inspection — ${u.username}`;
  if (body) {
    body.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:6px;">
        <div><strong>User ID:</strong> <span class="mono">#${u.id}</span></div>
        <div><strong>Role:</strong> ${u.role}</div>
        <div><strong>Email:</strong> ${u.email}</div>
        <div><strong>Status:</strong> <span class="status-pill ${u.status.toLowerCase()}">${u.status}</span></div>
        <div><strong>MFA Method:</strong> ${u.mfa}</div>
        <div><strong>Assigned Tenant:</strong> Production-US-East</div>
      </div>
    `;
  }
  if (drawer) drawer.classList.remove("hidden");
  log(`👤 Inspected user record <strong>#${userId} (${u.username})</strong>`, "info");
}

function closeDrawer() {
  const drawer = document.getElementById("inspect-drawer");
  if (drawer) drawer.classList.add("hidden");
}


// =========================================================================
// TAB 3: POLICY READER & AUDIT FEED (READING DYNAMICS & SCROLL)
// =========================================================================
function toggleAccordion(el) {
  el.classList.toggle("open");
}

function attachDocsScrollTracker() {
  const feed = document.getElementById("docs-reader-feed");
  if (!feed) return;
  feed.addEventListener("scroll", () => {
    const depthEl = document.getElementById("read-depth");
    const speedEl = document.getElementById("read-speed");
    if (depthEl) depthEl.textContent = `Scroll: ${Math.round(feed.scrollTop)} px`;
    if (speedEl && _tel.scrollSpeeds.length) {
      speedEl.textContent = `Speed: ${mean(_tel.scrollSpeeds).toFixed(2)} px/ms`;
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

  log("👋 Logged out from Workspace Portal", "info");
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
  renderDirectoryTable(DIRECTORY_USERS);
  attachDocsScrollTracker();
});
