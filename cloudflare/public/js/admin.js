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
  }

  async function loadSettings() {
    const s = await api("/settings");
    document.getElementById("settingHouseEdge").value = s.houseEdgePercent;
    document.getElementById("settingBonus").value = s.signupBonusCredits;
    document.getElementById("settingReferralBonus").value = s.referralBonusCredits;
    document.getElementById("settingMinBet").value = s.minBet;
    document.getElementById("settingMaxBet").value = s.maxBet;
  }

  document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
    try {
      await api("/settings", {
        method: "POST",
        body: JSON.stringify({
          houseEdgePercent: Number(document.getElementById("settingHouseEdge").value),
          signupBonusCredits: Number(document.getElementById("settingBonus").value),
          referralBonusCredits: Number(document.getElementById("settingReferralBonus").value),
          minBet: Number(document.getElementById("settingMinBet").value),
          maxBet: Number(document.getElementById("settingMaxBet").value),
        }),
      });
      toast("Settings saved.");
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- Live round ----------
  async function loadLiveRound() {
    const s = await api("/live-round");
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
        <td><span class="pill ${u.isVerified ? "ok" : "warn"}">${u.isVerified ? "Verified" : "Pending"}</span></td>
        <td><span class="pill ${u.isBanned ? "bad" : "ok"}">${u.isBanned ? "Banned" : "Active"}</span></td>
        <td><span class="pill ${u.isAdmin ? "warn" : ""}">${u.isAdmin ? "Admin" : "Player"}</span></td>
        <td class="row-actions">
          <button class="mini-btn" data-action="view" data-id="${u.id}">View</button>
          <button class="mini-btn" data-action="credit" data-id="${u.id}">+ Credit</button>
          <button class="mini-btn" data-action="debit" data-id="${u.id}">− Debit</button>
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
      } else if (action === "credit" || action === "debit") {
        const amountStr = prompt(`Amount of credits to ${action === "credit" ? "add" : "remove"}:`, "100");
        if (!amountStr) return;
        const amount = Number(amountStr);
        if (!isFinite(amount) || amount <= 0) return toast("Enter a positive number");
        const reason = prompt("Reason (optional):", "") || "";
        await api(`/users/${id}/adjust`, {
          method: "POST",
          body: JSON.stringify({ amount: action === "credit" ? amount : -amount, reason }),
        });
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

  async function openUserModal(id) {
    const data = await api(`/users/${id}`);
    document.getElementById("userModalTitle").textContent = `${data.user.username} (#${data.user.id})`;

    const refBox = document.getElementById("userModalReferrals");
    const parts = [];
    parts.push(`Referral code: <code>${escapeHtml(data.user.referralCode || "—")}</code>`);
    if (data.referredUsers.length) {
      parts.push(`Referred ${data.referredUsers.length} user(s): ${data.referredUsers.map((u) => escapeHtml(u.username)).join(", ")}`);
    }
    refBox.innerHTML = parts.join(" &nbsp;·&nbsp; ");

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
            <td>${escapeHtml(t.type)}</td>
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

  async function loadActivity() {
    const { transactions } = await api("/transactions?limit=100");
    const tbody = document.getElementById("activityTableBody");
    tbody.innerHTML = transactions.length
      ? transactions.map((t) => `
          <tr>
            <td>${new Date(t.created_at).toLocaleString()}</td>
            <td>${escapeHtml(t.username)}</td>
            <td>${escapeHtml(t.type)}</td>
            <td class="tx-amount ${t.amount >= 0 ? "positive" : "negative"}">${t.amount >= 0 ? "+" : ""}${t.amount.toFixed(2)}</td>
            <td>${t.balance_after.toFixed(2)}</td>
          </tr>`).join("")
      : `<tr><td colspan="5" style="color:var(--text-dim);">No activity yet.</td></tr>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  (async () => {
    const isAdmin = await loadSelf();
    if (!isAdmin) return;
    await Promise.all([loadStats(), loadSettings(), loadUsers(), loadRounds(), loadActivity(), loadLiveRound()]);
    setInterval(() => {
      loadStats().catch(() => {});
      loadUsers().catch(() => {});
      loadRounds().catch(() => {});
      loadActivity().catch(() => {});
    }, 8000);
    setInterval(() => {
      loadLiveRound().catch(() => {});
    }, 1500);
  })();
})();
