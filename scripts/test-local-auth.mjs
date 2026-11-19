// Functional invitation/account checks against a disposable, loopback backend.
// No email transport is used: administrators share bearer invitation links.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(backendUrl).hostname), "Auth regression checks require a loopback backend.");
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-auth-e2e-"));
const results = [];
const record = (name) => { results.push({ name, status: "passed" }); process.stdout.write(`PASS ${name}\n`); };
const password = "DriveOS-local-QA-2026!";
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const client = () => new ConvexHttpClient(backendUrl, { logger: false });
async function signup(email, extra = {}, passwordValue = password) {
  const instance = client();
  const session = await instance.action(anyApi.auth.signIn, { provider: "password", params: { flow: "signUp", email, password: passwordValue, name: "Invitation QA", orgName: "Invitation QA", ...extra } });
  assert.ok(session.tokens?.token, "Signup must create a usable session.");
  instance.setAuth(session.tokens.token);
  return instance;
}
const invite = (instance, email, role = "viewer") => instance.mutation(anyApi.admin.addTeamMember, { name: "Invited Editor", email, role });

function localFixtureFunction(name, args = {}) {
  const localApp = process.env.DRIVEOS_TEST_LEGACY_FIXTURE;
  assert.ok(localApp, "Legacy fixture checks need an explicitly configured disposable app.");
  const config = fs.readFileSync(path.join(localApp, ".env.local"), "utf8");
  assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m, "Legacy fixtures require an anonymous local app.");
  assert.ok(config.split(/\r?\n/).includes(`CONVEX_URL=${backendUrl}`), "Legacy fixture must point at this loopback backend.");
  const result = spawnSync(process.execPath, [path.join(repository, "node_modules/convex/bin/main.js"), "run", name, JSON.stringify(args)], {
    cwd: localApp, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  fs.writeFileSync(path.join(fixture, `${name.replace(/:/g, "-")}-${args.mode || "run"}.log`), `${result.stdout || ""}\n${result.stderr || ""}`);
  // Some Windows CLI versions fail during shutdown after completing the call.
  // The caller always asserts the resulting real account state.
  if (result.error) throw result.error;
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `Fixture function did not return a result: ${result.stderr}`);
  return JSON.parse(result.stdout.slice(start, end + 1));
}
try {
  const adminEmail = `qa-invite-admin-${stamp}@driveos.test`;
  const admin = await signup(adminEmail);
  const otherAdmin = await signup(`qa-invite-other-${stamp}@driveos.test`);
  const adminContext = await admin.query(anyApi.tenants.currentContext, {});
  const otherContext = await otherAdmin.query(anyApi.tenants.currentContext, {});
  assert.notEqual(adminContext.tenant.id, otherContext.tenant.id);
  record("ordinary signup creates an isolated admin workspace");

  if (process.env.DRIVEOS_TEST_LEGACY_FIXTURE) {
    localFixtureFunction("qaLegacyMembership:setAccountShape", { email: adminEmail, mode: "legacy" });
    const returningAdmin = client();
    const session = await returningAdmin.action(anyApi.auth.signIn, { provider: "password", params: { flow: "signIn", email: adminEmail, password } });
    returningAdmin.setAuth(session.tokens.token);
    assert.equal((await returningAdmin.query(anyApi.tenants.currentContext, {})).tenant.id, adminContext.tenant.id);
    assert.ok((await invite(returningAdmin, `qa-legacy-invite-${stamp}@driveos.test`)).invitationToken);
    record("a legacy administrator missing only tenantId can sign in and create invitations without another administrator");

    assert.ok(Number.isInteger(localFixtureFunction("tenants:backfillLinkedUserTenants").patched));
    assert.equal(localFixtureFunction("qaLegacyMembership:assertRepaired", { email: adminEmail }).verified, true);
    localFixtureFunction("qaLegacyMembership:setAccountShape", { email: adminEmail, mode: "conflict" });
    assert.equal(await returningAdmin.query(anyApi.tenants.currentContext, {}), null);
    await assert.rejects(invite(returningAdmin, `qa-conflicting-admin-${stamp}@driveos.test`), /not linked/);
    localFixtureFunction("qaLegacyMembership:setAccountShape", { email: adminEmail, mode: "restore" });
    assert.equal((await returningAdmin.query(anyApi.tenants.currentContext, {})).tenant.id, adminContext.tenant.id);
    record("id-based legacy backfill persists the member tenant while explicit conflicting assignments remain denied");
  }

  await assert.rejects(invite(admin, "", "viewer"), /valid email/);
  await assert.rejects(invite(admin, `qa-invalid-role-${stamp}@driveos.test`, "unexpected-role"), /valid team role/);
  await assert.rejects(invite(admin, adminEmail, "viewer"), /another administrator/);
  record("member validation rejects malformed email, unknown roles, and self-demotion");

  const email = `qa-invited-${stamp}@driveos.test`;
  const initial = await invite(admin, email);
  assert.ok(initial.invitationToken && initial.invitationExpiresAt > Date.now());
  await assert.rejects(signup(email), /invitation link/);
  await assert.rejects(signup(email, { invitationToken: `${initial.id}.${"0".repeat(64)}` }), /invalid or expired/);
  await assert.rejects(signup(`qa-wrong-recipient-${stamp}@driveos.test`, { invitationToken: initial.invitationToken }), /invalid or expired/);
  record("pending memberships require their invitation and intended recipient");

  const current = await invite(admin, email);
  assert.notEqual(current.invitationToken, initial.invitationToken);
  await assert.rejects(signup(email, { invitationToken: initial.invitationToken }), /invalid or expired/);
  const otherInvite = await invite(otherAdmin, email, "editor");
  assert.notEqual(otherInvite.id, current.id);
  const viewer = await signup(email, { invitationToken: current.invitationToken });
  const context = await viewer.query(anyApi.tenants.currentContext, {});
  assert.equal(context.tenant.id, adminContext.tenant.id);
  assert.equal(context.member.role, "viewer");
  const members = await admin.query(anyApi.admin.listTeamMembers, {});
  const member = members.find((row) => row.email === email);
  assert.equal(member.invitationPending, false);
  assert.equal(member.invitationTokenHash, undefined);
  record("rotated invitation joins its exact workspace and is consumed once");

  await assert.rejects(invite(otherAdmin, email, "editor"), /already belongs to another workspace/);
  await assert.rejects(viewer.mutation(anyApi.admin.acceptInvitation, { invitationToken: otherInvite.invitationToken }), /already belongs to a workspace/);
  record("an existing linked account cannot be reassigned by another workspace invitation");

  await assert.rejects(invite(viewer, `qa-viewer-invite-${stamp}@driveos.test`), /requires one of/);
  const machine = await admin.mutation(anyApi.agentAuth.issueMachineToken, { machineName: `Invitation-QA-${stamp}` });
  await assert.rejects(viewer.mutation(anyApi.agentAuth.issueMachineToken, { machineName: machine.machineName }), /requires one of/);
  await assert.rejects(viewer.mutation(anyApi.agentAuth.revokeMachineToken, { machineId: machine.machineId }), /requires one of/);
  record("viewers cannot invite users or issue, rotate, or revoke agent credentials");

  const returning = client();
  const session = await returning.action(anyApi.auth.signIn, { provider: "password", params: { flow: "signIn", email, password } });
  returning.setAuth(session.tokens.token);
  assert.equal((await returning.query(anyApi.tenants.currentContext, {})).tenant.id, adminContext.tenant.id);
  const updated = await invite(admin, email, "editor");
  assert.equal(updated.invitationToken, undefined);
  assert.equal((await returning.query(anyApi.tenants.currentContext, {})).member.role, "editor");
  record("returning accounts retain membership and accepted member role updates take effect");

  fs.writeFileSync(path.join(fixture, "browser-login.json"), JSON.stringify({ email: adminEmail, password, invitedEmail: email, backendUrl }, null, 2));
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, results }, null, 2));
  process.stdout.write(`Auth evidence: ${fixture}\n`);
} catch (error) {
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, results, failed: String(error?.stack || error) }, null, 2));
  throw error;
}
