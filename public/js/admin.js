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
          minBet: Number(document.getElementById("settingMinBet").value),
          maxBet: Number(document.getElementById("settingMaxBet").value),
        }),
      });
      toast("Settings saved.");
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
          <button class="mini-btn" data-action="credit" data-id="${u.id}">+ Credit</button>
          <button class="mini-btn" data-action="debit" data-id="${u.id}">− Debit</button>
          <button class="mini-btn danger" data-action="ban" data-id="${u.id}" data-banned="${u.isBanned}">${u.isBanned ? "Unban" : "Ban"}</button>
          <button class="mini-btn" data-action="admin" data-id="${u.id}" data-isadmin="${u.isAdmin}">${u.isAdmin ? "Revoke Admin" : "Make Admin"}</button>
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
      if (action === "credit" || action === "debit") {
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
      }
      await Promise.all([loadUsers(), loadStats()]);
    } catch (err) {
      toast(err.message);
    }
  });

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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  (async () => {
    const isAdmin = await loadSelf();
    if (!isAdmin) return;
    await Promise.all([loadStats(), loadSettings(), loadUsers(), loadRounds()]);
    setInterval(() => {
      loadStats().catch(() => {});
      loadUsers().catch(() => {});
      loadRounds().catch(() => {});
    }, 8000);
  })();
})();
