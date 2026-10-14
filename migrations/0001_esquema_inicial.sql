-- BLOOM · Esquema inicial
-- Importes en centavos (INTEGER). Fechas de negocio en formato YYYY-MM-DD.
-- Marcas de tiempo técnicas en ISO-8601 UTC o milisegundos (epoch).


-- Administradores ------------------------------------------------------------
CREATE TABLE admins (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  password_changed_at  TEXT
);

CREATE TABLE admin_sessions (
  id_hash       TEXT PRIMARY KEY,           -- SHA-256 del identificador de la cookie
  admin_id      TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_sessions_expires ON admin_sessions(expires_at);

-- Clientes -------------------------------------------------------------------
CREATE TABLE clients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone       TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_clients_name ON clients(name COLLATE NOCASE);
CREATE INDEX idx_clients_phone ON clients(phone);

-- Compras y prendas ----------------------------------------------------------
CREATE TABLE purchases (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  purchase_date   TEXT NOT NULL,
  due_date        TEXT,
  subtotal_cents  INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0 AND total_cents = subtotal_cents - discount_cents),
  notes           TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_at    TEXT,
  cancel_reason   TEXT,
  cancelled_by    TEXT REFERENCES admins(id),
  created_by      TEXT REFERENCES admins(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_purchases_client ON purchases(client_id, status);

CREATE TABLE purchase_items (
  id                TEXT PRIMARY KEY,
  purchase_id       TEXT NOT NULL REFERENCES purchases(id),
  position          INTEGER NOT NULL,
  description       TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  size              TEXT NOT NULL DEFAULT '' CHECK (length(size) <= 30),
  quantity          INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents  INTEGER NOT NULL CHECK (line_total_cents = quantity * unit_price_cents)
);
CREATE INDEX idx_items_purchase ON purchase_items(purchase_id);

-- Abonos ---------------------------------------------------------------------
CREATE TABLE payments (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES clients(id),
  purchase_id          TEXT REFERENCES purchases(id),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_at              TEXT NOT NULL,
  method               TEXT NOT NULL CHECK (method IN ('efectivo', 'transferencia', 'tarjeta', 'deposito', 'otro')),
  note                 TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  status               TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'voided')),
  voided_at            TEXT,
  void_reason          TEXT,
  voided_by            TEXT REFERENCES admins(id),
  replaces_payment_id  TEXT REFERENCES payments(id),
  created_by           TEXT REFERENCES admins(id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_payments_client ON payments(client_id, status);
CREATE INDEX idx_payments_purchase ON payments(purchase_id, status);
CREATE INDEX idx_payments_date ON payments(paid_at);

-- Enlaces privados -----------------------------------------------------------
CREATE TABLE access_tokens (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  token_hash       TEXT NOT NULL UNIQUE,       -- SHA-256 (hex) del token
  token_encrypted  TEXT NOT NULL,              -- AES-GCM con APP_SECRET, para poder copiar el enlace
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by       TEXT REFERENCES admins(id),
  revoked_at       TEXT,
  revoked_by       TEXT REFERENCES admins(id),
  last_used_at     TEXT
);
CREATE UNIQUE INDEX idx_tokens_one_active ON access_tokens(client_id) WHERE revoked_at IS NULL;

-- Auditoría ------------------------------------------------------------------
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  admin_id     TEXT REFERENCES admins(id),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  details      TEXT NOT NULL DEFAULT '{}',
  ip_hash      TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Limitación de intentos -----------------------------------------------------
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- Reglas de integridad: el saldo solo cambia mediante operaciones registradas --
CREATE TRIGGER trg_items_no_update BEFORE UPDATE ON purchase_items
BEGIN SELECT RAISE(ABORT, 'purchase_items es inmutable'); END;

CREATE TRIGGER trg_items_no_delete BEFORE DELETE ON purchase_items
BEGIN SELECT RAISE(ABORT, 'purchase_items es inmutable'); END;

CREATE TRIGGER trg_purchases_amounts_immutable
BEFORE UPDATE OF client_id, subtotal_cents, discount_cents, total_cents, purchase_date ON purchases
BEGIN SELECT RAISE(ABORT, 'importes de compra inmutables'); END;

CREATE TRIGGER trg_purchases_no_uncancel BEFORE UPDATE OF status ON purchases
WHEN OLD.status = 'cancelled'
BEGIN SELECT RAISE(ABORT, 'una compra cancelada no se reactiva'); END;

CREATE TRIGGER trg_purchases_no_delete BEFORE DELETE ON purchases
BEGIN SELECT RAISE(ABORT, 'las compras no se eliminan; se cancelan'); END;

CREATE TRIGGER trg_payments_immutable
BEFORE UPDATE OF client_id, purchase_id, amount_cents, paid_at, method ON payments
BEGIN SELECT RAISE(ABORT, 'los abonos son inmutables; anula y registra uno nuevo'); END;

CREATE TRIGGER trg_payments_no_unvoid BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'voided'
BEGIN SELECT RAISE(ABORT, 'un abono anulado no se reactiva'); END;

CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'los abonos no se eliminan; se anulan'); END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'la auditoría es de solo inserción'); END;

CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'la auditoría es de solo inserción'); END;
