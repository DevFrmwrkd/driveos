import Resend from "@auth/core/providers/resend";

// Default sender. The verified Resend domain is vonas-media.com; override per
// deployment with RESEND_FROM_EMAIL.
const FROM = process.env.RESEND_FROM_EMAIL || "DriveOS <noreply@vonas-media.com>";

// 6-digit numeric one-time code using the Convex runtime's Web Crypto.
function sixDigitCode(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return (n % 1_000_000).toString().padStart(6, "0");
}

async function sendResend(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Resend request failed (${res.status}): ${await res.text()}`);
  }
}

// Password-reset OTP delivered via Resend (sent over the REST API directly, so
// the `resend` npm package isn't needed). Wired into the Password provider's
// `reset` option in auth.ts.
export const ResendOTPPasswordReset = Resend({
  id: "resend-otp-password-reset",
  apiKey: process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY,
  maxAge: 60 * 15, // 15 minutes
  async generateVerificationToken() {
    return sixDigitCode();
  },
  async sendVerificationRequest({ identifier: email, provider, token }) {
    const apiKey = (provider as any).apiKey as string | undefined;
    if (!apiKey) {
      throw new Error("Password reset is unavailable: AUTH_RESEND_KEY is not set.");
    }
    await sendResend(apiKey, {
      from: FROM,
      to: [email],
      subject: "Reset your DriveOS password",
      text:
        `Your DriveOS password reset code is ${token}.\n\n` +
        `It expires in 15 minutes. If you didn't request this, you can safely ignore this email.`,
    });
  },
});
