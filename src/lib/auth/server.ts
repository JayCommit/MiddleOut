import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Pool } from "pg";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getPglite } from "../db";
import { pgliteDialect } from "./pglite-dialect";

// Persist the signing secret alongside the embedded database. External Postgres
// deployments should set BETTER_AUTH_SECRET and retain it across replacements.
function authSecret(): string {
  const configured = process.env.BETTER_AUTH_SECRET?.trim();
  if (configured) {
    if (configured.length < 32)
      throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
    return configured;
  }
  if (process.env.DATABASE_URL?.trim())
    throw new Error("BETTER_AUTH_SECRET is required with DATABASE_URL.");
  if (process.env.DATA_DIR === ":memory:") return randomBytes(32).toString("hex");
  const directory = resolve(process.env.DATA_DIR || "data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "auth-secret");
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}

const baseURL = process.env.BETTER_AUTH_URL?.trim() || "http://localhost:8080";
const databaseURL = process.env.DATABASE_URL?.trim();
export const auth = betterAuth({
  appName: "Middle Out",
  baseURL,
  secret: authSecret(),
  database: databaseURL
    ? new Pool({ connectionString: databaseURL })
    : {
        dialect: pgliteDialect(() => getPglite()),
        type: "postgres" as const,
      },
  trustedOrigins: [new URL(baseURL).origin],
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.ALLOW_SIGN_UP !== "true",
    minPasswordLength: 12,
  },
  advanced: { useSecureCookies: new URL(baseURL).protocol === "https:", cookiePrefix: "middleout" },
  plugins: [tanstackStartCookies()],
});

async function initializeNode() {
  Object.assign(globalThis, {
    __middleoutMaintenance__: async () => {
      const { cleanupExpired } = await import("../storage/queries.server");
      return cleanupExpired();
    },
  });
  const { bootstrapAdmin, resetPassword } = await import("./bootstrap.server");
  return process.env.MIDDLEOUT_RESET_EMAIL
    ? resetPassword(process.env.MIDDLEOUT_RESET_EMAIL)
    : bootstrapAdmin();
}
export const bootstrapReady =
  process.env.MIDDLEOUT_BOOTSTRAP === "true" ? initializeNode() : Promise.resolve();
