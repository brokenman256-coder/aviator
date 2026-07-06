(() => {
  "use strict";

  const token = localStorage.getItem("aviator_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  let paymentInfo = null;
  let screenshotFile = null;

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
    if (!paymentInfo) return;
    const amount = Number(document.getElementById("rechargeAmountInr").value);
    if (!isFinite(amount) || amount <= 0) {
      preview.textContent = "";
      return;
    }
    const credits = Math.round(amount * paymentInfo.creditsPerRupee * 100) / 100;
    preview.textContent = `You'll receive ${credits.toFixed(2)} credits after approval`;
  }

  function renderPaymentDetails() {
    const box = document.getElementById("paymentDetails");
    if (!paymentInfo) {
      box.textContent = "Loading payment details...";
      return;
    }
    const parts = [];
    if (paymentInfo.upiId) {
      parts.push(`<strong>UPI ID:</strong> <span style="color:var(--accent-green,#22c55e);">${escapeHtml(paymentInfo.upiId)}</span>`);
    }
    if (paymentInfo.instructions) {
      parts.push(escapeHtml(paymentInfo.instructions));
    }
    if (!parts.length) {
      parts.push("Ask admin to configure payment details in the admin panel.");
    }
    box.innerHTML = parts.join("<br>");
  }

  async function loadPaymentInfo() {
    const res = await fetch("/api/wallet/payment-info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    paymentInfo = await res.json();
    renderPaymentDetails();
    updateCreditsPreview();
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
      ? requests.map((r) => {
          const amountLabel = r.type === "withdrawal"
            ? `${Number(r.amount).toFixed(2)} credits`
            : r.amount_inr
              ? `₹${Number(r.amount_inr).toFixed(0)} → ${Number(r.amount).toFixed(2)} cr`
              : `${Number(r.amount).toFixed(2)} credits`;
          const proofBtn = r.hasScreenshot
            ? `<button class="mini-btn" data-view-proof="${r.id}">View</button>`
            : "";
          return `
          <tr>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.type === "withdrawal" ? "Withdrawal" : "Add funds"}</td>
            <td>${amountLabel}</td>
            <td><span class="pill ${STATUS_PILL[r.status] || ""}">${escapeHtml(r.status)}</span></td>
            <td>${proofBtn}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="5" style="color:var(--text-dim);">No requests yet.</td></tr>`;
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const base64 = result.includes(",") ? result.split(",")[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error("Could not read image"));
      reader.readAsDataURL(file);
    });
  }

  document.getElementById("screenshotInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    screenshotFile = file || null;
    const preview = document.getElementById("screenshotPreview");
    if (!file) {
      preview.classList.add("hidden");
      preview.innerHTML = "";
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      showError("rechargeError", "Screenshot must be under 1.5 MB");
      e.target.value = "";
      screenshotFile = null;
      preview.classList.add("hidden");
      return;
    }
    hideError("rechargeError");
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="Preview" style="max-width:100%; max-height:160px; border-radius:8px; margin-top:8px;" />`;
    preview.classList.remove("hidden");
  });

  async function submitRecharge() {
    hideError("rechargeError");
    const amountInr = Number(document.getElementById("rechargeAmountInr").value);
    if (!isFinite(amountInr) || amountInr < (paymentInfo?.minAmountInr || 10)) {
      showError("rechargeError", `Minimum payment is ₹${paymentInfo?.minAmountInr || 10}`);
      return;
    }
    if (!screenshotFile) {
      showError("rechargeError", "Upload a payment screenshot");
      return;
    }

    const btn = document.getElementById("submitRechargeBtn");
    btn.disabled = true;
    btn.textContent = "Submitting...";

    try {
      const screenshot = await readFileAsBase64(screenshotFile);
      const res = await fetch("/api/wallet/recharge-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "recharge",
          amountInr,
          paymentReference: document.getElementById("paymentReference").value.trim(),
          screenshot,
          screenshotMime: screenshotFile.type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");

      document.getElementById("rechargeAmountInr").value = "";
      document.getElementById("paymentReference").value = "";
      document.getElementById("screenshotInput").value = "";
      screenshotFile = null;
      document.getElementById("screenshotPreview").classList.add("hidden");
      document.getElementById("screenshotPreview").innerHTML = "";
      updateCreditsPreview();
      await loadRechargeRequests();
      btn.textContent = "Submitted!";
      setTimeout(() => { btn.textContent = "Submit payment proof"; }, 2000);
    } catch (err) {
      showError("rechargeError", err.message);
      btn.textContent = "Submit payment proof";
    } finally {
      btn.disabled = false;
    }
  }

  async function submitWithdraw() {
    hideError("withdrawError");
    const amount = Number(document.getElementById("withdrawAmount").value);
    if (!isFinite(amount) || amount <= 0) {
      showError("withdrawError", "Enter a valid amount");
      return;
    }
    try {
      const res = await fetch("/api/wallet/recharge-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount, type: "withdrawal" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      document.getElementById("withdrawAmount").value = "";
      await loadRechargeRequests();
    } catch (err) {
      showError("withdrawError", err.message);
    }
  }

  const screenshotModal = document.getElementById("screenshotModal");
  document.getElementById("closeScreenshotModal").addEventListener("click", () => screenshotModal.classList.add("hidden"));
  screenshotModal.addEventListener("click", (e) => { if (e.target === screenshotModal) screenshotModal.classList.add("hidden"); });

  document.getElementById("rechargeTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-view-proof]");
    if (!btn) return;
    const id = btn.dataset.viewProof;
    const res = await fetch(`/api/wallet/recharge-requests/${id}/screenshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { mimeType, data } = await res.json();
    document.getElementById("screenshotModalImg").src = `data:${mimeType};base64,${data}`;
    screenshotModal.classList.remove("hidden");
  });

  document.getElementById("submitRechargeBtn").addEventListener("click", submitRecharge);
  document.getElementById("submitWithdrawBtn").addEventListener("click", submitWithdraw);
  document.getElementById("rechargeAmountInr").addEventListener("input", updateCreditsPreview);

  loadPaymentInfo();
  load();
  loadRechargeRequests();
})();
