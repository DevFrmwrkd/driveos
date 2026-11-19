import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// Transpile the actual pure Convex helpers, without requiring a hosted backend
// or a Node version with experimental TypeScript loading.
async function loadHelper(file) {
  const source = fs.readFileSync(new URL(`../convex/${file}`, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replaceAll('"convex/values"', JSON.stringify(import.meta.resolve("convex/values")));
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}
const { invitationMember, consumeInvitation, hashInvitationToken, newInvitationSecret, normalizedEmail } = await loadHelper("invitations.ts");
const { resolveMember, requireRole, backfillLinkedUserTenant } = await loadHelper("access.ts");

test("invitations require the exact secret, recipient, member, and unexpired deadline", async () => {
  const secret = newInvitationSecret();
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.notEqual(secret, newInvitationSecret());
  const hash = await hashInvitationToken(secret);
  assert.notEqual(hash, secret);
  const member = { _id: "member-a", tenantId: "tenant-a", email: "editor@driveos.test", invitationTokenHash: hash, invitationExpiresAt: Date.now() + 60000 };
  const ctx = { db: { normalizeId: (_, id) => id === member._id ? id : null, get: async () => member } };
  assert.equal(await invitationMember(ctx, `${member._id}.${secret}`, member.email), member);
  for (const [token, email] of [
    [`member-a.${"0".repeat(64)}`, member.email],
    [`member-b.${secret}`, member.email],
    [`member-a.${secret}.extra`, member.email],
    [`member-a.${secret}`, "other@driveos.test"],
  ]) await assert.rejects(invitationMember(ctx, token, email), /invalid or expired/);
  member.invitationExpiresAt = Date.now() - 1;
  await assert.rejects(invitationMember(ctx, `member-a.${secret}`, member.email), /invalid or expired/);
});

test("consuming an invitation removes its stored authorization", async () => {
  const member = { _id: "member-a", tenantId: "tenant-a", email: "editor@driveos.test", invitationTokenHash: await hashInvitationToken("1".repeat(64)), invitationExpiresAt: Date.now() + 60000 };
  const ctx = { db: { normalizeId: (_, id) => id, get: async () => member, patch: async (id, values) => { assert.equal(id, member._id); Object.assign(member, values); } } };
  await consumeInvitation(ctx, member._id);
  await assert.rejects(invitationMember(ctx, `member-a.${"1".repeat(64)}`, member.email), /invalid or expired/);
});

test("workspace access requires an authoritative matching user/member/tenant link", async () => {
  const user = { _id: "user-a", email: "editor@driveos.test", teamMemberId: "member-a", tenantId: "tenant-a" };
  const member = { _id: "member-a", email: user.email, tenantId: user.tenantId, name: "Editor", role: "editor" };
  const ctx = { auth: { getUserIdentity: async () => ({ subject: "user-a|session-a", email: user.email }) }, db: {
    normalizeId: (_, id) => id,
    get: async (id) => id === user._id ? user : id === member._id ? member : null,
    query: () => { throw new Error("Email lookup must never authorize workspace access."); },
  } };
  assert.equal((await resolveMember(ctx)).tenantId, "tenant-a");
  user.tenantId = "tenant-b";
  assert.equal(await resolveMember(ctx), null);
  user.tenantId = "tenant-a";
  user.email = "someone-else@driveos.test";
  assert.equal(await resolveMember(ctx), null);
  user.email = member.email;
  delete user.teamMemberId;
  assert.equal(await resolveMember(ctx), null);
  ctx.auth.getUserIdentity = async () => null;
  assert.equal(await resolveMember(ctx), null);
});

test("account and invitation email validation rejects empty or malformed addresses", () => {
  assert.equal(normalizedEmail("  Editor@DriveOS.test  "), "editor@driveos.test");
  for (const email of ["", "editor", "@driveos.test", "a b@driveos.test"]) assert.throws(() => normalizedEmail(email), /valid email/);
});

test("legacy administrators keep access through their stored member id before and after tenant backfill", async () => {
  const user = { _id: "legacy-admin", email: "admin@driveos.test", teamMemberId: "admin-member" };
  const member = { _id: "admin-member", tenantId: "original-workspace", email: user.email, name: "Original Admin", role: "admin" };
  const writes = [];
  const ctx = { auth: { getUserIdentity: async () => ({ subject: `${user._id}|existing-session` }) }, db: {
    normalizeId: (_, id) => id,
    get: async (id) => id === user._id ? user : id === member._id ? member : null,
    query: () => { throw new Error("Legacy membership must use its stored id, never an email query."); },
    patch: async (id, values) => { writes.push({ id, values }); Object.assign(user, values); },
  } };
  assert.equal((await requireRole(ctx, ["admin"])).tenantId, "original-workspace");
  assert.equal(user.tenantId, undefined, "Queries must not need a repair mutation before authorizing the legacy admin.");
  assert.equal(await backfillLinkedUserTenant(ctx, user), true);
  assert.deepEqual(writes, [{ id: user._id, values: { tenantId: "original-workspace" } }]);
  assert.equal((await resolveMember(ctx)).tenantId, "original-workspace");
  assert.equal(await backfillLinkedUserTenant(ctx, user), false, "Backfill must be idempotent.");
});

test("legacy tenant repair rejects conflicting tenants, mismatched emails, and missing member links", async () => {
  const member = { _id: "admin-member", tenantId: "workspace-a", email: "admin@driveos.test", name: "Admin", role: "admin" };
  let writes = 0;
  for (const user of [
    { _id: "user-a", teamMemberId: member._id, email: member.email, tenantId: "workspace-b" },
    { _id: "user-a", teamMemberId: member._id, email: member.email, tenantId: "" },
    { _id: "user-a", teamMemberId: member._id, email: "another@driveos.test" },
    { _id: "user-a", email: member.email },
    { _id: "user-a", teamMemberId: "missing-member", email: member.email },
  ]) {
    const ctx = { auth: { getUserIdentity: async () => ({ subject: user._id }) }, db: {
      normalizeId: (_, id) => id,
      get: async (id) => id === user._id ? user : id === member._id ? member : null,
      query: () => { throw new Error("An email must not recover a missing membership link."); },
      patch: async () => { writes++; },
    } };
    assert.equal(await resolveMember(ctx), null);
    assert.equal(await backfillLinkedUserTenant(ctx, user), false);
  }
  assert.equal(writes, 0);
});
