(() => {
  "use strict";

  if (localStorage.getItem("aviator_token")) {
    window.location.href = "index.html";
    return;
  }

  const credentialsCard = document.getElementById("credentialsCard");
  const otpCard = document.getElementById("otpCard");
  const errorBox = document.getElementById("errorBox");
  const otpInfo = document.getElementById("otpInfo");

  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const tabs = document.querySelectorAll(".auth-tab");

  let pendingUserId = null;

  const referralCode = new URLSearchParams(location.search).get("ref");
  if (referralCode) {
    tabs.forEach((t) => t.classList.remove("active"));
    document.querySelector('.auth-tab[data-tab="register"]').classList.add("active");
    registerForm.classList.remove("section-hidden");
    loginForm.classList.add("section-hidden");
    const note = document.getElementById("referralNote");
    note.textContent = `You were invited with code ${referralCode.toUpperCase()} — you'll both get a bonus once you verify.`;
    note.classList.remove("hidden");
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
    localStorage.setItem("aviator_token", token);
    localStorage.setItem("aviator_user", JSON.stringify(user));
    window.location.href = user.isAdmin ? "index.html" : "index.html";
  }

  function showOtpStep(userId, message, devCode) {
    pendingUserId = userId;
    credentialsCard.classList.add("section-hidden");
    otpCard.classList.remove("section-hidden");
    otpInfo.textContent = devCode
      ? `${message} (dev mode — code: ${devCode})`
      : message;
    document.getElementById("otpCode").focus();
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
      if (err.data && err.data.needsVerification) {
        showOtpStep(err.data.userId, "Your account still needs verification. Enter the code we sent, or resend it.");
      } else {
        showError(err.message);
      }
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
      showOtpStep(data.userId, data.message, data.devCode);
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById("verifyBtn").addEventListener("click", async () => {
    clearError();
    const code = document.getElementById("otpCode").value.trim();
    if (!code) return;
    try {
      const data = await api("/verify-otp", { userId: pendingUserId, code });
      onAuthSuccess(data.token, data.user);
    } catch (err) {
      otpInfo.textContent = err.message;
    }
  });

  document.getElementById("resendBtn").addEventListener("click", async () => {
    try {
      const data = await api("/resend-otp", { userId: pendingUserId });
      otpInfo.textContent = data.devCode ? `${data.message} (dev mode — code: ${data.devCode})` : data.message;
    } catch (err) {
      otpInfo.textContent = err.message;
    }
  });
})();
