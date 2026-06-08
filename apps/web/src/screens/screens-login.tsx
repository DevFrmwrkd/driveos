"use client";

import React from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Icon } from "@/components/icons";

const h: any = React.createElement;

// Sign-in only by default. Sign-up is allowlisted server-side to existing team
// members; if an authorized member signs in for the first time, we transparently
// fall back to the signUp flow to create their account.
export function LoginScreen() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn("password", { email: email.trim(), password, flow: "signIn" });
    } catch (signInErr: any) {
      // First-time authorized member: try to create the account.
      try {
        await signIn("password", { email: email.trim(), password, flow: "signUp" });
      } catch (signUpErr: any) {
        const msg = String(signUpErr?.data || signUpErr?.message || "Could not sign in.");
        setError(
          msg.includes("not authorized")
            ? "This email isn't authorized. Ask a DriveOS admin to add you to the team."
            : "Incorrect email or password."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return h(
    "div",
    { style: { minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 24 } },
    h(
      "div",
      { className: "card fade-up", style: { width: "100%", maxWidth: 400, overflow: "hidden" } },
      h(
        "div",
        { style: { padding: "30px 28px 22px", textAlign: "center", borderBottom: "1px solid var(--line)" } },
        h(
          "div",
          {
            style: {
              width: 52, height: 52, borderRadius: 13, margin: "0 auto 14px", display: "grid",
              placeItems: "center", background: "var(--accent)", boxShadow: "0 0 30px var(--accent-glow)",
            },
          },
          h(Icon, { name: "database", size: 24, style: { color: "#fff" }, stroke: 2.4 })
        ),
        h("h1", { style: { fontSize: 20, fontWeight: 700, color: "var(--tx-hi)" } }, "DriveOS"),
        h("div", { className: "muted", style: { fontSize: 13, marginTop: 4 } }, "Sign in to the Storage Command Center")
      ),
      h(
        "form",
        { onSubmit: submit, style: { padding: 24, display: "flex", flexDirection: "column", gap: 14 } },
        h("div", null,
          h("label", { className: "field-label" }, "Email"),
          h("input", {
            className: "input", type: "email", required: true, value: email, autoFocus: true,
            placeholder: "you@studio.com",
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value),
          })),
        h("div", null,
          h("label", { className: "field-label" }, "Password"),
          h("input", {
            className: "input", type: "password", required: true, value: password,
            placeholder: "••••••••",
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value),
          })),
        error && h("div", {
          style: {
            fontSize: 12.5, color: "var(--risk)", background: "var(--risk-soft)",
            border: "1px solid var(--risk-line)", borderRadius: "var(--r)", padding: "9px 12px",
          },
        }, error),
        h("button", { className: "btn primary lg", type: "submit", disabled: busy, style: { marginTop: 4 } },
          busy ? "Signing in…" : "Sign in"),
        h("div", { className: "dim", style: { fontSize: 11, textAlign: "center", marginTop: 2 } },
          "Access is limited to DriveOS team members.")
      )
    )
  );
}
