import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { chromium, request } from "playwright";

const directory = mkdtempSync(join(tmpdir(), "middleout-server-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://localhost:${port}`;
let server;
let logs = "";
async function start(registration) {
  logs = "";
  server = spawn(process.execPath, ["scripts/start.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: "",
      DATA_DIR: directory,
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: origin,
      PORT: String(port),
      HOST: "127.0.0.1",
      ALLOW_SIGN_UP: String(registration),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {
      /* Server is still starting. */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Server did not become healthy: ${logs}`);
}
async function stop() {
  if (server?.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
let browser;
let client;
let page;
try {
  await start(true);
  client = await request.newContext({ baseURL: origin });
  const account = {
    email: "operator@example.com",
    password: "a-long-local-password",
    name: "Operator",
  };
  const signup = await client.post("/api/auth/sign-up/email", {
    data: account,
    headers: { origin },
  });
  assert.equal(signup.status(), 200, await signup.text());
  const session = await client.get("/api/auth/get-session");
  assert.equal((await session.json()).user.email, account.email);
  const badOrigin = await client.post("/api/auth/sign-in/email", {
    data: account,
    headers: { origin: "https://untrusted.example.com" },
  });
  assert.equal(badOrigin.status(), 403);
  const state = await client.storageState();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ storageState: state });
  page = await context.newPage();
  page.on("response", async (response) => {
    if (response.status() >= 400 && response.url().includes("/api/"))
      logs += `\nHTTP ${response.status()} ${response.url()} ${await response.text().catch(() => "")}`;
  });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(origin);
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.deepEqual(failures, []);
  await page.goto(`${origin}/keys`);
  await page.getByText("No access keys", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await page.getByPlaceholder("laptop or CI runner").fill("Self-hosted smoke");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const accessKey = (await page.getByText(/^Access key: /).innerText()).replace("Access key: ", "");
  const secret = (await page.getByText(/^Secret: /).innerText()).replace("Secret: ", "");
  const s3Headers = { authorization: `MO ${accessKey}:${secret}` };
  assert.equal((await client.put("/api/s3/http-smoke", { headers: s3Headers })).status(), 200);
  assert.equal(
    (
      await client.put("/api/s3/http-smoke/file.txt", {
        headers: { ...s3Headers, "content-type": "text/plain" },
        data: "persisted HTTP object",
      })
    ).status(),
    200,
  );
  assert.equal(
    await (await client.get("/api/s3/http-smoke/file.txt", { headers: s3Headers })).text(),
    "persisted HTTP object",
  );
  assert.equal((await fetch(`${origin}/api/s3/http-smoke/file.txt`)).status, 403);
  const html = `<html><script>fetch('/api/auth/get-session?untrusted-object-proof').then(()=>{document.title='executed'})</script><body>untrusted</body></html>`;
  assert.equal(
    (
      await client.put("/api/s3/http-active", {
        headers: { ...s3Headers, "x-amz-acl": "public-read" },
      })
    ).status(),
    200,
  );
  assert.equal(
    (
      await client.put("/api/s3/http-active/evil.html", {
        headers: { ...s3Headers, "content-type": "text/html" },
        data: html,
      })
    ).status(),
    200,
  );
  let scriptRequests = 0;
  context.on("request", (request) => {
    if (request.url().includes("untrusted-object-proof")) scriptRequests++;
  });
  for (const path of ["/api/public/http-active/evil.html", "/api/s3/http-active/evil.html"]) {
    const response = await client.get(path);
    assert.match(response.headers()["content-security-policy"], /^sandbox;/);
    assert.equal(response.headers()["x-content-type-options"], "nosniff");
    assert.match(response.headers()["content-disposition"], /^attachment;/);
    const untrustedPage = await context.newPage();
    const downloaded = untrustedPage.waitForEvent("download");
    await untrustedPage.goto(origin + path).catch(() => undefined);
    await downloaded;
    await untrustedPage.close();
  }
  assert.equal(scriptRequests, 0, "Uploaded documents must not execute with the operator session.");
  // Lifecycle is a real console -> authenticated server function -> S3/data flow.
  assert.equal((await client.put("/api/s3/http-lifecycle", { headers: s3Headers })).status(), 200);
  for (const key of ["logs/expired.txt", "keep.txt"])
    assert.equal(
      (
        await client.put(`/api/s3/http-lifecycle/${key}`, {
          headers: s3Headers,
          data: "lifecycle fixture",
        })
      ).status(),
      200,
    );
  await page.goto(`${origin}/buckets/http-lifecycle`);
  await page.getByRole("button", { name: "Lifecycle", exact: true }).click();
  await page.getByRole("heading", { name: "Lifecycle rules", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  const createRule = page.getByRole("dialog", { name: "Create lifecycle rule", exact: true });
  await createRule.getByLabel("Rule name", { exact: true }).fill("Expire temporary logs");
  await createRule.getByLabel("File prefix (leave empty for all files)").fill("logs/");
  await createRule.getByLabel("Expire files", { exact: true }).selectOption("date");
  await createRule
    .getByLabel("Expiration date (UTC)")
    .fill(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  await createRule.getByRole("button", { name: "Review rule" }).click();
  let reviewRule = page.getByRole("dialog", { name: "Review lifecycle changes", exact: true });
  assert.equal(
    await reviewRule.getByRole("button", { name: "Save lifecycle rules" }).isDisabled(),
    true,
  );
  await reviewRule.getByRole("button", { name: "Preview affected files" }).click();
  await reviewRule.getByText("1 files", { exact: true }).waitFor();
  assert.equal(
    (await client.get("/api/s3/http-lifecycle/logs/expired.txt", { headers: s3Headers })).status(),
    200,
    "Preview is read-only",
  );
  await reviewRule.getByRole("checkbox").check();
  await reviewRule.getByRole("button", { name: "Save lifecycle rules" }).click();
  await page.getByRole("heading", { name: "Expire temporary logs", exact: true }).waitFor();
  const lifecycleConfig = await client.get("/api/s3/http-lifecycle?lifecycle", {
    headers: s3Headers,
  });
  assert.match(await lifecycleConfig.text(), /<Prefix>logs\/<\/Prefix>/);
  const beforeCleanup = await client.get("/api/s3/http-lifecycle/logs/expired.txt", {
    headers: s3Headers,
  });
  assert.equal(beforeCleanup.status(), 200, "Saving rules does not immediately delete bytes");
  assert.match(beforeCleanup.headers()["x-amz-expiration"], /expiry-date=/);
  if (process.env.LIFECYCLE_SCREENSHOT)
    await page.screenshot({ path: process.env.LIFECYCLE_SCREENSHOT, fullPage: true });
  await page.getByRole("button", { name: "Run cleanup", exact: true }).click();
  const cleanup = page.getByRole("dialog", { name: "Review cleanup", exact: true });
  await cleanup.getByRole("button", { name: "Preview affected files" }).click();
  await cleanup.getByText("1 files", { exact: true }).waitFor();
  await cleanup.getByRole("checkbox").check();
  await cleanup.getByRole("button", { name: "Run cleanup now", exact: true }).click();
  await page.getByText("Expired 1 files and aborted 0 uploads.", { exact: true }).waitFor();
  assert.equal(
    (await client.get("/api/s3/http-lifecycle/logs/expired.txt", { headers: s3Headers })).status(),
    404,
  );
  assert.equal(
    (await client.get("/api/s3/http-lifecycle/keep.txt", { headers: s3Headers })).status(),
    200,
  );
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editRule = page.getByRole("dialog", { name: "Edit lifecycle rule", exact: true });
  await editRule.getByLabel("File prefix (leave empty for all files)").fill("archive/");
  await editRule.getByRole("button", { name: "Review rule" }).click();
  reviewRule = page.getByRole("dialog", { name: "Review lifecycle changes", exact: true });
  await reviewRule.getByRole("button", { name: "Preview affected files" }).click();
  await reviewRule.getByText("0 files", { exact: true }).waitFor();
  await reviewRule.getByRole("checkbox").check();
  await reviewRule.getByRole("button", { name: "Save lifecycle rules" }).click();
  await page.getByText("Prefix: archive/", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Delete rule Expire temporary logs", exact: true })
    .click();
  await page.getByRole("heading", { name: "No lifecycle rules", exact: true }).waitFor();
  assert.equal(
    (await client.get("/api/s3/http-lifecycle?lifecycle", { headers: s3Headers })).status(),
    404,
  );
  const retainedConfig =
    "<LifecycleConfiguration><Rule><ID>persisted-retention</ID><Filter/><Status>Disabled</Status><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>";
  assert.equal(
    (
      await client.put("/api/s3/http-lifecycle?lifecycle", {
        headers: s3Headers,
        data: retainedConfig,
      })
    ).status(),
    200,
  );
  // A stored session must still verify after a full server restart, and new
  // account creation must be rejected after registration is disabled.
  await stop();
  await start(false);
  assert.match(
    await (await client.get("/api/s3/http-lifecycle?lifecycle", { headers: s3Headers })).text(),
    /persisted-retention/,
  );

  assert.equal(
    await (await client.get("/api/s3/http-smoke/file.txt", { headers: s3Headers })).text(),
    "persisted HTTP object",
  );
  await page.goto(origin);
  const persisted = await client.get("/api/auth/get-session");
  assert.equal((await persisted.json()).user.email, account.email);
  const blocked = await client.post("/api/auth/sign-up/email", {
    data: { ...account, email: "blocked@example.com" },
    headers: { origin },
  });
  assert.ok(blocked.status() >= 400, await blocked.text());
  await page.reload();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  assert.deepEqual(failures, []);
  assert.equal((await client.get("/api/metrics")).status(), 404);
  const config = await client.get("/api/auth/node-config");
  assert.equal((await config.json()).registrationEnabled, false);
  const secondSession = await client.post("/api/auth/sign-in/email", {
    data: account,
    headers: { origin },
  });
  assert.equal(secondSession.status(), 200);
  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "Account security", exact: true }).waitFor();
  await page.getByLabel("Current password", { exact: true }).fill(account.password);
  await page.getByLabel("New password", { exact: true }).fill("updated-local-password-2026");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.getByText("Password changed. Other sessions revoked.", { exact: true }).waitFor();
  assert.equal(await (await client.get("/api/auth/get-session")).json(), null);
  const oldLogin = await client.post("/api/auth/sign-in/email", {
    data: account,
    headers: { origin },
  });
  assert.equal(oldLogin.status(), 401);
  const newLogin = await client.post("/api/auth/sign-in/email", {
    data: { ...account, password: "updated-local-password-2026" },
    headers: { origin },
  });
  assert.equal(newLogin.status(), 200, await newLogin.text());
  assert.deepEqual(failures, []);
  console.log(
    "PASS: standalone server health, local auth, origin rejection, authenticated console, S3 HTTP writes/reads, lifecycle console previews/CRUD/execution and restart persistence, private access and blocked active documents, restart/session/object/key persistence, registration lockout, sign out and sign in.",
  );
} catch (error) {
  console.error(logs);
  if (page)
    console.error(
      await page
        .locator("body")
        .innerText()
        .catch(() => "Browser closed"),
    );
  throw error;
} finally {
  await browser?.close();
  await client?.dispose();
  await stop();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
