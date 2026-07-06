(() => {
  "use strict";

  const token = localStorage.getItem("aviator_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const GROWTH_RATE = 0.00009; // must match server/game.js — purely for smooth client-side interpolation
  function multiplierAt(elapsedMs) {
    return Math.exp(GROWTH_RATE * elapsedMs);
  }

  // ---------- Session bootstrap ----------
  const balanceEl = document.getElementById("balanceValue");
  const usernamePill = document.getElementById("usernamePill");
  const adminLink = document.getElementById("adminLink");

  function setBalance(v) {
    balanceEl.textContent = Number(v).toFixed(2);
  }

  function logout() {
    localStorage.removeItem("aviator_token");
    localStorage.removeItem("aviator_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  async function loadSelf() {
    const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const { user } = await res.json();
    localStorage.setItem("aviator_user", JSON.stringify(user));
    usernamePill.textContent = user.username;
    setBalance(user.balance);
    if (user.isAdmin) adminLink.classList.remove("section-hidden");
  }
  loadSelf();

  // ---------- Toast ----------
  const toastEl = document.getElementById("toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3000);
  }

  // ---------- History ----------
  const historyEl = document.getElementById("history");
  function pushHistory(point) {
    const chip = document.createElement("div");
    let cls = "low";
    if (point >= 10) cls = "high";
    else if (point >= 2) cls = "mid";
    chip.className = `history-chip ${cls}`;
    chip.textContent = point.toFixed(2) + "x";
    historyEl.insertBefore(chip, historyEl.firstChild);
    while (historyEl.children.length > 20) historyEl.removeChild(historyEl.lastChild);
  }

  // ---------- Socket (native WebSocket, Socket.io-shaped wrapper) ----------
  // Cloudflare Workers doesn't run the Socket.io server library, so this
  // talks to the Durable Object's plain WebSocket endpoint directly. The
  // on/emit shape is kept so the rest of this file (and BetPanel) doesn't
  // need to change.
  const socket = (() => {
    const handlers = new Map();
    let ws = null;
    let reconnectDelay = 500;

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

      ws.addEventListener("open", () => {
        reconnectDelay = 500;
      });

      ws.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        const { type, ...payload } = data;
        const list = handlers.get(type);
        if (list) list.forEach((fn) => fn(payload));
      });

      ws.addEventListener("close", () => {
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
      });
    }
    connect();

    return {
      on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      emit(type, payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type, ...payload }));
        }
      },
    };
  })();

  // ---------- Game state ----------
  const game = {
    phase: "waiting", // waiting | running | crashed
    phaseStartLocal: performance.now(),
    waitMs: 5000,
    lastTick: null, // { multiplier, elapsedMs, receivedAt }
    crashPoint: null,
    currentMultiplier: 1,
  };

  const roundBadgeEl = document.getElementById("roundBadge");
  function updateRoundBadge(roundId) {
    if (roundId) roundBadgeEl.textContent = `Round #${roundId}`;
  }

  socket.on("round:state", (state) => {
    game.phase = state.state;
    game.phaseStartLocal = performance.now() - state.msInPhase;
    game.waitMs = state.waitMs;
    game.currentMultiplier = state.multiplier;
    updateRoundBadge(state.roundId);
  });

  socket.on("round:waiting", ({ waitMs, roundId }) => {
    game.phase = "waiting";
    game.phaseStartLocal = performance.now();
    game.waitMs = waitMs;
    game.lastTick = null;
    game.crashPoint = null;
    game.currentMultiplier = 1;
    multiplierTextEl.classList.remove("flying", "crashed");
    multiplierTextEl.textContent = "1.00x";
    ringEl.classList.remove("hidden");
    updateRoundBadge(roundId);
    betPanels.forEach((p) => p.onRoundReset());
  });

  socket.on("round:running", ({ roundId }) => {
    game.phase = "running";
    game.phaseStartLocal = performance.now();
    game.lastTick = null;
    ringEl.classList.add("hidden");
    multiplierTextEl.classList.add("flying");
    stateTextEl.textContent = "Flying…";
    updateRoundBadge(roundId);
    betPanels.forEach((p) => p.onRoundStart());
  });

  socket.on("round:tick", ({ multiplier, elapsedMs }) => {
    game.lastTick = { multiplier, elapsedMs, receivedAt: performance.now() };
  });

  socket.on("round:crashed", ({ crashPoint, roundId }) => {
    game.phase = "crashed";
    game.phaseStartLocal = performance.now();
    game.crashPoint = crashPoint;
    game.currentMultiplier = crashPoint;
    multiplierTextEl.classList.remove("flying");
    multiplierTextEl.classList.add("crashed");
    multiplierTextEl.textContent = crashPoint.toFixed(2) + "x";
    stateTextEl.textContent = "Flew away!";
    updateRoundBadge(roundId);
    pushHistory(crashPoint);
    betPanels.forEach((p) => p.onRoundEnd());
  });

  socket.on("bet:placed", ({ slot, balance }) => {
    setBalance(balance);
    betPanels[slot].onPlaced();
  });

  socket.on("bet:cancelled", ({ slot, balance }) => {
    setBalance(balance);
    betPanels[slot].onCancelled();
  });

  socket.on("bet:cashed_out", ({ slot, multiplier, payout, balance }) => {
    setBalance(balance);
    betPanels[slot].onCashedOut(multiplier, payout);
  });

  socket.on("bet:error", ({ slot, error }) => {
    toast(error);
    if (slot !== undefined && betPanels[slot]) betPanels[slot].onError();
  });

  // ---------- Bet panels ----------
  class BetPanel {
    constructor(rootEl, slot) {
      this.root = rootEl;
      this.slot = slot;
      this.amountInput = rootEl.querySelector(".amount-input");
      this.autoEnabled = rootEl.querySelector(".auto-enabled");
      this.autoTarget = rootEl.querySelector(".auto-target");
      this.actionBtn = rootEl.querySelector(".bet-btn");
      this.actionLabel = rootEl.querySelector(".action-label");
      this.actionAmount = rootEl.querySelector(".action-amount");

      this.status = "idle"; // idle | pending | placed | active | cashedout | lost
      this.amount = Number(this.amountInput.value) || 10;

      this._wireTabs();
      this._wirePresets();
      this._wireAmount();
      this.actionBtn.addEventListener("click", () => this._onAction());
      this._render();
    }

    _wireTabs() {
      const tabs = this.root.querySelectorAll(".bet-tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          const target = tab.dataset.tab;
          this.root.querySelectorAll(".bet-tab-content").forEach((c) => {
            c.classList.toggle("hidden", c.dataset.content !== target);
          });
        });
      });
    }

    _wirePresets() {
      this.root.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (this.status !== "idle") return;
          const p = btn.dataset.preset;
          let v = this.amount;
          if (p === "half") v = Math.max(1, v / 2);
          else if (p === "double") v = v * 2;
          else v = Number(p);
          this.amount = Math.round(v * 100) / 100;
          this.amountInput.value = this.amount;
          this._render();
        });
      });

      this.root.querySelectorAll(".step-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (this.status !== "idle") return;
          const dir = btn.dataset.action === "inc" ? 1 : -1;
          this.amount = Math.max(1, this.amount + dir);
          this.amountInput.value = this.amount;
          this._render();
        });
      });
    }

    _wireAmount() {
      this.amountInput.addEventListener("input", () => {
        const v = Number(this.amountInput.value);
        this.amount = isFinite(v) && v > 0 ? v : 1;
        this._render();
      });
    }

    _onAction() {
      // Always forward the action and let the server (the source of truth for
      // round phase) accept or reject it — avoids a client-side race where a
      // click landing right at a phase boundary would otherwise be a silent no-op.
      if (this.status === "idle") {
        this.status = "pending";
        this._render();
        const autoCashout = this.autoEnabled.checked ? Number(this.autoTarget.value) : null;
        socket.emit("bet:place", { slot: this.slot, amount: this.amount, autoCashout });
      } else if (this.status === "placed") {
        this.status = "pending";
        this._render();
        socket.emit("bet:cancel", { slot: this.slot });
      } else if (this.status === "active") {
        socket.emit("bet:cashout", { slot: this.slot });
      }
    }

    onPlaced() {
      this.status = "placed";
      this._render();
    }

    onCancelled() {
      this.status = "idle";
      this._render();
    }

    onCashedOut(multiplier, payout) {
      this.status = "cashedout";
      this.cashOutAt = multiplier;
      this.cashOutPayout = payout;
      this._render();
    }

    onError() {
      // Roll back an optimistic "pending" state if the server rejected the action.
      if (this.status === "pending") this.status = "idle";
      this._render();
    }

    onRoundStart() {
      if (this.status === "placed") this.status = "active";
      else if (this.status !== "idle") this.status = "idle";
      this._render();
    }

    onRoundEnd() {
      if (this.status === "active") this.status = "lost";
      this._render();
    }

    onRoundReset() {
      this.status = "idle";
      this.cashOutAt = null;
      this._render();
    }

    tickActive() {
      if (this.status !== "active") return;
      this.actionAmount.textContent = (this.amount * game.currentMultiplier).toFixed(2);
    }

    _render() {
      this.actionBtn.classList.remove("state-bet", "state-queued", "state-active", "state-cashedout", "state-lost");
      const editable = this.status === "idle";
      this.amountInput.disabled = !editable;
      this.autoTarget.disabled = !editable;
      this.autoEnabled.disabled = !editable;
      this.actionBtn.disabled = this.status === "pending";

      switch (this.status) {
        case "idle":
          this.actionBtn.classList.add("state-bet");
          this.actionLabel.textContent = game.phase === "waiting" ? "BET" : "WAIT NEXT ROUND";
          this.actionAmount.textContent = this.amount.toFixed(2);
          break;
        case "pending":
          this.actionLabel.textContent = "…";
          this.actionAmount.textContent = this.amount.toFixed(2);
          break;
        case "placed":
          this.actionBtn.classList.add("state-queued");
          this.actionLabel.textContent = "CANCEL";
          this.actionAmount.textContent = this.amount.toFixed(2);
          break;
        case "active":
          this.actionBtn.classList.add("state-active");
          this.actionLabel.textContent = "CASH OUT";
          this.actionAmount.textContent = (this.amount * game.currentMultiplier).toFixed(2);
          break;
        case "cashedout":
          this.actionBtn.classList.add("state-cashedout");
          this.actionLabel.textContent = "CASHED OUT";
          this.actionAmount.textContent = this.cashOutAt.toFixed(2) + "x won " + this.cashOutPayout.toFixed(2);
          break;
        case "lost":
          this.actionBtn.classList.add("state-lost");
          this.actionLabel.textContent = "FLEW AWAY";
          this.actionAmount.textContent = "-" + this.amount.toFixed(2);
          break;
      }
    }
  }

  const betPanels = Array.from(document.querySelectorAll(".bet-panel")).map(
    (el) => new BetPanel(el, Number(el.dataset.slot))
  );

  // ---------- Canvas ----------
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // Background starfield — a fixed set of dots we drift to imply motion.
  const STARS = Array.from({ length: 70 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.4 + 0.3,
    a: Math.random() * 0.35 + 0.12,
  }));

  // Aviator's signature look: a slowly rotating fan of faint red rays that
  // emanate from the launch corner, plus drifting stars for a sense of speed.
  function drawBackground(now, w, h, cx, cy, intensity) {
    const rot = (now / 7000) * Math.PI * 2;
    const rays = 16;
    const R = Math.hypot(w, h) * 1.1;
    const wedge = (Math.PI * 2) / rays;
    ctx.save();
    for (let i = 0; i < rays; i++) {
      const a0 = rot + i * wedge;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + wedge / 2);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,45,85,${(0.028 + intensity * 0.05).toFixed(3)})`;
      ctx.fill();
    }
    ctx.restore();

    const drift = (now / 1000) * (0.02 + intensity * 0.06);
    ctx.save();
    for (const s of STARS) {
      const sx = ((((s.x - drift) % 1) + 1) % 1) * w;
      const sy = ((s.y + drift * 0.3) % 1) * h;
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.a})`;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFrame(elapsedMs, currentMultiplier, crashed) {
    const now = performance.now();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const padding = 24;
    const xMax = Math.max(elapsedMs * 1.15, 2000);
    const yMax = Math.max(currentMultiplier * 1.25, 2);

    const toX = (t) => padding + (t / xMax) * (w - padding * 2);
    const toY = (m) => h - padding - ((m - 1) / (yMax - 1)) * (h - padding * 2);

    // Rays/stars ramp up with the multiplier while flying, calm otherwise.
    const intensity = crashed ? 0.15 : Math.min(1, (currentMultiplier - 1) / 4);
    drawBackground(now, w, h, padding, h - padding, intensity);

    const steps = 80;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = (elapsedMs * i) / steps;
      const m = multiplierAt(t);
      points.push([toX(t), toY(m)]);
    }

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(1));
    points.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(points[points.length - 1][0], h - padding);
    ctx.lineTo(toX(0), h - padding);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, crashed ? "rgba(229,5,57,0.45)" : "rgba(255,45,85,0.40)");
    grad.addColorStop(1, "rgba(255,45,85,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = crashed ? "#e50539" : "#ff2d55";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.shadowColor = crashed ? "rgba(229,5,57,0.8)" : "rgba(255,45,85,0.8)";
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Plane, oriented along the direction of travel.
    const [px, py] = points[points.length - 1];
    ctx.save();
    ctx.translate(px, py);
    const prev = points[Math.max(0, points.length - 5)];
    const angle = Math.atan2(py - prev[1], px - prev[0]);
    ctx.rotate(angle);
    ctx.shadowColor = crashed ? "rgba(229,5,57,0.7)" : "rgba(255,45,85,0.7)";
    ctx.shadowBlur = 10;
    drawPlane(ctx, crashed, now);
    ctx.restore();
  }

  // Draws a recognizable propeller plane at the origin, pointing along +x.
  function drawPlane(ctx, crashed, now) {
    const body = crashed ? "#e50539" : "#ff2d55";
    const trim = crashed ? "#ff5c7a" : "#ffd0dc";
    ctx.scale(1.3, 1.3);

    // Spinning propeller disc at the nose.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.translate(19, 0);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 2, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    const spin = (now / 40) % (Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.4;
    for (let b = 0; b < 2; b++) {
      const a = spin + b * Math.PI;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(a) * 1.5, Math.cos(a) * 10);
      ctx.stroke();
    }
    ctx.restore();

    // Wings (swept back from the fuselage, top and bottom mirror).
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(-14, -13);
    ctx.lineTo(-6, -2);
    ctx.lineTo(6, -1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(-14, 13);
    ctx.lineTo(-6, 2);
    ctx.lineTo(6, 1);
    ctx.closePath();
    ctx.fill();

    // Tail fin at the rear.
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.lineTo(-20, -8);
    ctx.lineTo(-15, 0);
    ctx.lineTo(-20, 8);
    ctx.closePath();
    ctx.fill();

    // Fuselage.
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nose cone highlight + canopy.
    ctx.fillStyle = trim;
    ctx.beginPath();
    ctx.ellipse(11, 0, 6, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(2, -0.5, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- Render loop ----------
  const stateTextEl = document.getElementById("stateText");
  const multiplierTextEl = document.getElementById("multiplierText");
  const ringEl = document.getElementById("countdownRing");
  const ringFg = document.getElementById("ringFg");
  const countdownTextEl = document.getElementById("countdownText");
  const RING_CIRC = 283;

  function loop() {
    const now = performance.now();

    if (game.phase === "waiting") {
      const elapsed = now - game.phaseStartLocal;
      const remain = Math.max(0, game.waitMs - elapsed);
      stateTextEl.textContent = "Next round in…";
      countdownTextEl.textContent = (remain / 1000).toFixed(1);
      ringFg.style.strokeDashoffset = String(RING_CIRC * (1 - remain / game.waitMs));
      drawFrame(0, 1, false);
    } else if (game.phase === "running") {
      let displayElapsed;
      if (game.lastTick) {
        displayElapsed = game.lastTick.elapsedMs + (now - game.lastTick.receivedAt);
      } else {
        displayElapsed = now - game.phaseStartLocal;
      }
      const m = multiplierAt(displayElapsed);
      game.currentMultiplier = m;
      multiplierTextEl.textContent = m.toFixed(2) + "x";
      drawFrame(displayElapsed, m, false);
      betPanels.forEach((p) => p.tickActive());
    } else if (game.phase === "crashed") {
      const t = Math.log(game.crashPoint) / GROWTH_RATE;
      drawFrame(t, game.crashPoint, true);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
