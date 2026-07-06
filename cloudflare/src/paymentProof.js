const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 1.5 * 1024 * 1024;

export function validateScreenshot(mime, base64Data) {
  if (!ALLOWED_MIMES.has(mime)) {
    return { ok: false, error: "Screenshot must be a JPEG, PNG, or WebP image" };
  }
  if (!base64Data || typeof base64Data !== "string") {
    return { ok: false, error: "Payment screenshot is required" };
  }
  const clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(clean)) {
    return { ok: false, error: "Invalid screenshot data" };
  }
  const bytes = Math.ceil((clean.length * 3) / 4);
  if (bytes > MAX_BYTES) {
    return { ok: false, error: "Screenshot must be under 1.5 MB" };
  }
  return { ok: true, data: clean };
}

export function publicRechargeRequest(row) {
  if (!row) return row;
  const { screenshot_data, ...rest } = row;
  return {
    ...rest,
    hasScreenshot: !!screenshot_data,
  };
}
