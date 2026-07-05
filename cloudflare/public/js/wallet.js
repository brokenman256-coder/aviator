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
    referral_bonus: "Referral bonus",
  };

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
    if (user.referralCode) {
      document.getElementById("referralLink").value = `${location.origin}/login.html?ref=${user.referralCode}`;
    }

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

  document.getElementById("copyReferralBtn").addEventListener("click", async () => {
    const input = document.getElementById("referralLink");
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      const btn = document.getElementById("copyReferralBtn");
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = original), 1500);
    } catch {
      // clipboard API unavailable (e.g. insecure context) — the field is
      // selected above so the user can still copy manually with Ctrl/Cmd+C.
    }
  });

  load();
})();
