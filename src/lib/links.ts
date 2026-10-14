import { decryptToken, encryptToken, newToken, sha256Hex } from "./crypto";

/** Prepara la inserción de un nuevo enlace privado (token aleatorio de 256 bits). */
export async function newAccessToken(
  db: D1Database,
  secret: string,
  clientId: string,
  adminId: string | null,
): Promise<{ token: string; stmt: D1PreparedStatement; id: string }> {
  const token = newToken();
  const id = crypto.randomUUID();
  const hash = await sha256Hex(token);
  const encrypted = await encryptToken(secret, token);
  const stmt = db
    .prepare(`INSERT INTO access_tokens (id, client_id, token_hash, token_encrypted, created_by) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(id, clientId, hash, encrypted, adminId);
  return { token, stmt, id };
}

export function revokeActiveTokens(db: D1Database, clientId: string, adminId: string | null, at: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE access_tokens SET revoked_at = ?1, revoked_by = ?2 WHERE client_id = ?3 AND revoked_at IS NULL`)
    .bind(at, adminId, clientId);
}

export async function activeLink(
  db: D1Database,
  secret: string,
  clientId: string,
): Promise<{ token: string | null; created_at: string; last_used_at: string | null } | null> {
  const row = await db
    .prepare(`SELECT token_encrypted, created_at, last_used_at FROM access_tokens WHERE client_id = ?1 AND revoked_at IS NULL`)
    .bind(clientId)
    .first<{ token_encrypted: string; created_at: string; last_used_at: string | null }>();
  if (!row) return null;
  return { token: await decryptToken(secret, row.token_encrypted), created_at: row.created_at, last_used_at: row.last_used_at };
}

export function linkUrl(origin: string, token: string): string {
  return `${origin}/cuenta/${token}`;
}
