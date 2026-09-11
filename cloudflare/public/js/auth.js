(() => {
  "use strict";

  const wantsAdmin = new URLSearchParams(location.search).get("admin");

  if (localStorage.getItem("zenith_token")) {
    window.location.href = wantsAdmin ? "admin.html" : "index.html";
    return;
  }

  const errorBox = document.getElementById("errorBox");
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const tabs = document.querySelectorAll(".auth-tab");

  if (wantsAdmin) {
    document.getElementById("loginEmail").value = "admin@aviator.local";
    document.getElementById("loginPassword").focus();
  }

  const referralCode = new URLSearchParams(location.search).get("ref");
  if (referralCode) {
    tabs.forEach((t) => t.classList.remove("active"));
    const regTab = document.querySelector('.auth-tab[data-tab="register"]');
    if (regTab) regTab.classList.add("active");
    registerForm.classList.remove("section-hidden");
    loginForm.classList.add("section-hidden");
    const note = document.getElementById("referralNote");
    if (note) {
      note.textContent = `Invited with code ${referralCode.toUpperCase()} — you'll both get bonus credits after your first daily spin.`;
      note.classList.remove("hidden");
    }
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.classList.add("hidden");
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      clearError();
      if (tab.dataset.tab === "login") {
        loginForm.classList.remove("section-hidden");
        registerForm.classList.add("section-hidden");
      } else {
        registerForm.classList.remove("section-hidden");
        loginForm.classList.add("section-hidden");
      }
    });
  });

  async function api(path, body) {
    const res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { data });
    return data;
  }

  function onAuthSuccess(token, user) {
    localStorage.setItem("zenith_token", token);
    localStorage.setItem("zenith_user", JSON.stringify(user));
    window.location.href = wantsAdmin && user.isAdmin ? "admin.html" : "index.html";
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    try {
      const data = await api("/login", { email, password });
      onAuthSuccess(data.token, data.user);
    } catch (err) {
      showError(err.message);
    }
  });

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    const username = document.getElementById("registerUsername").value.trim();
    const email = document.getElementById("registerEmail").value.trim();
    const password = document.getElementById("registerPassword").value;
    try {
      const data = await api("/register", { username, email, password, referralCode });
      onAuthSuccess(data.token, data.user);
    } catch (err) {
      showError(err.message);
    }
  });
})();
