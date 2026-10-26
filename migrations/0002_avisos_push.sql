-- Avisos push en el celular de la clienta (con su permiso explícito).
-- Cada suscripción pertenece al enlace privado con el que se activó: si el enlace se
-- revoca o se regenera, la suscripción se borra y deja de recibir avisos.
-- IF NOT EXISTS: src/lib/push.ts crea la misma tabla si el despliegue aún no aplicó esta migración.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id),
  token_id          TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  endpoint          TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 1024),
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payday_sent_on    TEXT,      -- último día (AAAA-MM-DD, hora de México) en que se envió el aviso automático
  reminder_sent_at  INTEGER    -- último recordatorio enviado desde el panel (ms)
);
CREATE INDEX IF NOT EXISTS idx_push_client ON push_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_push_token ON push_subscriptions(token_id);
