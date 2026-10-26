-- Clientas eliminadas desde el panel. No se borra nada: compras, abonos y auditoría son
-- inmutables. La clienta deja de aparecer en listas, totales, exportaciones y avisos, su
-- enlace se revoca y se puede recuperar borrando su fila de esta tabla.
-- IF NOT EXISTS: src/lib/db.ts crea la misma tabla si el despliegue aún no aplicó la migración.
CREATE TABLE IF NOT EXISTS deleted_clients (
  client_id   TEXT PRIMARY KEY REFERENCES clients(id),
  deleted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_by  TEXT REFERENCES admins(id)
);
