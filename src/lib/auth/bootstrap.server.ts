import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { dbSource, getSql } from "../db.ts";

export async function bootstrapAdmin() {
  let credentials: { email: string; password: string } | undefined;
  const sql = await getSql();
  await sql.transaction(async (tx) => {
    if (dbSource === "postgres") await tx.query("SELECT pg_advisory_xact_lock(716284931)");
    const users = await tx.query('SELECT id FROM "user" LIMIT 1');
    if (users.length) return;
    const email = "admin@middleout.local";
    const password = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const hash = await hashPassword(password);
    await tx.query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())',
      [id, "Administrator", email],
    );
    await tx.query(
      'INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now(), now())',
      [randomUUID(), id, "credential", id, hash],
    );
    // Return credentials only after the surrounding transaction commits.
    credentials = { email, password };
  });
  if (credentials)
    console.log(
      `Middle Out initial administrator\nEmail: ${credentials.email}\nPassword: ${credentials.password}\nSave these credentials securely. They are printed only on first initialization.`,
    );
}

export async function resetPassword(email: string) {
  const sql = await getSql();
  const password = randomBytes(24).toString("base64url");
  const hash = await hashPassword(password);
  await sql.transaction(async (tx) => {
    const users = await tx.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1 FOR UPDATE',
      [email],
    );
    if (!users[0]) throw new Error("Account not found; no account was created.");
    const changed = await tx.query(
      'UPDATE "account" SET password = $1, "updatedAt" = now() WHERE "userId" = $2 AND "providerId" = $3 RETURNING id',
      [hash, users[0].id, "credential"],
    );
    if (!changed.length) throw new Error("Account has no password credential.");
    await tx.query('DELETE FROM "session" WHERE "userId" = $1', [users[0].id]);
  });
  console.log(
    `Password reset\nEmail: ${email}\nPassword: ${password}\nAll browser sessions revoked. Store this password securely.`,
  );
}
