import { randomBytes, randomUUID } from "node:crypto";
import { getSql, type Sql } from "../db.ts";

export type AgentPermission = "read" | "write" | "read-write" | "admin";

export interface AgentTokenRecord {
  id: string;
  ownerId: string;
  name: string;
  token: string;
  permissions: AgentPermission;
  bucketScope: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Generate a new scoped agent token.
 */
export async function createAgentToken(
  ownerId: string,
  input: {
    name: string;
    permissions?: AgentPermission;
    bucketScope?: string;
    ttlDays?: number | null;
  },
  sqlParam?: Sql,
): Promise<{ id: string; name: string; token: string; permissions: AgentPermission; bucketScope: string; expiresAt: string | null }> {
  const sql = sqlParam ?? (await getSql());
  const id = randomUUID();
  const token = `mo_agent_live_${randomBytes(20).toString("base64url")}`;
  const name = input.name.trim() || "Agent Worker";
  const permissions = input.permissions || "read-write";
  const bucketScope = input.bucketScope?.trim() || "*";

  const expiresAt =
    input.ttlDays && input.ttlDays > 0
      ? new Date(Date.now() + input.ttlDays * 86400 * 1000).toISOString()
      : null;

  await sql`
    insert into mo_agent_tokens (id, owner_id, token, name, permissions, bucket_scope, expires_at, created_at)
    values (${id}, ${ownerId}, ${token}, ${name}, ${permissions}, ${bucketScope}, ${expiresAt}, now())
  `;

  return {
    id,
    name,
    token,
    permissions,
    bucketScope,
    expiresAt,
  };
}

/**
 * List active agent tokens for an account owner.
 */
export async function listAgentTokens(
  ownerId: string,
  sqlParam?: Sql,
): Promise<Array<Omit<AgentTokenRecord, "token"> & { maskedToken: string }>> {
  const sql = sqlParam ?? (await getSql());
  const rows = await sql<{
    id: string;
    owner_id: string;
    name: string;
    token: string;
    permissions: string;
    bucket_scope: string;
    expires_at: unknown;
    last_used_at: unknown;
    created_at: unknown;
  }>`
    select id, owner_id, name, token, permissions, bucket_scope, expires_at, last_used_at, created_at
    from mo_agent_tokens
    where owner_id = ${ownerId}
    order by created_at desc
  `;

  return rows.map((r) => {
    const raw = r.token;
    const masked =
      raw.length > 20
        ? `${raw.slice(0, 16)}••••••••${raw.slice(-4)}`
        : "mo_agent_••••••••";
    return {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      maskedToken: masked,
      permissions: (r.permissions as AgentPermission) || "read-write",
      bucketScope: r.bucket_scope || "*",
      expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
      lastUsedAt: r.last_used_at ? new Date(String(r.last_used_at)).toISOString() : null,
      createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : new Date().toISOString(),
    };
  });
}

/**
 * Revoke an agent token.
 */
export async function revokeAgentToken(
  ownerId: string,
  tokenId: string,
  sqlParam?: Sql,
): Promise<boolean> {
  const sql = sqlParam ?? (await getSql());
  await sql`delete from mo_agent_tokens where id = ${tokenId} and owner_id = ${ownerId}`;
  return true;
}

/**
 * Authenticate an incoming Authorization header with Bearer mo_agent_...
 */
export async function authenticateAgentBearer(
  authHeader: string | null | undefined,
  sqlParam?: Sql,
): Promise<{
  ownerId: string;
  name: string;
  permissions: AgentPermission;
  bucketScope: string;
  tokenId: string;
} | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(mo_agent_[A-Za-z0-9_-]+)$/i);
  if (!match) return null;

  const rawToken = match[1];
  if (!rawToken) return null;
  const sql = sqlParam ?? (await getSql());

  const rows = await sql<{
    id: string;
    owner_id: string;
    name: string;
    permissions: string;
    bucket_scope: string;
    expires_at: unknown;
  }>`
    select id, owner_id, name, permissions, bucket_scope, expires_at
    from mo_agent_tokens
    where token = ${rawToken}
  `;

  const record = rows[0];
  if (!record) return null;

  if (record.expires_at) {
    const expiry = new Date(String(record.expires_at)).getTime();
    if (Date.now() > expiry) return null;
  }

  // Update last used timestamp
  void sql`update mo_agent_tokens set last_used_at = now() where id = ${record.id}`.catch(
    () => undefined,
  );

  return {
    ownerId: record.owner_id,
    name: record.name,
    permissions: (record.permissions as AgentPermission) || "read-write",
    bucketScope: record.bucket_scope || "*",
    tokenId: record.id,
  };
}

/**
 * Check whether an agent token has permission to access a bucket.
 */
export function canAgentAccessBucket(
  bucketScope: string,
  bucketName: string,
  mode: "read" | "write" | "admin",
  permissions: AgentPermission,
): boolean {
  // Check permission level
  if (permissions === "read" && mode !== "read") return false;
  if (permissions === "write" && mode !== "write") return false;
  if (permissions === "read-write" && mode === "admin") return false;

  // Check bucket scoping
  if (!bucketScope || bucketScope === "*") return true;

  const scopes = bucketScope.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const target = bucketName.toLowerCase();

  return scopes.some((scope) => {
    if (scope === "*") return true;
    if (scope.endsWith("*")) {
      const prefix = scope.slice(0, -1);
      return target.startsWith(prefix);
    }
    return target === scope;
  });
}

/**
 * Authenticate incoming HTTP request via Bearer mo_agent_... or active session.
 */
export async function authenticateAgentRequest(request: Request): Promise<{
  ownerId: string;
  permissions: AgentPermission;
  bucketScope: string;
  name: string;
} | null> {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer mo_agent_")) {
    const agent = await authenticateAgentBearer(authHeader);
    if (agent) return agent;
  }

  // Session fallback for console / testing
  try {
    const { auth } = await import("@/lib/auth/server");
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user?.id) {
      return {
        ownerId: session.user.id,
        permissions: "admin",
        bucketScope: "*",
        name: session.user.name || "User Session",
      };
    }
  } catch {
    // No session
  }

  return null;
}
