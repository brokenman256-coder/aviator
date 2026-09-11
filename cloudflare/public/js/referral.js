(() => {
  "use strict";

  const token = localStorage.getItem("zenith_token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  function logout() {
    localStorage.removeItem("zenith_token");
    localStorage.removeItem("zenith_user");
    window.location.href = "login.html";
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const user = JSON.parse(localStorage.getItem("zenith_user") || "{}");
  document.getElementById("usernamePill").textContent = user.username || "";

  async function load() {
    const res = await fetch("/api/wallet/referral", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const data = await res.json();

    const link = `${location.origin}/login.html?ref=${data.code || ""}`;
    document.getElementById("referralLink").value = link;
    document.getElementById("referralCode").value = data.code || "";
    document.getElementById("bonusAmt").textContent = data.bonusPerReferral;
    document.getElementById("invitedCount").textContent = data.invited.length;
    document.getElementById("earnedTotal").textContent = Number(data.totalEarned).toFixed(0);

    const tbody = document.getElementById("invitedTableBody");
    tbody.innerHTML = data.invited.length
      ? data.invited.map((u) => `
          <tr>
            <td>${escapeHtml(u.username)}</td>
            <td>${new Date(u.joinedAt).toLocaleDateString()}</td>
            <td><span class="pill ${u.active ? "ok" : "warn"}">${u.active ? "Active" : "Not spun yet"}</span></td>
          </tr>`).join("")
      : `<tr><td colspan="3" style="color:var(--text-dim);">No invites yet — share your link!</td></tr>`;
  }

  function copyFrom(inputId, btn) {
    const input = document.getElementById(inputId);
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = orig), 1500);
    }).catch(() => {});
  }

  document.getElementById("copyLinkBtn").addEventListener("click", (e) => copyFrom("referralLink", e.target));
  document.getElementById("copyCodeBtn").addEventListener("click", (e) => copyFrom("referralCode", e.target));

  load();
})();
