(() => {
  "use strict";

  const token = localStorage.getItem("zenith_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const toastEl = document.getElementById("toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3000);
  }

  function logout() {
    localStorage.removeItem("zenith_token");
    localStorage.removeItem("zenith_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  async function api(path, options = {}) {
    const res = await fetch(`/api/admin${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) return logout();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function loadSelf() {
    const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const { user } = await res.json();
    document.getElementById("usernamePill").textContent = user.username;
    if (!user.isAdmin) {
      document.getElementById("deniedBox").classList.remove("hidden");
      return false;
    }
    document.getElementById("adminContent").classList.remove("section-hidden");
    return true;
  }

  async function loadStats() {
    const s = await api("/stats");
    document.getElementById("statUsers").textContent = s.userCount;
    document.getElementById("statRounds").textContent = s.roundCount;
    document.getElementById("statWagered").textContent = s.wagered.toFixed(2);
    document.getElementById("statPaidOut").textContent = s.paidOut.toFixed(2);
    const profitEl = document.getElementById("statProfit");
    profitEl.textContent = s.houseProfit.toFixed(2);
    profitEl.classList.toggle("positive", s.houseProfit >= 0);
    profitEl.classList.toggle("negative", s.houseProfit < 0);
    if (s.rewards) {
      document.getElementById("statWheelPaid").textContent = s.rewards.wheelPaid.toFixed(0);
      document.getElementById("statStreakPaid").textContent = s.rewards.streakPaid.toFixed(0);
      document.getElementById("statReferralPaid").textContent = s.rewards.referralPaid.toFixed(0);
      document.getElementById("statSpinsToday").textContent = s.rewards.spinsToday;
    }
  }

  async function loadSettings() {
    const s = await api("/settings");
    document.getElementById("settingSiteName").value = s.siteName || "";
    document.getElementById("settingHouseEdge").value = s.houseEdgePercent;
    document.getElementById("settingBonus").value = s.signupBonusCredits;
    document.getElementById("settingMinBet").value = s.minBet;
    document.getElementById("settingMaxBet").value = s.maxBet;
    document.getElementById("settingReferralBonus").value = s.referralBonusCredits;
    document.getElementById("settingStreakPerDay").value = s.streakBonusPerDay;
    document.getElementById("settingCreditsPerRupee").value = s.creditsPerRupee;
    document.getElementById("settingPaymentUpi").value = s.paymentUpiId || "";
    document.getElementById("settingPaymentInstructions").value = s.paymentInstructions || "";
    document.getElementById("settingWheelPrizes").value = s.wheelPrizes;
    document.getElementById("settingWheelWeights").value = s.wheelWeights;
    updateWheelAvg();
  }

  function updateWheelAvg() {
    const prizes = document.getElementById("settingWheelPrizes").value.split(",").map((n) => Number(n.trim())).filter((n) => isFinite(n));
    const weights = document.getElementById("settingWheelWeights").value.split(",").map((n) => Number(n.trim())).filter((n) => isFinite(n));
    const box = document.getElementById("wheelAvg");
    if (!prizes.length || prizes.length !== weights.length) {
      box.textContent = "Enter the same number of prizes and weights to preview the average.";
      return;
    }
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const avg = prizes.reduce((sum, p, i) => sum + p * weights[i], 0) / total;
    const jackpot = Math.max(...prizes);
    const ji = prizes.indexOf(jackpot);
    box.textContent = `Average payout ≈ ${avg.toFixed(1)} credits/spin · ${jackpot} lands ${((weights[ji] / total) * 100).toFixed(1)}% of spins.`;
  }
  document.getElementById("settingWheelPrizes").addEventListener("input", updateWheelAvg);
  document.getElementById("settingWheelWeights").addEventListener("input", updateWheelAvg);

  document.getElementById("savePaymentBtn").addEventListener("click", async () => {
    try {
      await api("/settings", {
        method: "POST",
        body: JSON.stringify({
          paymentUpiId: document.getElementById("settingPaymentUpi").value,
          paymentInstructions: document.getElementById("settingPaymentInstructions").value,
        }),
      });
      toast("Payment details saved.");
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
    try {
      await api("/settings", {
        method: "POST",
        body: JSON.stringify({
          siteName: document.getElementById("settingSiteName").value,
          houseEdgePercent: Number(document.getElementById("settingHouseEdge").value),
          signupBonusCredits: Number(document.getElementById("settingBonus").value),
          minBet: Number(document.getElementById("settingMinBet").value),
          maxBet: Number(document.getElementById("settingMaxBet").value),
          referralBonusCredits: Number(document.getElementById("settingReferralBonus").value),
          streakBonusPerDay: Number(document.getElementById("settingStreakPerDay").value),
          creditsPerRupee: Number(document.getElementById("settingCreditsPerRupee").value),
        }),
      });
      toast("Settings saved.");
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById("saveWheelBtn").addEventListener("click", async () => {
    try {
      await api("/settings", {
        method: "POST",
        body: JSON.stringify({
          wheelPrizes: document.getElementById("settingWheelPrizes").value,
          wheelWeights: document.getElementById("settingWheelWeights").value,
        }),
      });
      toast("Wheel saved.");
    } catch (err) {
      toast(err.message);
    }
  });

  async function loadLiveRound() {
    const s = await api("/live-round");
    document.getElementById("liveRoundId").textContent = s.roundId ? `#${s.roundId}` : "—";
    document.getElementById("liveState").textContent = s.state;
    document.getElementById("liveMultiplier").textContent = Number(s.multiplier).toFixed(2) + "x";
    document.getElementById("liveCrashPoint").textContent = s.crashPoint ? Number(s.crashPoint).toFixed(2) + "x" : "—";
  }

  document.getElementById("forceCrashBtn").addEventListener("click", async () => {
    try {
      await api("/round/force-crash", { method: "POST" });
      toast("Round ended.");
      await loadLiveRound();
    } catch (err) {
      toast(err.message);
    }
  });

  async function loadUsers() {
    const { users } = await api("/users");
    const tbody = document.getElementById("usersTableBody");
    tbody.innerHTML = "";
    for (const u of users) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.balance.toFixed(2)}</td>
        <td><span class="pill ${u.isBanned ? "bad" : "ok"}">${u.isBanned ? "Banned" : "Active"}</span></td>
        <td><span class="pill ${u.isAdmin ? "warn" : ""}">${u.isAdmin ? "Admin" : "Player"}</span></td>
        <td class="row-actions">
          <button class="mini-btn" data-action="view" data-id="${u.id}">View / Adjust Balance</button>
          <button class="mini-btn danger" data-action="ban" data-id="${u.id}" data-banned="${u.isBanned}">${u.isBanned ? "Unban" : "Ban"}</button>
          <button class="mini-btn" data-action="admin" data-id="${u.id}" data-isadmin="${u.isAdmin}">${u.isAdmin ? "Revoke Admin" : "Make Admin"}</button>
          <button class="mini-btn danger" data-action="delete" data-id="${u.id}" data-username="${escapeHtml(u.username)}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }

  document.getElementById("usersTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.mini-btn");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    try {
      if (action === "view") {
        await openUserModal(id);
        return;
      } else if (action === "ban") {
        const nextBanned = btn.dataset.banned !== "true";
        await api(`/users/${id}/ban`, { method: "POST", body: JSON.stringify({ banned: nextBanned }) });
      } else if (action === "admin") {
        const nextIsAdmin = btn.dataset.isadmin !== "true";
        await api(`/users/${id}/admin`, { method: "POST", body: JSON.stringify({ isAdmin: nextIsAdmin }) });
      } else if (action === "delete") {
        if (!confirm(`Permanently delete ${btn.dataset.username}? This removes their account, bets, and transaction history.`)) return;
        await api(`/users/${id}/delete`, { method: "POST" });
      }
      await Promise.all([loadUsers(), loadStats()]);
    } catch (err) {
      toast(err.message);
    }
  });

  const userModal = document.getElementById("userModal");
  document.getElementById("closeUserModal").addEventListener("click", () => userModal.classList.add("hidden"));
  userModal.addEventListener("click", (e) => { if (e.target === userModal) userModal.classList.add("hidden"); });

  let currentModalUserId = null;

  async function submitAdjustment(sign) {
    const errorBox = document.getElementById("adjustError");
    errorBox.classList.add("hidden");
    const amount = Number(document.getElementById("adjustAmount").value);
    const reason = document.getElementById("adjustReason").value.trim();
    if (!isFinite(amount) || amount <= 0) {
      errorBox.textContent = "Enter a positive amount";
      errorBox.classList.remove("hidden");
      return;
    }
    if (!reason) {
      errorBox.textContent = "Reason is required";
      errorBox.classList.remove("hidden");
      return;
    }
    try {
      await api(`/users/${currentModalUserId}/adjust`, {
        method: "POST",
        body: JSON.stringify({ amount: sign * amount, reason }),
      });
      toast(sign > 0 ? "Credited." : "Debited.");
      await Promise.all([openUserModal(currentModalUserId), loadUsers(), loadStats()]);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
    }
  }

  document.getElementById("adjustCreditBtn").addEventListener("click", () => submitAdjustment(1));
  document.getElementById("adjustDebitBtn").addEventListener("click", () => submitAdjustment(-1));

  async function openUserModal(id) {
    const data = await api(`/users/${id}`);
    currentModalUserId = data.user.id;
    document.getElementById("userModalTitle").textContent = `${data.user.username} (#${data.user.id})`;
    document.getElementById("adjustAmount").value = "";
    document.getElementById("adjustReason").value = "";
    document.getElementById("adjustError").classList.add("hidden");

    const betsBody = document.getElementById("userModalBets");
    betsBody.innerHTML = data.bets.length
      ? data.bets.map((b) => `
          <tr>
            <td>${b.round_id}</td>
            <td>${b.slot}</td>
            <td>${b.amount.toFixed(2)}</td>
            <td>${escapeHtml(b.status)}</td>
            <td>${b.cashout_multiplier ? b.cashout_multiplier.toFixed(2) + "x" : "—"}</td>
            <td>${b.payout != null ? b.payout.toFixed(2) : "—"}</td>
          </tr>`).join("")
      : `<tr><td colspan="6" style="color:var(--text-dim);">No bets yet.</td></tr>`;

    const txBody = document.getElementById("userModalTx");
    txBody.innerHTML = data.transactions.length
      ? data.transactions.map((t) => `
          <tr>
            <td>${new Date(t.created_at).toLocaleString()}</td>
            <td>${escapeHtml(t.type)}${metaReasonHtml(t)}</td>
            <td class="tx-amount ${t.amount >= 0 ? "positive" : "negative"}">${t.amount >= 0 ? "+" : ""}${t.amount.toFixed(2)}</td>
            <td>${t.balance_after.toFixed(2)}</td>
          </tr>`).join("")
      : `<tr><td colspan="4" style="color:var(--text-dim);">No activity yet.</td></tr>`;

    userModal.classList.remove("hidden");
  }

  async function loadRounds() {
    const { rounds } = await api("/rounds");
    const tbody = document.getElementById("roundsTableBody");
    tbody.innerHTML = "";
    for (const r of rounds) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.id}</td>
        <td>${r.crash_point.toFixed(2)}x</td>
        <td>${r.house_edge_percent}%</td>
        <td>${new Date(r.started_at).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function metaReasonHtml(t) {
    if (!t.meta) return "";
    try {
      const meta = JSON.parse(t.meta);
      if (meta.reason) return `<div style="font-size:11px; color:var(--text-dim); font-style:italic;">${escapeHtml(meta.reason)}</div>`;
    } catch {
      // ignore
    }
    return "";
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatRequestAmount(r) {
    if (r.type === "withdrawal") return `${Number(r.amount).toFixed(2)} cr`;
    if (r.amount_inr) return `₹${Number(r.amount_inr).toFixed(0)} → ${Number(r.amount).toFixed(2)} cr`;
    return `${Number(r.amount).toFixed(2)} cr`;
  }

  const proofModal = document.getElementById("proofModal");
  let currentProofRequestId = null;

  document.getElementById("closeProofModal").addEventListener("click", () => proofModal.classList.add("hidden"));
  proofModal.addEventListener("click", (e) => { if (e.target === proofModal) proofModal.classList.add("hidden"); });

  async function openProofModal(id) {
    currentProofRequestId = id;
    const res = await fetch(`/api/admin/recharge-requests/${id}/screenshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "No screenshot");
      return;
    }

    document.getElementById("proofModalTitle").textContent = `Payment proof #${id}`;
    const meta = [];
    if (data.amountInr) meta.push(`Paid: ₹${Number(data.amountInr).toFixed(2)}`);
    if (data.paymentReference) meta.push(`Ref: ${escapeHtml(data.paymentReference)}`);
    document.getElementById("proofMeta").innerHTML = meta.join(" · ") || "No extra details";
    document.getElementById("proofModalImg").src = `data:${data.mimeType};base64,${data.data}`;

    const actions = document.getElementById("proofActions");
    actions.innerHTML = `
      <button class="mini-btn" data-proof-action="approve" style="flex:1;">Approve</button>
      <button class="mini-btn danger" data-proof-action="reject" style="flex:1;">Reject</button>
    `;
    proofModal.classList.remove("hidden");
  }

  document.getElementById("proofActions").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-proof-action]");
    if (!btn || !currentProofRequestId) return;
    try {
      if (btn.dataset.proofAction === "approve") {
        const note = prompt("Note for this approval (optional):", "") || "";
        await api(`/recharge-requests/${currentProofRequestId}/approve`, { method: "POST", body: JSON.stringify({ note }) });
        toast("Request approved.");
      } else {
        const note = prompt("Reason for rejecting (optional):", "") || "";
        await api(`/recharge-requests/${currentProofRequestId}/reject`, { method: "POST", body: JSON.stringify({ note }) });
        toast("Request rejected.");
      }
      proofModal.classList.add("hidden");
      await Promise.all([loadRechargeRequests(), loadUsers(), loadStats()]);
    } catch (err) {
      toast(err.message);
    }
  });

  async function resolveRequest(id, action) {
    if (action === "approve") {
      const note = prompt("Note for this approval (optional):", "") || "";
      await api(`/recharge-requests/${id}/approve`, { method: "POST", body: JSON.stringify({ note }) });
      toast("Request approved.");
    } else {
      const note = prompt("Reason for rejecting (optional):", "") || "";
      await api(`/recharge-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
      toast("Request rejected.");
    }
    await Promise.all([loadRechargeRequests(), loadUsers(), loadStats()]);
  }

  async function loadRechargeRequests() {
    const { requests } = await api("/recharge-requests");
    const tbody = document.getElementById("rechargeTableBody");
    tbody.innerHTML = requests.length
      ? requests.map((r) => {
          const proofBtn = r.hasScreenshot
            ? `<button class="mini-btn" data-action="view-proof" data-id="${r.id}">View proof</button>`
            : "";
          const actionBtns = r.status === "pending"
            ? `${proofBtn}
               <button class="mini-btn" data-action="recharge-approve" data-id="${r.id}">Approve</button>
               <button class="mini-btn danger" data-action="recharge-reject" data-id="${r.id}">Reject</button>`
            : (proofBtn || "—");
          return `
          <tr>
            <td>${r.id}</td>
            <td>${escapeHtml(r.username)}</td>
            <td><span class="pill ${r.type === "withdrawal" ? "bad" : "ok"}">${r.type === "withdrawal" ? "Withdrawal" : "Add funds"}</span></td>
            <td>${formatRequestAmount(r)}</td>
            <td style="font-size:11px;">${escapeHtml(r.payment_reference || "—")}</td>
            <td><span class="pill ${r.status === "pending" ? "warn" : r.status === "approved" ? "ok" : "bad"}">${escapeHtml(r.status)}</span></td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td class="row-actions">${actionBtns}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="8" style="color:var(--text-dim);">No requests yet.</td></tr>`;
  }

  document.getElementById("rechargeTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.mini-btn");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    try {
      if (action === "view-proof") {
        await openProofModal(id);
      } else if (action === "recharge-approve" || action === "recharge-reject") {
        await resolveRequest(id, action === "recharge-approve" ? "approve" : "reject");
      }
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Zenith Markets trade module ----------

  async function loadTradeStats() {
    const s = await api("/trade/stats");
    document.getElementById("tradeStatStaked").textContent = s.staked.toFixed(2);
    document.getElementById("tradeStatPaidOut").textContent = s.paidOut.toFixed(2);
    document.getElementById("tradeStatSettled").textContent = s.settledCount;
    document.getElementById("tradeStatProfit").textContent = s.houseProfit.toFixed(2);
  }

  async function loadTradeSettings() {
    const s = await api("/trade/settings");
    document.getElementById("tradeMinStake").value = s.minStake;
    document.getElementById("tradeMaxStake").value = s.maxStake;
  }

  document.getElementById("saveTradeSettingsBtn").addEventListener("click", async () => {
    try {
      await api("/trade/settings", {
        method: "POST",
        body: JSON.stringify({
          minStake: Number(document.getElementById("tradeMinStake").value),
          maxStake: Number(document.getElementById("tradeMaxStake").value),
        }),
      });
      toast("Trade limits saved.");
    } catch (err) {
      toast(err.message);
    }
  });

  async function loadAssets() {
    const { assets } = await api("/trade/assets");
    const tbody = document.getElementById("assetsTableBody");
    tbody.innerHTML = assets.map((a) => `
      <tr>
        <td>${escapeHtml(a.symbol)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${a.price.toFixed(4)}</td>
        <td><input type="number" class="asset-payout-input" data-id="${a.id}" value="${a.payoutPercent}" style="width: 70px;"></td>
        <td><span class="pill ${a.enabled ? "ok" : "bad"}">${a.enabled ? "enabled" : "disabled"}</span></td>
        <td class="row-actions">
          <button class="mini-btn" data-action="save-payout" data-id="${a.id}">Save %</button>
          <button class="mini-btn" data-action="toggle-asset" data-id="${a.id}" data-enabled="${a.enabled}">${a.enabled ? "Disable" : "Enable"}</button>
        </td>
      </tr>
    `).join("");
  }

  document.getElementById("assetsTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.mini-btn");
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.action === "save-payout") {
        const payoutPercent = Number(document.querySelector(`.asset-payout-input[data-id="${id}"]`).value);
        await api(`/trade/assets/${id}`, { method: "POST", body: JSON.stringify({ payoutPercent }) });
      } else if (btn.dataset.action === "toggle-asset") {
        const enabled = btn.dataset.enabled !== "true";
        await api(`/trade/assets/${id}`, { method: "POST", body: JSON.stringify({ enabled }) });
      }
      loadAssets();
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById("addAssetBtn").addEventListener("click", async () => {
    try {
      const symbol = document.getElementById("newAssetSymbol").value.trim();
      const name = document.getElementById("newAssetName").value.trim();
      const price = Number(document.getElementById("newAssetPrice").value);
      const volatility = Number(document.getElementById("newAssetVolatility").value);
      const payoutPercent = Number(document.getElementById("newAssetPayout").value);
      if (!symbol || !name || !isFinite(price)) return toast("Symbol, name, and starting price are required.");
      await api("/trade/assets", { method: "POST", body: JSON.stringify({ symbol, name, price, volatility, payoutPercent }) });
      document.getElementById("newAssetSymbol").value = "";
      document.getElementById("newAssetName").value = "";
      document.getElementById("newAssetPrice").value = "";
      loadAssets();
    } catch (err) {
      toast(err.message);
    }
  });

  (async () => {
    const isAdmin = await loadSelf();
    if (!isAdmin) return;
    await Promise.all([
      loadStats(),
      loadSettings(),
      loadUsers(),
      loadRounds(),
      loadLiveRound(),
      loadRechargeRequests(),
      loadTradeStats(),
      loadTradeSettings(),
      loadAssets(),
    ]);
    setInterval(() => {
      loadStats().catch(() => {});
      loadUsers().catch(() => {});
      loadRounds().catch(() => {});
      loadRechargeRequests().catch(() => {});
      loadTradeStats().catch(() => {});
      loadAssets().catch(() => {});
    }, 8000);
    setInterval(() => {
      loadLiveRound().catch(() => {});
    }, 1500);
  })();
})();
