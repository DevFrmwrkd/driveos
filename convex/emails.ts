import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const FROM = process.env.RESEND_FROM_EMAIL || "DriveOS <noreply@vonas-media.com>";

async function resendSend(body: Record<string, unknown>): Promise<boolean> {
  const apiKey = process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY;
  if (!apiKey) return false; // best-effort: no-op when Resend isn't configured
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, ...body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Best-effort welcome email on first signup. Scheduled (not awaited) from the
// auth callback so a slow/blocked send never blocks account creation.
export const sendWelcome = internalAction({
  args: { email: v.string(), name: v.string(), orgName: v.string() },
  handler: async (_ctx, args) => {
    const appUrl = process.env.SITE_URL || "https://driveos.vercel.app";
    await resendSend({
      to: [args.email],
      subject: `Welcome to DriveOS, ${args.name || "there"}`,
      text:
        `Hi ${args.name || "there"},\n\n` +
        `Your DriveOS workspace "${args.orgName}" is ready.\n\n` +
        `1. Open the dashboard: ${appUrl}\n` +
        `2. Download the local app for macOS or Windows: ${appUrl}/#download\n` +
        `3. In the app, paste the connect token from Settings to start tracking your drives.\n\n` +
        `DriveOS only ever syncs file metadata — never your actual footage.\n\n` +
        `— The DriveOS team`,
    });
  },
});
