function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

export function getRazorpayConfig(env) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export function isRazorpayConfigured(env) {
  return !!getRazorpayConfig(env);
}

export function rupeesToPaise(amount) {
  return Math.round(amount * 100);
}

export async function verifyPaymentSignature(env, orderId, paymentId, signature) {
  const creds = getRazorpayConfig(env);
  if (!creds) return false;
  const expected = await hmacSha256Hex(creds.keySecret, `${orderId}|${paymentId}`);
  return expected === signature;
}

export async function verifyWebhookSignature(env, body, signature) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = await hmacSha256Hex(secret, body);
  return expected === signature;
}

export async function createRazorpayOrder(env, amountPaise, receipt, notes) {
  const creds = getRazorpayConfig(env);
  if (!creds) throw new Error("Razorpay is not configured");

  const auth = btoa(`${creds.keyId}:${creds.keySecret}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Razorpay order failed: ${err}`);
  }

  return res.json();
}
