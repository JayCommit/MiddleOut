import { test } from "node:test";
import assert from "node:assert/strict";

test("first startup creates working credentials exactly once", async () => {
  process.env.DATA_DIR = ":memory:";
  process.env.DATABASE_URL = "";
  const { bootstrapAdmin, resetPassword } = await import("../src/lib/auth/bootstrap.server.ts");
  const { getSql, getPglite } = await import("../src/lib/db.ts");
  const { verifyPassword } = await import("better-auth/crypto");
  const messages = [];
  const log = console.log;
  try {
    console.log = (message) => messages.push(message);
    await bootstrapAdmin();
    await bootstrapAdmin();
  } finally {
    console.log = log;
  }
  assert.equal(messages.length, 1);
  const password = messages[0].match(/Password: (.+)/)[1];
  const sql = await getSql();
  const users = await sql.query('SELECT email FROM "user"');
  assert.deepEqual(
    users.map((u) => u.email),
    ["admin@middleout.local"],
  );
  const accounts = await sql.query('SELECT password FROM "account"');
  assert.equal(accounts.length, 1);
  assert.ok(await verifyPassword({ hash: accounts[0].password, password }));
  const user = await sql.query('SELECT id FROM "user"');
  await sql.query(
    `INSERT INTO "session" (id, token, "userId", "expiresAt", "updatedAt") VALUES ($1,$2,$3,now()+interval '1 day',now())`,
    ["reset-test", "reset-token", user[0].id],
  );
  let resetLog = "";
  try {
    console.log = (message) => {
      resetLog = message;
    };
    await resetPassword("admin@middleout.local");
  } finally {
    console.log = log;
  }
  const replacement = resetLog.match(/Password: (.+)/)[1];
  const updated = await sql.query('SELECT password FROM "account"');
  assert.ok(await verifyPassword({ hash: updated[0].password, password: replacement }));
  assert.equal(await verifyPassword({ hash: updated[0].password, password }), false);
  assert.equal((await sql.query('SELECT id FROM "session"')).length, 0);
  await assert.rejects(() => resetPassword("missing@example.com"), /not found/);
  await (await getPglite()).close();
});
