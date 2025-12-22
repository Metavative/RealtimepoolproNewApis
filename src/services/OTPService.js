import nodemailer from "nodemailer";
import colors from "colors";

const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

export function generateOtp(len = 4, alphanumeric = false) {
  let otp = "";
  const characters = alphanumeric
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    : "0123456789";
  for (let i = 0; i < len; i++) {
    otp += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return otp;
}

export async function sendOtpEmail(email, otp) {
  const to = String(email || "").trim();
  if (!to) throw new Error("Email required");

  if (!SMTP_USER || !SMTP_PASS) {
    console.error("SMTP_USER/SMTP_PASS missing in .env".red);
    throw new Error("SMTP credentials missing");
  }

  // � Debug checks (temporary, keep while debugging)
  console.log("SMTP_USER =", SMTP_USER);
  console.log("SMTP_PASS length =", SMTP_PASS.length);

  try {
    await transporter.verify();
  } catch (err) {
    console.error("SMTP verify failed:".red, err?.message || err);
    throw new Error(`SMTP verify failed: ${err?.message || err}`);
  }

  try {
    const info = await transporter.sendMail({
      from: `Pool Pro <${SMTP_USER}>`,
      to,
      subject: "PoolPro OTP",
      text: `Your OTP: ${otp}. Valid for 10 minutes.`,
    });

    console.log(`OTP sent to ${to}: ${info.messageId}`.green);
    return info;
  } catch (err) {
    console.error("sendMail failed:".red, err?.message || err);
    throw new Error(`sendMail failed: ${err?.message || err}`);
  }
}

export async function sendOtpSms(phone, otp) {
  console.log(`SMS OTP -> ${String(phone).trim()}: ${otp}`.yellow);
  return true;
}
