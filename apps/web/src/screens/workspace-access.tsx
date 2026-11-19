"use client";

import React from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@/convexApi";

// Keep unlinked legacy accounts out of dashboard queries until an explicit
// invitation establishes their membership.
export function WorkspaceAccess({ children }: { children: React.ReactNode }) {
  const context = useQuery(api.tenants.currentContext);
  const acceptInvitation = useMutation(api.admin.acceptInvitation);
  const { signOut } = useAuthActions();
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const readInvitation = () => {
      const [kind, invitation] = window.location.hash.slice(1).split("/");
      setToken(kind === "invite" ? invitation || "" : "");
    };
    readInvitation();
    window.addEventListener("hashchange", readInvitation);
    return () => window.removeEventListener("hashchange", readInvitation);
  }, []);
  const memberId = context?.member.id;
  React.useEffect(() => {
    if (memberId && token.split(".")[0] === memberId) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#dashboard`);
      setToken("");
    }
  }, [memberId, token]);

  const openWorkspace = () => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#dashboard`);
    setToken("");
  };
  const accept = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const invitationToken = token.includes("#invite/") ? token.split("#invite/")[1].split("/")[0] : token.trim();
      await acceptInvitation({ invitationToken });
      openWorkspace();
    } catch (err: any) {
      setError(String(err?.data || err?.message || "Could not accept this invitation."));
    } finally {
      setBusy(false);
    }
  };

  if (context === undefined) return <div role="status" style={{ padding: 32 }}>Loading workspace…</div>;
  if (context && !token) return <>{children}</>;
  const joined = context && token.split(".")[0] === context.member.id;
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card card-pad" style={{ width: "100%", maxWidth: 480 }}>
        <h1 style={{ fontSize: 20 }}>{context ? joined ? "Invitation accepted" : "Your account has a workspace" : "Join your workspace"}</h1>
        {context ? <>
          <p className="muted">{joined ? `You have joined ${context.tenant?.name || "your workspace"}.` : "DriveOS supports one workspace per account. Sign out to use this invitation with its intended account, or continue to your current workspace."}</p>
          <button className="btn primary" onClick={openWorkspace}>Open workspace</button>
        </> : <form onSubmit={accept}>
          <p className="muted">Ask your workspace administrator for a new invitation link, then paste it here. Your email address alone does not grant workspace access.</p>
          <label className="field-label" htmlFor="workspace-invitation">Invitation link</label>
          <input id="workspace-invitation" className="input" value={token} onChange={(event) => setToken(event.target.value)} required autoComplete="off" />
          {error && <p role="alert" style={{ color: "var(--risk)" }}>{error}</p>}
          <button className="btn primary" style={{ marginTop: 14 }} disabled={busy}>{busy ? "Joining…" : "Accept invitation"}</button>
        </form>}
        <button className="btn ghost" style={{ marginTop: 12 }} disabled={busy} onClick={() => void signOut()}>Sign out</button>
      </div>
    </div>
  );
}
