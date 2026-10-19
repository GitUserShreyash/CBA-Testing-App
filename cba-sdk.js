class CBASDK {
  constructor() {
    this.buffer = [];
    this.eventThreshold = 50; // default 50 events per batch
    this.baseUrl = "http://localhost:8080/api/v1";
    this.sessionId = null;
    this.apiKey = null;
    this.token = null;
    this.windowCounter = 0;
    this.isMonitoring = false;
    this.onRiskDecision = null; // optional callback for host website

    this.handleMouse = this.handleMouse.bind(this);
    this.handleKey = this.handleKey.bind(this);
    this.handleScroll = this.handleScroll.bind(this);
  }

  /**
   * Initializes the CBA Telemetry SDK.
   * @param {Object} config Configuration object
   * @param {string} config.apiKey SaaS Tenant API Key
   * @param {string} config.token User JWT authentication token
   * @param {string} config.sessionId Active monitoring session identifier
   * @param {string} [config.baseUrl] Custom backend endpoint URL (defaults to http://localhost:8080/api/v1)
   * @param {number} [config.eventThreshold] Number of events per batch (defaults to 50)
   * @param {Function} [config.onRiskDecision] Callback receiving real-time risk decision from CBA backend
   */
  init(config) {
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.sessionId = config.sessionId;

    if (config.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/$/, "");
    }
    if (config.eventThreshold) {
      this.eventThreshold = config.eventThreshold;
    }
    if (typeof config.onRiskDecision === "function") {
      this.onRiskDecision = config.onRiskDecision;
    }

    console.log("[CBA SDK] Initialized for session:", this.sessionId);
    this.startMonitoring();
  }

  startMonitoring() {
    if (this.isMonitoring) {
      return;
    }

    window.addEventListener("mousemove", this.handleMouse, { passive: true });
    window.addEventListener("mousedown", this.handleMouse, { passive: true });
    window.addEventListener("mouseup", this.handleMouse, { passive: true });

    window.addEventListener("keydown", this.handleKey, { passive: true });
    window.addEventListener("keyup", this.handleKey, { passive: true });

    window.addEventListener("scroll", this.handleScroll, { passive: true });

    this.isMonitoring = true;
    console.log("[CBA SDK] Passive behavioral event monitoring started.");
  }

  stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    window.removeEventListener("mousemove", this.handleMouse);
    window.removeEventListener("mousedown", this.handleMouse);
    window.removeEventListener("mouseup", this.handleMouse);

    window.removeEventListener("keydown", this.handleKey);
    window.removeEventListener("keyup", this.handleKey);

    window.removeEventListener("scroll", this.handleScroll);

    this.isMonitoring = false;
    console.log("[CBA SDK] Event monitoring stopped.");
  }

  handleMouse(e) {
    const payload = {
      eventType: "MOUSE",
      action: e.type.toUpperCase(),
      timestamp: Date.now(),
      metadata: {
        x: e.clientX,
        y: e.clientY
      }
    };

    this.pushToBuffer(payload);
  }

  handleKey(e) {
    const payload = {
      eventType: "KEYBOARD",
      action: e.type.toUpperCase(),
      timestamp: Date.now(),
      metadata: {
        // Intentionally empty. Character values are never recorded for privacy protection.
      }
    };

    this.pushToBuffer(payload);
  }

  handleScroll() {
    const payload = {
      eventType: "SCROLL",
      action: "SCROLL",
      timestamp: Date.now(),
      metadata: {
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    };

    this.pushToBuffer(payload);
  }

  pushToBuffer(event) {
    this.buffer.push(event);

    if (this.buffer.length >= this.eventThreshold) {
      this.flush();
    }
  }

  flush() {
    if (this.buffer.length === 0) {
      return;
    }

    const payload = {
      sessionId: this.sessionId,
      windowNumber: this.windowCounter++,
      idempotencyKey: this.generateUUID(),
      events: [...this.buffer]
    };

    this.buffer = [];
    this.sendData(payload);
  }

  sendData(payload, retryCount = 0) {
    const maxRetries = 3;
    const backoffMs = [1000, 2000, 4000];
    const endpoint = `${this.baseUrl}/behavior/events`;

    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this.token,
        "X-CBA-API-KEY": this.apiKey || ""
      },
      body: JSON.stringify(payload)
    })
      .then(response => {
        if (!response.ok) {
          throw new Error("Request failed with HTTP status " + response.status);
        }
        return response.json();
      })
      .then(data => {
        console.log("[CBA SDK] Risk Decision Received:", data);
        if (this.onRiskDecision) {
          this.onRiskDecision(data);
        }
      })
      .catch(error => {
        console.warn("[CBA SDK] Batch submission failed:", error.message);

        if (retryCount < maxRetries) {
          const delay = backoffMs[retryCount];
          setTimeout(() => {
            this.sendData(payload, retryCount + 1);
          }, delay);
        }
      });
  }

  generateUUID() {
    return (
      "idem_" +
      Math.random().toString(36).substr(2, 9) +
      "-" +
      Date.now()
    );
  }
}

// Expose globally for script tag embedding
if (typeof window !== "undefined") {
  window.CBASDK = CBASDK;
}

export default CBASDK;