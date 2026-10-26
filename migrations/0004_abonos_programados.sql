-- Abonos programados: fechas e importes de los siguientes abonos de una clienta.
-- No son dinero registrado (eso vive en payments), por eso sí se pueden reprogramar o quitar;
-- cada cambio queda en audit_log.
CREATE TABLE IF NOT EXISTS scheduled_payments (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  due_date         TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  created_on       TEXT NOT NULL,
  rescheduled_from TEXT,
  created_by       TEXT REFERENCES admins(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_client ON scheduled_payments(client_id, due_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_payments(due_date);
