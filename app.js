(() => {
  "use strict";

  // ---------- Config ----------
  const WAIT_MS = 5000;
  const CRASH_FREEZE_MS = 2200;
  const GROWTH_RATE = 0.00009; // multiplier = e^(GROWTH_RATE * elapsedMs)
  const STARTING_BALANCE = 1000;
  const HISTORY_LIMIT = 20;
  const MAX_CRASH_POINT = 5000;

  // ---------- Provably-fair-style crash point (simulated, client-side) ----------
  // cyrb53 hash: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function randomSeed() {
    const rand = Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${rand}`;
  }

  function generateRound() {
    const seed = randomSeed();
    const h = cyrb53(seed); // 0 .. 2^53-1
    const E = Math.pow(2, 53);

    let point;
    if (h % 33 === 0) {
      point = 1.0; // instant crash, baked-in house edge
    } else {
      point = Math.floor((100 * E - h) / (E - h)) / 100;
      if (!isFinite(point) || point < 1) point = 1.0;
      point = Math.min(point, MAX_CRASH_POINT);
    }
    return { seed, hash: h.toString(16), point };
  }

  function multiplierAt(elapsedMs) {
    return Math.exp(GROWTH_RATE * elapsedMs);
  }

  function timeForMultiplier(mult) {
    return Math.log(mult) / GROWTH_RATE;
  }

  // ---------- Balance ----------
  const balanceEl = document.getElementById("balanceValue");
  let balance = Number(localStorage.getItem("aviator_balance"));
  if (!isFinite(balance) || balance <= 0) balance = STARTING_BALANCE;

  function setBalance(v) {
    balance = Math.max(0, v);
    localStorage.setItem("aviator_balance", String(balance));
    balanceEl.textContent = balance.toFixed(2);
  }
  setBalance(balance);

  document.getElementById("resetBalanceBtn").addEventListener("click", () => {
    setBalance(STARTING_BALANCE);
  });

  // ---------- Fairness modal ----------
  const fairnessModal = document.getElementById("fairnessModal");
  document.getElementById("fairnessBtn").addEventListener("click", () => {
    fairnessModal.classList.remove("hidden");
  });
  document.getElementById("closeFairness").addEventListener("click", () => {
    fairnessModal.classList.add("hidden");
  });
  fairnessModal.addEventListener("click", (e) => {
    if (e.target === fairnessModal) fairnessModal.classList.add("hidden");
  });

  function updateFairnessPanel(round) {
    document.getElementById("fairSeed").textContent = round.seed;
    document.getElementById("fairHash").textContent = round.hash;
    document.getElementById("fairCrash").textContent = round.point.toFixed(2) + "x";
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
    while (historyEl.children.length > HISTORY_LIMIT) {
      historyEl.removeChild(historyEl.lastChild);
    }
  }

  // ---------- Bet panels ----------
  class BetPanel {
    constructor(rootEl) {
      this.root = rootEl;
      this.amountInput = rootEl.querySelector(".amount-input");
      this.autoEnabled = rootEl.querySelector(".auto-enabled");
      this.autoTarget = rootEl.querySelector(".auto-target");
      this.actionBtn = rootEl.querySelector(".bet-btn");
      this.actionLabel = rootEl.querySelector(".action-label");
      this.actionAmount = rootEl.querySelector(".action-amount");

      this.status = "idle"; // idle | queued | active | cashedout | lost
      this.amount = Number(this.amountInput.value) || 10;
      this.cashOutAt = null;

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
      if (this.status === "idle") {
        if (this.amount > balance) return;
        setBalance(balance - this.amount);
        this.status = "queued";
      } else if (this.status === "queued") {
        setBalance(balance + this.amount);
        this.status = "idle";
      } else if (this.status === "active") {
        this.cashOut();
      }
      this._render();
    }

    cashOut() {
      if (this.status !== "active") return;
      this.cashOutAt = game.currentMultiplier;
      const winnings = this.amount * this.cashOutAt;
      setBalance(balance + winnings);
      this.status = "cashedout";
      this._render();
    }

    onRoundStart() {
      if (this.status === "queued") {
        this.status = "active";
      }
      this._render();
    }

    onRoundEnd() {
      if (this.status === "active") {
        this.status = "lost";
      }
      this._render();
    }

    onRoundReset() {
      this.status = "idle";
      this.cashOutAt = null;
      this.amountInput.disabled = false;
      this.autoTarget.disabled = false;
      this.autoEnabled.disabled = false;
      this._render();
    }

    checkAutoCashout() {
      if (this.status !== "active" || !this.autoEnabled.checked) return;
      const target = Number(this.autoTarget.value);
      if (isFinite(target) && game.currentMultiplier >= target) {
        this.cashOut();
      }
    }

    tickActive() {
      if (this.status !== "active") return;
      const potential = (this.amount * game.currentMultiplier).toFixed(2);
      this.actionLabel.textContent = "CASH OUT";
      this.actionAmount.textContent = potential;
    }

    _render() {
      this.actionBtn.classList.remove(
        "state-bet", "state-queued", "state-active", "state-cashedout", "state-lost"
      );
      this.amountInput.disabled = this.status !== "idle";
      this.autoTarget.disabled = this.status !== "idle";
      this.autoEnabled.disabled = this.status !== "idle";

      switch (this.status) {
        case "idle":
          this.actionBtn.classList.add("state-bet");
          this.actionLabel.textContent = "BET";
          this.actionAmount.textContent = this.amount.toFixed(2);
          break;
        case "queued":
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
          this.actionAmount.textContent = (this.cashOutAt.toFixed(2)) + "x won " + (this.amount * this.cashOutAt).toFixed(2);
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
    (el) => new BetPanel(el)
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

  function drawFrame(elapsedMs, currentMultiplier, crashed) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const padding = 24;
    const xMax = Math.max(elapsedMs * 1.15, 2000);
    const yMax = Math.max(currentMultiplier * 1.25, 2);

    const toX = (t) => padding + (t / xMax) * (w - padding * 2);
    const toY = (m) => h - padding - ((m - 1) / (yMax - 1)) * (h - padding * 2);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = padding + ((h - padding * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(w - padding, y);
      ctx.stroke();
    }

    // curve
    const steps = 80;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = (elapsedMs * i) / steps;
      const m = multiplierAt(t);
      points.push([toX(t), toY(m)]);
    }

    // filled area under curve
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(1));
    points.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(points[points.length - 1][0], h - padding);
    ctx.lineTo(toX(0), h - padding);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, crashed ? "rgba(255,59,92,0.35)" : "rgba(79,124,255,0.35)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    // stroke line
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = crashed ? "#ff3b5c" : "#ffffff";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.stroke();

    // plane at tip
    const [px, py] = points[points.length - 1];
    ctx.save();
    ctx.translate(px, py);
    const prev = points[Math.max(0, points.length - 5)];
    const angle = Math.atan2(py - prev[1], px - prev[0]);
    ctx.rotate(angle);
    ctx.font = "22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = crashed ? "#ff3b5c" : "#ffffff";
    ctx.fillText("✈", 0, 0);
    ctx.restore();
  }

  // ---------- Game state machine ----------
  const stateTextEl = document.getElementById("stateText");
  const multiplierTextEl = document.getElementById("multiplierText");
  const ringEl = document.getElementById("countdownRing");
  const ringFg = document.getElementById("ringFg");
  const countdownTextEl = document.getElementById("countdownText");
  const RING_CIRC = 283;

  const game = {
    state: "waiting", // waiting | running | crashed
    phaseStart: performance.now(),
    round: null,
    currentMultiplier: 1,
  };

  function startWaiting() {
    game.state = "waiting";
    game.phaseStart = performance.now();
    game.round = generateRound();
    updateFairnessPanel(game.round);
    ringEl.classList.remove("hidden");
    multiplierTextEl.classList.remove("flying", "crashed");
    multiplierTextEl.textContent = "1.00x";
    betPanels.forEach((p) => p.onRoundReset());
  }

  function startRunning() {
    game.state = "running";
    game.phaseStart = performance.now();
    ringEl.classList.add("hidden");
    multiplierTextEl.classList.add("flying");
    stateTextEl.textContent = "Flying…";
    betPanels.forEach((p) => p.onRoundStart());
  }

  function startCrashed() {
    game.state = "crashed";
    game.phaseStart = performance.now();
    multiplierTextEl.classList.remove("flying");
    multiplierTextEl.classList.add("crashed");
    multiplierTextEl.textContent = game.round.point.toFixed(2) + "x";
    stateTextEl.textContent = "Flew away!";
    pushHistory(game.round.point);
    betPanels.forEach((p) => p.onRoundEnd());
  }

  function loop() {
    const now = performance.now();
    const elapsed = now - game.phaseStart;

    if (game.state === "waiting") {
      const remain = Math.max(0, WAIT_MS - elapsed);
      stateTextEl.textContent = "Next round in…";
      countdownTextEl.textContent = (remain / 1000).toFixed(1);
      ringFg.style.strokeDashoffset = String(RING_CIRC * (1 - remain / WAIT_MS));
      drawFrame(0, 1, false);
      if (elapsed >= WAIT_MS) startRunning();
    } else if (game.state === "running") {
      const m = multiplierAt(elapsed);
      if (m >= game.round.point) {
        game.currentMultiplier = game.round.point;
        drawFrame(timeForMultiplier(game.round.point), game.currentMultiplier, true);
        startCrashed();
      } else {
        game.currentMultiplier = m;
        multiplierTextEl.textContent = m.toFixed(2) + "x";
        drawFrame(elapsed, m, false);
        betPanels.forEach((p) => {
          p.checkAutoCashout();
          p.tickActive();
        });
      }
    } else if (game.state === "crashed") {
      if (elapsed >= CRASH_FREEZE_MS) startWaiting();
    }

    requestAnimationFrame(loop);
  }

  startWaiting();
  requestAnimationFrame(loop);
})();
