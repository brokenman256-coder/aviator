(() => {
  "use strict";

  const token = localStorage.getItem("aviator_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  let razorpayConfig = null;

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
    razorpay_topup: "Online payment",
    daily_wheel: "Daily wheel",
    streak_bonus: "Streak bonus",
    referral_bonus: "Referral bonus",
  };

  const STATUS_PILL = { pending: "warn", approved: "ok", rejected: "bad" };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function showError(boxId, message) {
    const box = document.getElementById(boxId);
    box.textContent = message;
    box.classList.remove("hidden");
  }

  function hideError(boxId) {
    document.getElementById(boxId).classList.add("hidden");
  }

  function updateCreditsPreview() {
    const preview = document.getElementById("creditsPreview");
    if (!razorpayConfig?.configured) return;
    const amount = Number(document.getElementById("onlinePayAmount").value);
    if (!isFinite(amount) || amount <= 0) {
      preview.textContent = "";
      return;
    }
    const credits = Math.round(amount * razorpayConfig.creditsPerRupee * 100) / 100;
    preview.textContent = `You'll receive ${credits.toFixed(2)} credits`;
  }

  async function loadRazorpayConfig() {
    const res = await fetch("/api/wallet/razorpay/config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    razorpayConfig = await res.json();
    if (!razorpayConfig.configured) {
      document.getElementById("onlinePayPanel").style.display = "none";
    }
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
    hideError(errorBoxId);
    const amountInput = document.getElementById(amountInputId);
    const amount = Number(amountInput.value);
    if (!isFinite(amount) || amount <= 0) {
      showError(errorBoxId, "Enter a valid amount");
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
      showError(errorBoxId, err.message);
    }
  }

  async function payOnline() {
    hideError("onlinePayError");
    if (!razorpayConfig?.configured) {
      showError("onlinePayError", "Online payments are not available");
      return;
    }
    if (typeof Razorpay === "undefined") {
      showError("onlinePayError", "Payment gateway is still loading");
      return;
    }

    const amountInr = Number(document.getElementById("onlinePayAmount").value);
    if (!isFinite(amountInr) || amountInr < 10) {
      showError("onlinePayError", "Minimum payment is ₹10");
      return;
    }

    const btn = document.getElementById("payOnlineBtn");
    btn.disabled = true;
    btn.textContent = "Opening...";

    try {
      const orderRes = await fetch("/api/wallet/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountInr }),
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok) throw new Error(orderData.error || "Could not start payment");

      const meRes = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      let username = "";
      let email = "";
      if (meRes?.ok) {
        const meData = await meRes.json();
        username = meData.user?.username || "";
        email = meData.user?.email || "";
      }

      const rzp = new Razorpay({
        key: orderData.keyId,
        amount: orderData.amountPaise,
        currency: "INR",
        name: "SkyDash",
        description: `Add ${orderData.creditsToAdd} credits`,
        order_id: orderData.razorpayOrderId,
        prefill: { name: username, email },
        theme: { color: "#22c55e" },
        handler: async (response) => {
          const verifyRes = await fetch("/api/wallet/razorpay/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyRes.ok) {
            showError("onlinePayError", verifyData.error || "Payment verification failed");
            return;
          }
          document.getElementById("onlinePayAmount").value = "";
          updateCreditsPreview();
          await load();
        },
      });

      rzp.on("payment.failed", (response) => {
        showError("onlinePayError", response.error?.description || "Payment failed");
      });

      rzp.open();
    } catch (err) {
      showError("onlinePayError", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Pay now";
    }
  }

  document.getElementById("submitRechargeBtn").addEventListener("click", () => {
    submitFundRequest("recharge", "rechargeAmount", "rechargeError");
  });

  document.getElementById("submitWithdrawBtn").addEventListener("click", () => {
    submitFundRequest("withdrawal", "withdrawAmount", "withdrawError");
  });

  document.getElementById("payOnlineBtn").addEventListener("click", payOnline);
  document.getElementById("onlinePayAmount").addEventListener("input", updateCreditsPreview);

  loadRazorpayConfig().then(updateCreditsPreview);
  load();
  loadRechargeRequests();
})();
