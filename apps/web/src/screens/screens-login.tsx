"use client";

import React from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Icon } from "@/components/icons";

type Mode = "signIn" | "signUp" | "resetRequest" | "resetVerify";

// Email + password auth for DriveOS. Open multi-tenant signup: a new email
// creates its own workspace. Password reset codes are delivered via Resend.
export function LoginScreen() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = React.useState<Mode>("signIn");
  const [orgName, setOrgName] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reset = () => {
    setError(null);
    setNotice(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    reset();
    const mail = email.trim().toLowerCase();
    try {
      if (mode === "signIn") {
        await signIn("password", { email: mail, password, flow: "signIn" });
      } else if (mode === "signUp") {
        await signIn("password", {
          email: mail,
          password,
          name: name.trim(),
          orgName: orgName.trim(),
          flow: "signUp",
        });
      } else if (mode === "resetRequest") {
        await signIn("password", { email: mail, flow: "reset" });
        setNotice("Check your inbox — we sent a reset code. Enter it below with a new password.");
        setMode("resetVerify");
      } else if (mode === "resetVerify") {
        await signIn("password", {
          email: mail,
          code: code.trim(),
          newPassword: password,
          flow: "reset-verification",
        });
      }
    } catch (err: any) {
      setError(friendlyError(err, mode));
    } finally {
      setBusy(false);
    }
  };

  const isReset = mode === "resetRequest" || mode === "resetVerify";

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 24 }}>
      <div className="card fade-up" style={{ width: "100%", maxWidth: 408, overflow: "hidden" }}>
        <div style={{ padding: "30px 28px 20px", textAlign: "center", borderBottom: "1px solid var(--line)" }}>
          <div
            style={{
              width: 52, height: 52, borderRadius: 13, margin: "0 auto 14px", display: "grid",
              placeItems: "center", background: "var(--accent)", boxShadow: "0 0 30px var(--accent-glow)",
            }}
          >
            <Icon name="database" size={24} style={{ color: "#fff" }} stroke={2.4} />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--tx-hi)" }}>DriveOS</h1>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {mode === "signUp"
              ? "Create your studio's storage command center"
              : isReset
              ? "Reset your password"
              : "Sign in to your Storage Command Center"}
          </div>
        </div>

        {/* Sign in / Sign up toggle */}
        {!isReset && (
          <div style={{ display: "flex", padding: "16px 24px 0", gap: 8 }}>
            {(["signIn", "signUp"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); reset(); }}
                className={"btn " + (mode === m ? "primary" : "ghost")}
                style={{ flex: 1, justifyContent: "center" }}
              >
                {m === "signIn" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
          {mode === "signUp" && (
            <div>
              <label className="field-label">Workspace / studio name</label>
              <input
                className="input" type="text" required value={orgName} autoFocus
                placeholder="Acme Post Studio"
                onChange={(e) => setOrgName(e.target.value)}
              />
            </div>
          )}
          {mode === "signUp" && (
            <div>
              <label className="field-label">Your name</label>
              <input
                className="input" type="text" required value={name}
                placeholder="Jane Editor"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          {mode !== "resetVerify" && (
            <div>
              <label className="field-label">Email</label>
              <input
                className="input" type="email" required value={email}
                autoFocus={mode === "signIn" || mode === "resetRequest"}
                placeholder="you@studio.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}

          {mode === "resetVerify" && (
            <div>
              <label className="field-label">Reset code</label>
              <input
                className="input" type="text" required value={code} autoFocus
                placeholder="6-digit code"
                inputMode="numeric"
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}

          {mode !== "resetRequest" && (
            <div>
              <label className="field-label">
                {mode === "resetVerify" ? "New password" : "Password"}
              </label>
              <input
                className="input" type="password" required value={password}
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}

          {notice && (
            <div style={{ fontSize: 12.5, color: "var(--ok)", background: "var(--ok-soft, rgba(120,180,140,0.12))", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "9px 12px" }}>
              {notice}
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12.5, color: "var(--risk)", background: "var(--risk-soft)", border: "1px solid var(--risk-line)", borderRadius: "var(--r)", padding: "9px 12px" }}>
              {error}
            </div>
          )}

          <button className="btn primary lg" type="submit" disabled={busy} style={{ marginTop: 2, justifyContent: "center" }}>
            {busy
              ? "Working…"
              : mode === "signIn"
              ? "Sign in"
              : mode === "signUp"
              ? "Create workspace"
              : mode === "resetRequest"
              ? "Send reset code"
              : "Set new password & sign in"}
          </button>

          {/* Secondary actions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", marginTop: 2 }}>
            {mode === "signIn" && (
              <button type="button" className="dim" style={linkBtn} onClick={() => { setMode("resetRequest"); reset(); }}>
                Forgot your password?
              </button>
            )}
            {isReset && (
              <button type="button" className="dim" style={linkBtn} onClick={() => { setMode("signIn"); reset(); }}>
                ← Back to sign in
              </button>
            )}
            <a
              href="#download"
              className="dim"
              style={{ fontSize: 11.5, textDecoration: "none" }}
              onClick={() => { window.location.hash = "download"; }}
            >
              <Icon name="download" size={12} style={{ marginRight: 5, verticalAlign: "-1px" }} />
              Download the Mac / Windows app
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};

function friendlyError(err: any, mode: Mode): string {
  const msg = String(err?.data || err?.message || "");
  if (msg.includes("InvalidSecret") || /invalid.*(password|credential)/i.test(msg)) {
    return "Incorrect email or password.";
  }
  if (/already.*exist|account.*exists/i.test(msg)) {
    return "An account with this email already exists. Try signing in.";
  }
  if (mode === "resetVerify" && /code|verif/i.test(msg)) {
    return "That code is invalid or expired. Request a new one.";
  }
  if (/Resend|email/i.test(msg) && mode === "resetRequest") {
    return "Couldn't send the reset email right now. Please try again shortly.";
  }
  if (msg.includes("required")) return "Please fill in all fields.";
  return mode === "signUp"
    ? "Could not create your workspace. Please try again."
    : "Something went wrong. Please try again.";
}
