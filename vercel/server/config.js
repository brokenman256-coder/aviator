require("dotenv").config();

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL || "",
  JWT_SECRET: process.env.JWT_SECRET || "dev-insecure-secret-change-me",

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@aviator.local",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "ChangeMe123!",

  SIGNUP_BONUS_CREDITS: Number(process.env.SIGNUP_BONUS_CREDITS || 1000),
  DEFAULT_HOUSE_EDGE_PERCENT: Number(process.env.DEFAULT_HOUSE_EDGE_PERCENT || 5),

  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  SMTP_FROM: process.env.SMTP_FROM || "Aviator <no-reply@aviator.local>",
};
