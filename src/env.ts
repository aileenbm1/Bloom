export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secreto aleatorio (≥ 32 caracteres). Se configura con `wrangler secret put APP_SECRET`. */
  APP_SECRET: string;
  BUSINESS_NAME: string;
  WHATSAPP_NUMBER: string;
}

export interface AdminContext {
  id: string;
  username: string;
  display_name: string;
  csrf_token: string;
  session_hash: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { admin: AdminContext; ipHash: string };
};
