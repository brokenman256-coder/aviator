function generateCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(100000 + (bytes[0] % 900000));
}

// Cloudflare Workers has no raw-socket SMTP access, so there's no SMTP path
// here (unlike the Node/Railway build). Codes are logged (visible via
// `wrangler tail`) and returned directly in the API response as devCode —
// fine for a private group running their own instance.
async function sendOtp(email, code) {
  console.log(`[OTP] code for ${email}: ${code}`);
  return { delivered: false, devCode: code };
}

export { generateCode, sendOtp };
