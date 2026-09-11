(() => {
  "use strict";

  const token = localStorage.getItem("zenith_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const balanceEl = document.getElementById("walletBalance");
  const usernamePill = document.getElementById("usernamePill");
  const adminLink = document.getElementById("adminLink");
  const txHistoryEl = document.getElementById("txHistory");
  const toastEl = document.getElementById("toast");

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

  function renderTransactions(transactions) {
    if (!transactions.length) {
      txHistoryEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No transactions yet.</p>';
      return;
    }
    txHistoryEl.innerHTML = "";
    transactions.forEach((tx) => {
      const row = document.createElement("div");
      row.className = "contract-card";
      const positive = tx.amount >= 0;
      row.innerHTML = `
        <span class="tx-type">${tx.type.replace(/_/g, " ")}</span>
        <span class="tx-amount ${positive ? "positive" : "negative"}">${positive ? "+" : ""}${tx.amount.toFixed(2)}</span>
        <span>${new Date(tx.created_at).toLocaleString()}</span>
      `;
      txHistoryEl.appendChild(row);
    });
  }

  async function loadWallet() {
    const res = await fetch("/api/wallet/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const { user, transactions } = await res.json();
    balanceEl.textContent = Number(user.balance).toFixed(2);
    usernamePill.textContent = user.username;
    if (user.isAdmin) adminLink.classList.remove("section-hidden");
    renderTransactions(transactions);
  }

  document.getElementById("submitWithdrawBtn").addEventListener("click", () => {
    toast("Withdrawals aren't available yet — this is a placeholder for a future payment integration.");
  });

  loadWallet();
})();
