import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
const image = process.env.TEST_IMAGE || "middleout:release-test";
const name = "middleout-test-" + randomUUID();
const volume = name + "-data";
const docker = (args, allowFailure = false) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) throw Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
async function healthy() {
  for (let i = 0; i < 480; i++) {
    try {
      if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* boot */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw Error("Container failed health check: " + docker(["logs", name], true));
}
try {
  if (!process.env.TEST_IMAGE) {
    const built = spawnSync("docker", ["build", "-t", image, "."], { stdio: "inherit" });
    assert.equal(built.status, 0);
  }
  docker(["volume", "create", volume]);
  docker([
    "create",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:8080`,
    "-e",
    `BETTER_AUTH_URL=${origin}`,
    "-e",
    "ALLOW_SIGN_UP=true",
    "-v",
    `${volume}:/app/data`,
    image,
  ]);
  docker(["start", name]);
  await healthy();
  const signup = await fetch(origin + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "container@example.com",
      password: "a-container-test-password",
      name: "Container",
    }),
  });
  assert.equal(signup.status, 200, await signup.text());
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  assert.equal((await fetch(origin + "/api/s3/does-not-exist", { method: "HEAD" })).status, 404);
  docker(["kill", "--signal", "KILL", name]);
  docker(["start", name]);
  await healthy();
  const session = await (
    await fetch(origin + "/api/auth/get-session", { headers: { cookie } })
  ).json();
  assert.equal(session.user.email, "container@example.com");
  docker(["stop", "--time", "30", name]);
  assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", name]), "0");
  assert.equal(docker(["inspect", "--format", "{{.Config.User}}", name]), "node");
  console.log(
    "PASS: non-root container, health, auth, abrupt termination recovery, persisted session and graceful shutdown.",
  );
} finally {
  docker(["rm", "-f", name], true);
  docker(["volume", "rm", volume], true);
}
