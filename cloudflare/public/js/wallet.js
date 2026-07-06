(() => {
  "use strict";

  const token = localStorage.getItem("aviator_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  function logout() {
    localStorage.removeItem("aviator_token");
    localStorage.removeItem("aviator_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  const TYPE_LABELS = {
    bet: "Bet placed",
    bet_cancel: "Bet cancelled",
    payout: "Cash out",
    signup_bonus: "Signup bonus",
    admin_adjust: "Admin adjustment",
    recharge_approved: "Funds added",
    withdrawal_approved: "Withdrawal",
  };

  const STATUS_PILL = { pending: "warn", approved: "ok", rejected: "bad" };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function load() {
    const res = await fetch("/api/wallet/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const { user, transactions } = await res.json();

    document.getElementById("usernamePill").textContent = user.username;
    document.getElementById("walletBalance").textContent = Number(user.balance).toFixed(2);

    const tbody = document.getElementById("txTableBody");
    tbody.innerHTML = "";
    for (const tx of transactions) {
      const tr = document.createElement("tr");
      const amount = Number(tx.amount);
      const sign = amount >= 0 ? "+" : "";
      const label = TYPE_LABELS[tx.type] || escapeHtml(tx.type);
      tr.innerHTML = `
        <td>${new Date(tx.created_at).toLocaleString()}</td>
        <td class="tx-type">${label}</td>
        <td class="tx-amount ${amount >= 0 ? "positive" : "negative"}">${sign}${amount.toFixed(2)}</td>
        <td>${Number(tx.balance_after).toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    }

    if (transactions.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" style="color:var(--text-dim);">No activity yet.</td>`;
      tbody.appendChild(tr);
    }
  }

  async function loadRechargeRequests() {
    const res = await fetch("/api/wallet/recharge-requests", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { requests } = await res.json();
    const tbody = document.getElementById("rechargeTableBody");
    tbody.innerHTML = requests.length
      ? requests.map((r) => `
          <tr>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.type === "withdrawal" ? "Withdrawal" : "Add funds"}</td>
            <td>${Number(r.amount).toFixed(2)}</td>
            <td><span class="pill ${STATUS_PILL[r.status] || ""}">${escapeHtml(r.status)}</span></td>
          </tr>`).join("")
      : `<tr><td colspan="4" style="color:var(--text-dim);">No requests yet.</td></tr>`;
  }

  async function submitFundRequest(type, amountInputId, errorBoxId) {
    const errorBox = document.getElementById(errorBoxId);
    errorBox.classList.add("hidden");
    const amountInput = document.getElementById(amountInputId);
    const amount = Number(amountInput.value);
    if (!isFinite(amount) || amount <= 0) {
      errorBox.textContent = "Enter a valid amount";
      errorBox.classList.remove("hidden");
      return;
    }
    try {
      const res = await fetch("/api/wallet/recharge-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount, type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      amountInput.value = "";
      await loadRechargeRequests();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
    }
  }

  document.getElementById("submitRechargeBtn").addEventListener("click", () => {
    submitFundRequest("recharge", "rechargeAmount", "rechargeError");
  });

  document.getElementById("submitWithdrawBtn").addEventListener("click", () => {
    submitFundRequest("withdrawal", "withdrawAmount", "withdrawError");
  });

  load();
  loadRechargeRequests();
})();
