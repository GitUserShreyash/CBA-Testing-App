/**
 * cba-sdk-global.js
 * CBA SDK stripped of ES module export so it works as a plain <script> tag.
 * Exposes window.CBASDK
 */
class CBASDK {
  constructor() {
    this.buffer = [];
    this.eventThreshold = 50;
    this.baseUrl = "http://localhost:8080/api/v1";
    this.sessionId = null;
    this.apiKey = null;
    this.token = null;
    this.windowCounter = 0;
    this.isMonitoring = false;
    this.onRiskDecision = null;
    this._batchesSent = 0;

    this.handleMouse  = this.handleMouse.bind(this);
    this.handleKey    = this.handleKey.bind(this);
    this.handleScroll = this.handleScroll.bind(this);
  }

  init(config) {
    this.apiKey    = config.apiKey   || "";
    this.token     = config.token;
    this.sessionId = config.sessionId;
    if (config.baseUrl)         this.baseUrl        = config.baseUrl.replace(/\/$/, "");
    if (config.eventThreshold)  this.eventThreshold = config.eventThreshold;
    if (typeof config.onRiskDecision === "function") this.onRiskDecision = config.onRiskDecision;
    console.log("[CBA SDK] Initialized for session:", this.sessionId);
    this.startMonitoring();
  }

  startMonitoring() {
    if (this.isMonitoring) return;
    window.addEventListener("mousemove",  this.handleMouse,  { passive: true });
    window.addEventListener("mousedown",  this.handleMouse,  { passive: true });
    window.addEventListener("mouseup",    this.handleMouse,  { passive: true });
    window.addEventListener("keydown",    this.handleKey,    { passive: true });
    window.addEventListener("keyup",      this.handleKey,    { passive: true });
    window.addEventListener("scroll",     this.handleScroll, { passive: true });
    this.isMonitoring = true;
    console.log("[CBA SDK] Passive behavioral event monitoring started.");
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;
    window.removeEventListener("mousemove",  this.handleMouse);
    window.removeEventListener("mousedown",  this.handleMouse);
    window.removeEventListener("mouseup",    this.handleMouse);
    window.removeEventListener("keydown",    this.handleKey);
    window.removeEventListener("keyup",      this.handleKey);
    window.removeEventListener("scroll",     this.handleScroll);
    this.isMonitoring = false;
    console.log("[CBA SDK] Monitoring stopped.");
  }

  handleMouse(e) {
    this.pushToBuffer({
      eventType: "MOUSE",
      action: e.type.toUpperCase(),
      timestamp: Date.now(),
      metadata: { x: e.clientX, y: e.clientY }
    });
  }

  handleKey(e) {
    this.pushToBuffer({
      eventType: "KEYBOARD",
      action: e.type.toUpperCase(),
      timestamp: Date.now(),
      metadata: {}      // intentionally empty — no key values
    });
  }

  handleScroll() {
    this.pushToBuffer({
      eventType: "SCROLL",
      action: "SCROLL",
      timestamp: Date.now(),
      metadata: { scrollX: window.scrollX, scrollY: window.scrollY }
    });
  }

  pushToBuffer(event) {
    this.buffer.push(event);
    if (this.buffer.length >= this.eventThreshold) this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    const payload = {
      sessionId:      this.sessionId,
      windowNumber:   this.windowCounter++,
      idempotencyKey: this._generateUUID(),
      events:         [...this.buffer]
    };
    this.buffer = [];
    this._sendData(payload);
  }

  _sendData(payload, retryCount = 0) {
    const maxRetries = 3;
    const backoffMs  = [1000, 2000, 4000];
    fetch(`${this.baseUrl}/behavior/events`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + this.token,
        "X-CBA-API-KEY": this.apiKey
      },
      body: JSON.stringify(payload)
    })
    .then(r => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(data => {
      this._batchesSent++;
      console.log("[CBA SDK] Risk Decision:", data);
      if (this.onRiskDecision) this.onRiskDecision(data);
    })
    .catch(err => {
      console.warn("[CBA SDK] Batch failed:", err.message);
      if (retryCount < maxRetries) {
        setTimeout(() => this._sendData(payload, retryCount + 1), backoffMs[retryCount]);
      }
    });
  }

  _generateUUID() {
    return "idem_" + Math.random().toString(36).substr(2,9) + "-" + Date.now();
  }

  get batchesSent()    { return this._batchesSent; }
  get bufferedCount()  { return this.buffer.length; }
  get windowNumber()   { return this.windowCounter; }
}

window.CBASDK = CBASDK;
