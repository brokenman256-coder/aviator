(() => {
  "use strict";

  const token = localStorage.getItem("zenith_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const usernamePill = document.getElementById("usernamePill");

  function logout() {
    localStorage.removeItem("zenith_token");
    localStorage.removeItem("zenith_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (res.status === 401 || res.status === 403) return logout();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function loadSelf() {
    const { user } = await api("/api/auth/me");
    usernamePill.textContent = user.username;
    if (!user.isAdmin) {
      window.location.href = "index.html";
    }
  }

  async function loadStats() {
    const stats = await api("/api/admin/stats");
    document.getElementById("statUsers").textContent = stats.userCount;
    document.getElementById("statRounds").textContent = stats.roundCount;
    document.getElementById("statWagered").textContent = stats.wagered.toFixed(2);
    document.getElementById("statPaidOut").textContent = stats.paidOut.toFixed(2);
    document.getElementById("statProfit").textContent = stats.houseProfit.toFixed(2);
  }

  async function loadUsers() {
    const { users } = await api("/api/admin/users");
    const tbody = document.getElementById("usersTableBody");
    tbody.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${u.username}${u.isAdmin ? ' <span class="pill ok">admin</span>' : ""}${u.isBanned ? ' <span class="pill bad">banned</span>' : ""}</td>
        <td>${u.balance.toFixed(2)}</td>
        <td class="row-actions">
          <button class="mini-btn" data-action="credit" data-id="${u.id}">+Credit</button>
          <button class="mini-btn" data-action="debit" data-id="${u.id}">-Debit</button>
          <button class="mini-btn" data-action="ban" data-id="${u.id}">${u.isBanned ? "Unban" : "Ban"}</button>
          <button class="mini-btn" data-action="admin" data-id="${u.id}">${u.isAdmin ? "Revoke admin" : "Make admin"}</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => onUserAction(btn.dataset.action, Number(btn.dataset.id)));
    });
  }

  async function onUserAction(action, id) {
    try {
      if (action === "credit" || action === "debit") {
        const amountStr = prompt(`Amount to ${action}:`, "100");
        if (!amountStr) return;
        const amount = Number(amountStr) * (action === "debit" ? -1 : 1);
        const reason = prompt("Reason (optional):", "") || undefined;
        await api(`/api/admin/users/${id}/adjust`, { method: "POST", body: JSON.stringify({ amount, reason }) });
      } else if (action === "ban") {
        const row = document.querySelector(`button[data-id="${id}"][data-action="ban"]`);
        const banned = row.textContent.trim() === "Ban";
        await api(`/api/admin/users/${id}/ban`, { method: "POST", body: JSON.stringify({ banned }) });
      } else if (action === "admin") {
        const row = document.querySelector(`button[data-id="${id}"][data-action="admin"]`);
        const isAdmin = row.textContent.trim() === "Make admin";
        await api(`/api/admin/users/${id}/admin`, { method: "POST", body: JSON.stringify({ isAdmin }) });
      }
      loadUsers();
      loadStats();
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadSettings() {
    const s = await api("/api/admin/settings");
    document.getElementById("settingHouseEdge").value = s.houseEdgePercent;
    document.getElementById("settingBonus").value = s.signupBonusCredits;
    document.getElementById("settingMinBet").value = s.minBet;
    document.getElementById("settingMaxBet").value = s.maxBet;
  }

  document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({
          houseEdgePercent: Number(document.getElementById("settingHouseEdge").value),
          signupBonusCredits: Number(document.getElementById("settingBonus").value),
          minBet: Number(document.getElementById("settingMinBet").value),
          maxBet: Number(document.getElementById("settingMaxBet").value),
        }),
      });
      alert("Settings saved.");
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- Trade (Zenith Markets) ----------

  async function loadTradeStats() {
    const s = await api("/api/admin/trade/stats");
    document.getElementById("tradeStatStaked").textContent = s.staked.toFixed(2);
    document.getElementById("tradeStatPaidOut").textContent = s.paidOut.toFixed(2);
    document.getElementById("tradeStatSettled").textContent = s.settledCount;
    document.getElementById("tradeStatProfit").textContent = s.houseProfit.toFixed(2);
  }

  async function loadTradeSettings() {
    const s = await api("/api/admin/trade/settings");
    document.getElementById("tradeMinStake").value = s.minStake;
    document.getElementById("tradeMaxStake").value = s.maxStake;
  }

  document.getElementById("saveTradeSettingsBtn").addEventListener("click", async () => {
    try {
      await api("/api/admin/trade/settings", {
        method: "POST",
        body: JSON.stringify({
          minStake: Number(document.getElementById("tradeMinStake").value),
          maxStake: Number(document.getElementById("tradeMaxStake").value),
        }),
      });
      alert("Trade limits saved.");
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadAssets() {
    const { assets } = await api("/api/admin/trade/assets");
    const tbody = document.getElementById("assetsTableBody");
    tbody.innerHTML = "";
    assets.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${a.symbol}</td>
        <td>${a.name}</td>
        <td>${a.price.toFixed(4)}</td>
        <td><input type="number" class="asset-payout-input" data-id="${a.id}" value="${a.payoutPercent}" style="width: 70px;"></td>
        <td><span class="pill ${a.enabled ? "ok" : "bad"}">${a.enabled ? "enabled" : "disabled"}</span></td>
        <td class="row-actions">
          <button class="mini-btn" data-action="save-payout" data-id="${a.id}">Save %</button>
          <button class="mini-btn" data-action="toggle" data-id="${a.id}" data-enabled="${a.enabled}">${a.enabled ? "Disable" : "Enable"}</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-action="save-payout"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const payoutPercent = Number(document.querySelector(`.asset-payout-input[data-id="${id}"]`).value);
        await api(`/api/admin/trade/assets/${id}`, { method: "POST", body: JSON.stringify({ payoutPercent }) });
        loadAssets();
      });
    });

    tbody.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const enabled = btn.dataset.enabled !== "true";
        await api(`/api/admin/trade/assets/${id}`, { method: "POST", body: JSON.stringify({ enabled }) });
        loadAssets();
      });
    });
  }

  document.getElementById("addAssetBtn").addEventListener("click", async () => {
    try {
      const symbol = document.getElementById("newAssetSymbol").value.trim();
      const name = document.getElementById("newAssetName").value.trim();
      const price = Number(document.getElementById("newAssetPrice").value);
      const volatility = Number(document.getElementById("newAssetVolatility").value);
      const payoutPercent = Number(document.getElementById("newAssetPayout").value);
      if (!symbol || !name || !isFinite(price)) return alert("Symbol, name, and starting price are required.");
      await api("/api/admin/trade/assets", {
        method: "POST",
        body: JSON.stringify({ symbol, name, price, volatility, payoutPercent }),
      });
      document.getElementById("newAssetSymbol").value = "";
      document.getElementById("newAssetName").value = "";
      document.getElementById("newAssetPrice").value = "";
      loadAssets();
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadAdmin() {
    await loadSelf();
    loadStats();
    loadUsers();
    loadSettings();
    loadTradeStats();
    loadTradeSettings();
    loadAssets();
  }

  loadAdmin();
})();
