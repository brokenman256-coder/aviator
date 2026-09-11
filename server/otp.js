const crypto = require("crypto");
const nodemailer = require("nodemailer");
const config = require("./config");

let transporter = null;
if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
}

function generateCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Emails the OTP if SMTP is configured. Otherwise (the default for a friends
// setup with no mail server) it logs the code to the server console so
// whoever is running the server can read it out, and the caller may also
// surface it directly in the API response for convenience.
async function sendOtp(email, code) {
  if (transporter) {
    await transporter.sendMail({
      from: config.SMTP_FROM,
      to: email,
      subject: "Your Zenith Markets verification code",
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
    });
    return { delivered: true };
  }
  console.log(`[OTP] code for ${email}: ${code}`);
  return { delivered: false };
}

module.exports = { generateCode, sendOtp };
