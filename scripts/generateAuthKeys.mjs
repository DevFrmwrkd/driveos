// One-off: generate RS256 keys for Convex Auth (JWT_PRIVATE_KEY + JWKS).
// Run with: node scripts/generateAuthKeys.mjs
// Paste the two outputs into the Convex deployment env (done via convex env set).
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

process.stdout.write(
  "JWT_PRIVATE_KEY=" + JSON.stringify(privateKey.trimEnd().replace(/\n/g, " ")) + "\n" +
  "JWKS=" + JSON.stringify(jwks) + "\n"
);
