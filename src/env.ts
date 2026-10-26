export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secreto aleatorio (≥ 32 caracteres). Opcional: si falta, se genera y guarda en D1. */
  APP_SECRET: string;
  BUSINESS_NAME: string;
  WHATSAPP_NUMBER: string;
  /** Contacto para los servicios push (mailto: o https:). Opcional. */
  PUSH_CONTACT?: string;
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
