(() => {
  "use strict";

  const token = localStorage.getItem("aviator_token");
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
    localStorage.removeItem("aviator_token");
    localStorage.removeItem("aviator_user");
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
    document.getElementById("settingWheelPrizes").value = s.wheelPrizes;
    document.getElementById("settingWheelWeights").value = s.wheelWeights;
    updateWheelAvg();
  }

  // Shows the expected average payout per spin from the current prizes/weights,
  // so the admin can see at a glance whether the wheel is too generous.
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

  // ---------- Live round ----------
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

  // ---------- User drill-down modal ----------
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
      // meta wasn't JSON or had no reason field — nothing to show
    }
    return "";
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- Fund requests ----------
  async function loadRechargeRequests() {
    const { requests } = await api("/recharge-requests");
    const tbody = document.getElementById("rechargeTableBody");
    tbody.innerHTML = requests.length
      ? requests.map((r) => `
          <tr>
            <td>${r.id}</td>
            <td>${escapeHtml(r.username)}</td>
            <td><span class="pill ${r.type === "withdrawal" ? "bad" : "ok"}">${r.type === "withdrawal" ? "Withdrawal" : "Add funds"}</span></td>
            <td>${Number(r.amount).toFixed(2)}</td>
            <td><span class="pill ${r.status === "pending" ? "warn" : r.status === "approved" ? "ok" : "bad"}">${escapeHtml(r.status)}</span></td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td class="row-actions">
              ${r.status === "pending"
                ? `<button class="mini-btn" data-action="recharge-approve" data-id="${r.id}">Approve</button>
                   <button class="mini-btn danger" data-action="recharge-reject" data-id="${r.id}">Reject</button>`
                : "—"}
            </td>
          </tr>`).join("")
      : `<tr><td colspan="7" style="color:var(--text-dim);">No requests yet.</td></tr>`;
  }

  document.getElementById("rechargeTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.mini-btn");
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.action === "recharge-approve") {
        const note = prompt("Note for this approval (optional):", "") || "";
        await api(`/recharge-requests/${id}/approve`, { method: "POST", body: JSON.stringify({ note }) });
        toast("Request approved.");
      } else if (btn.dataset.action === "recharge-reject") {
        const note = prompt("Reason for rejecting (optional):", "") || "";
        await api(`/recharge-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) });
        toast("Request rejected.");
      }
      await Promise.all([loadRechargeRequests(), loadUsers(), loadStats()]);
    } catch (err) {
      toast(err.message);
    }
  });

  (async () => {
    const isAdmin = await loadSelf();
    if (!isAdmin) return;
    await Promise.all([loadStats(), loadSettings(), loadUsers(), loadRounds(), loadLiveRound(), loadRechargeRequests()]);
    setInterval(() => {
      loadStats().catch(() => {});
      loadUsers().catch(() => {});
      loadRounds().catch(() => {});
      loadRechargeRequests().catch(() => {});
    }, 8000);
    setInterval(() => {
      loadLiveRound().catch(() => {});
    }, 1500);
  })();
})();
