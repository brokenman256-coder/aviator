(() => {
  "use strict";

  const token = localStorage.getItem("zenith_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const POLL_MS = 1000;
  const HISTORY_POINTS = 120;

  const balanceEl = document.getElementById("balanceValue");
  const usernamePill = document.getElementById("usernamePill");
  const adminLink = document.getElementById("adminLink");
  const assetTabsEl = document.getElementById("assetTabs");
  const assetNameEl = document.getElementById("assetName");
  const priceValueEl = document.getElementById("priceValue");
  const payoutNoteEl = document.getElementById("payoutNote");
  const stakeInput = document.getElementById("stakeInput");
  const durationRow = document.getElementById("durationRow");
  const upBtn = document.getElementById("upBtn");
  const downBtn = document.getElementById("downBtn");
  const upPayoutEl = document.getElementById("upPayout");
  const downPayoutEl = document.getElementById("downPayout");
  const openContractsEl = document.getElementById("openContracts");
  const contractHistoryEl = document.getElementById("contractHistory");
  const toastEl = document.getElementById("toast");

  function setBalance(v) {
    balanceEl.textContent = Number(v).toFixed(2);
  }

  function logout() {
    localStorage.removeItem("zenith_token");
    localStorage.removeItem("zenith_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      logout();
      throw new Error("Session expired");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function loadSelf() {
    const { user } = await api("/api/auth/me");
    usernamePill.textContent = user.username;
    setBalance(user.balance);
    if (user.isAdmin) adminLink.classList.remove("section-hidden");
  }

  // ---------- State ----------
  let assets = [];
  let activeSymbol = null;
  let activeDuration = 60;
  let stake = Number(stakeInput.value) || 50;
  const priceHistory = new Map(); // symbol -> [{t, price}]
  const openContracts = new Map(); // contractId -> { symbol, direction, stake, closesAt }

  function assetBySymbol(symbol) {
    return assets.find((a) => a.symbol === symbol);
  }

  function renderAssetTabs() {
    assetTabsEl.innerHTML = "";
    assets.forEach((asset) => {
      const tab = document.createElement("button");
      tab.className = "asset-tab" + (asset.symbol === activeSymbol ? " active" : "");
      tab.innerHTML = `${asset.name}<span class="asset-tab-price" data-symbol="${asset.symbol}">${formatPrice(asset.price)}</span>`;
      tab.addEventListener("click", () => selectAsset(asset.symbol));
      assetTabsEl.appendChild(tab);
    });
  }

  function formatPrice(p) {
    return p >= 100 ? p.toFixed(2) : p.toFixed(4);
  }

  function selectAsset(symbol) {
    activeSymbol = symbol;
    renderAssetTabs();
    renderActiveAsset();
  }

  function renderActiveAsset() {
    const asset = assetBySymbol(activeSymbol);
    if (!asset) return;
    assetNameEl.textContent = asset.name;
    priceValueEl.textContent = formatPrice(asset.price);
    payoutNoteEl.textContent = `Payout: ${asset.payoutPercent}%`;
    updatePayoutButtons();
    drawChart();
  }

  function updatePayoutButtons() {
    const asset = assetBySymbol(activeSymbol);
    if (!asset) return;
    const win = Math.round(stake * (1 + asset.payoutPercent / 100) * 100) / 100;
    upPayoutEl.textContent = `win ${win.toFixed(2)}`;
    downPayoutEl.textContent = `win ${win.toFixed(2)}`;
  }

  // ---------- Stake controls ----------
  function setStake(v) {
    stake = Math.max(1, Math.round(v * 100) / 100);
    stakeInput.value = stake;
    updatePayoutButtons();
  }

  document.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setStake(stake + (btn.dataset.action === "inc" ? 1 : -1));
    });
  });

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.preset;
      if (p === "half") setStake(stake / 2);
      else if (p === "double") setStake(stake * 2);
      else setStake(Number(p));
    });
  });

  stakeInput.addEventListener("input", () => {
    const v = Number(stakeInput.value);
    setStake(isFinite(v) && v > 0 ? v : 1);
  });

  durationRow.querySelectorAll(".duration-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      durationRow.querySelectorAll(".duration-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeDuration = Number(btn.dataset.duration);
    });
  });

  // ---------- Trade actions ----------
  async function openTrade(direction) {
    if (!activeSymbol) return;
    try {
      const result = await api("/api/trade/open", {
        method: "POST",
        body: JSON.stringify({ symbol: activeSymbol, direction, stake, durationSec: activeDuration }),
      });
      setBalance(result.balance);
      openContracts.set(result.contractId, result);
      renderOpenContracts();
      toast(`Trade opened: ${result.direction.toUpperCase()} ${result.symbol} for ${result.stake.toFixed(2)}`);
    } catch (err) {
      toast(err.message);
    }
  }
  upBtn.addEventListener("click", () => openTrade("up"));
  downBtn.addEventListener("click", () => openTrade("down"));

  // ---------- Open contracts / history rendering ----------
  function renderOpenContracts() {
    if (openContracts.size === 0) {
      openContractsEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No open trades.</p>';
      return;
    }
    openContractsEl.innerHTML = "";
    for (const c of openContracts.values()) {
      const remainMs = Math.max(0, new Date(c.closesAt).getTime() - Date.now());
      const card = document.createElement("div");
      card.className = "contract-card";
      card.innerHTML = `
        <span class="contract-dir ${c.direction}">${c.direction === "up" ? "▲" : "▼"} ${c.symbol}</span>
        <span>${c.stake.toFixed(2)} credits</span>
        <span class="contract-result pending">${Math.ceil(remainMs / 1000)}s left</span>
      `;
      openContractsEl.appendChild(card);
    }
  }

  function pushHistoryCard(result) {
    const placeholder = contractHistoryEl.querySelector("p");
    if (placeholder) placeholder.remove();

    const card = document.createElement("div");
    card.className = `contract-card ${result.won ? "won" : "lost"}`;
    card.innerHTML = `
      <span class="contract-dir ${result.direction}">${result.direction === "up" ? "▲" : "▼"} ${result.symbol}</span>
      <span>${result.stake.toFixed(2)} credits</span>
      <span class="contract-result ${result.won ? "won" : "lost"}">${result.won ? "+" + result.payout.toFixed(2) : "-" + result.stake.toFixed(2)}</span>
    `;
    contractHistoryEl.insertBefore(card, contractHistoryEl.firstChild);
    while (contractHistoryEl.children.length > 20) contractHistoryEl.removeChild(contractHistoryEl.lastChild);
  }

  async function loadHistory() {
    try {
      const { contracts } = await api("/api/trade/history");
      contractHistoryEl.innerHTML = "";
      contracts
        .filter((c) => c.status !== "open")
        .forEach((c) => {
          pushHistoryCard({ symbol: c.symbol, direction: c.direction, stake: c.stake, won: c.status === "won", payout: c.payout || 0 });
        });
      if (contractHistoryEl.children.length === 0) {
        contractHistoryEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No trades yet.</p>';
      }
    } catch {
      // non-fatal — history is a convenience view
    }
  }

  // ---------- Chart ----------
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

  function drawChart() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const points = priceHistory.get(activeSymbol) || [];
    if (points.length < 2) return;

    const padding = 24;
    const prices = points.map((p) => p.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const span = Math.max(maxP - minP, maxP * 0.0005, 0.0001);

    const toX = (i) => padding + (i / (points.length - 1)) * (w - padding * 2);
    const toY = (p) => h - padding - ((p - minP) / span) * (h - padding * 2);

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = padding + ((h - padding * 2) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(w - padding, y);
      ctx.stroke();
    }

    const rising = prices[prices.length - 1] >= prices[0];
    const lineColor = rising ? "#3fb374" : "#e2453f";

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = toX(i);
      const y = toY(p.price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(toX(points.length - 1), h - padding);
    ctx.lineTo(toX(0), h - padding);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, rising ? "rgba(63,179,116,0.25)" : "rgba(226,69,63,0.25)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = toX(i);
      const y = toY(p.price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // ---------- Polling ----------
  let polling = false;
  async function pollState() {
    if (polling) return;
    polling = true;
    try {
      const { prices, openContracts: serverOpen, justSettled } = await api("/api/trade/state");

      const now = Date.now();
      for (const [symbol, price] of Object.entries(prices)) {
        const asset = assetBySymbol(symbol);
        if (asset) asset.price = price;

        let hist = priceHistory.get(symbol);
        if (!hist) {
          hist = [];
          priceHistory.set(symbol, hist);
        }
        hist.push({ t: now, price });
        if (hist.length > HISTORY_POINTS) hist.shift();
      }

      if (activeSymbol) renderActiveAsset();
      assets.forEach((a) => {
        const el = document.querySelector(`.asset-tab-price[data-symbol="${a.symbol}"]`);
        if (el) el.textContent = formatPrice(a.price);
      });

      // Reconcile open contracts with the server's view (covers a settlement
      // driven by someone else's poll, not just this tab's own actions).
      const serverIds = new Set(serverOpen.map((c) => c.contractId));
      for (const id of Array.from(openContracts.keys())) {
        if (!serverIds.has(id)) openContracts.delete(id);
      }
      serverOpen.forEach((c) => openContracts.set(c.contractId, c));
      renderOpenContracts();

      justSettled.forEach((result) => {
        setBalance(result.balance);
        pushHistoryCard(result);
        toast(result.won ? `Won! +${result.payout.toFixed(2)} on ${result.symbol}` : `Lost ${result.stake.toFixed(2)} on ${result.symbol}`);
      });
    } catch (err) {
      if (err.message !== "Session expired") toast(err.message);
    } finally {
      polling = false;
    }
  }

  // ---------- Boot ----------
  async function boot() {
    await loadSelf();
    const { assets: list } = await api("/api/trade/assets");
    assets = list;
    if (assets.length > 0) activeSymbol = assets[0].symbol;
    renderAssetTabs();
    renderActiveAsset();
    await loadHistory();
    await pollState();
    setInterval(pollState, POLL_MS);
  }
  boot();

  setInterval(renderOpenContracts, 1000);
})();
