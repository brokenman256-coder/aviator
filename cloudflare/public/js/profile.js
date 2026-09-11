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

  const AVATAR_COLORS = ["#e50539", "#7b2ff7", "#1f9d55", "#e6a700", "#2d7dff", "#e05a00", "#c026d3", "#0891b2"];
  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function statCard(label, value, cls) {
    return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value ${cls || ""}" style="font-size:20px;">${value}</div></div>`;
  }

  async function load() {
    const res = await fetch("/api/stats/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return logout();
    const d = await res.json();

    document.getElementById("usernamePill").textContent = d.username;
    document.getElementById("profileName").textContent = d.username;
    const av = document.getElementById("profileAvatar");
    av.textContent = (d.username || "?")[0].toUpperCase();
    av.style.background = avatarColor(d.username);
    document.getElementById("profileMeta").textContent =
      `Joined ${new Date(d.joinedAt).toLocaleDateString()} · 🔥 ${d.streak}-day streak`;

    const s = d.stats;
    document.getElementById("statsGrid").innerHTML = [
      statCard("Rounds", s.rounds),
      statCard("Wins", s.wins),
      statCard("Win rate", s.winRate + "%"),
      statCard("Wagered", s.wagered.toLocaleString()),
      statCard("Net profit", s.net.toLocaleString(), s.net >= 0 ? "positive" : "negative"),
      statCard("Biggest win", s.biggestWin.toLocaleString()),
      statCard("Best multiplier", s.bestMultiplier ? s.bestMultiplier.toFixed(2) + "x" : "—"),
    ].join("");

    document.getElementById("badgeProgress").textContent = `${d.badgesEarned}/${d.badges.length} unlocked`;
    document.getElementById("badgeGrid").innerHTML = d.badges.map((b) => `
      <div class="badge ${b.earned ? "earned" : "locked"}" title="${escapeHtml(b.desc)}">
        <div class="badge-icon">${b.icon}</div>
        <div class="badge-name">${escapeHtml(b.name)}</div>
        <div class="badge-desc">${escapeHtml(b.desc)}</div>
      </div>`).join("");
  }

  load();
})();
