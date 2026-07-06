// Original sound effects, synthesized with the Web Audio API — no audio files,
// nothing copied. Exposes window.sfx plus window.sfxTick / window.sfxWin
// aliases that the daily-wheel code calls.
(() => {
  "use strict";

  let ctx = null;
  let muted = localStorage.getItem("aviator_muted") === "1";

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // Browsers only allow audio after a user gesture — prime the context on the
  // first interaction so later programmatic sounds are allowed to play.
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, ensureCtx, { once: false, passive: true })
  );

  // One synth voice: an oscillator swept in frequency with an envelope.
  function tone({ type = "sine", from, to = from, dur = 0.15, gain = 0.2, delay = 0 }) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const sfx = {
    bet() { tone({ type: "triangle", from: 340, to: 460, dur: 0.09, gain: 0.18 }); },
    cancel() { tone({ type: "sine", from: 400, to: 240, dur: 0.12, gain: 0.16 }); },
    cashout() {
      tone({ type: "triangle", from: 600, to: 900, dur: 0.12, gain: 0.22 });
      tone({ type: "sine", from: 900, to: 1200, dur: 0.14, gain: 0.18, delay: 0.09 });
    },
    crash() { tone({ type: "sawtooth", from: 300, to: 70, dur: 0.5, gain: 0.22 }); },
    takeoff() { tone({ type: "sine", from: 180, to: 520, dur: 0.35, gain: 0.14 }); },
    tick() { tone({ type: "square", from: 880, to: 880, dur: 0.04, gain: 0.08 }); },
    win() {
      [523, 659, 784, 1047].forEach((f, i) =>
        tone({ type: "triangle", from: f, to: f, dur: 0.16, gain: 0.2, delay: i * 0.1 })
      );
    },
    isMuted() { return muted; },
    toggleMute() {
      muted = !muted;
      localStorage.setItem("aviator_muted", muted ? "1" : "0");
      return muted;
    },
  };

  window.sfx = sfx;
  window.sfxTick = () => sfx.tick();
  window.sfxWin = () => sfx.win();
})();
