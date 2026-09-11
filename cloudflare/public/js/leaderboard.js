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

  const user = JSON.parse(localStorage.getItem("zenith_user") || "{}");
  document.getElementById("usernamePill").textContent = user.username || "";

  const AVATAR_COLORS = ["#e50539", "#7b2ff7", "#1f9d55", "#e6a700", "#2d7dff", "#e05a00", "#c026d3", "#0891b2"];
  function avatar(name, userId) {
    const key = (userId || 0) + (name || "");
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffffffff;
    const color = AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
    const letter = (name || "?").replace(/[^a-zA-Z0-9]/g, "")[0] || "?";
    return `<span class="feed-avatar" style="background:${color}">${letter.toUpperCase()}</span>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

  async function load(metric) {
    const res = await fetch(`/api/stats/leaderboard?metric=${metric}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const { leaders } = await res.json();
    const listEl = document.getElementById("lbList");
    if (!leaders.length) {
      listEl.innerHTML = `<div class="feed-empty">No results yet — play some rounds!</div>`;
      return;
    }
    listEl.innerHTML = leaders.map((l) => {
      const val = (l.value >= 0 ? "" : "") + l.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const valClass = metric === "net" ? (l.value >= 0 ? "positive" : "negative") : "";
      const mine = l.userId === user.id ? " lb-mine" : "";
      return `
        <div class="lb-row${mine}">
          <span class="lb-rank">${MEDALS[l.rank] || l.rank}</span>
          ${avatar(l.username, l.userId)}
          <span class="lb-name">${escapeHtml(l.username)}${l.userId === user.id ? " (you)" : ""}</span>
          <span class="lb-value ${valClass}">${val}</span>
        </div>`;
    }).join("");
  }

  const tabs = document.querySelectorAll(".lb-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      load(tab.dataset.metric);
    });
  });

  load("net");
})();
