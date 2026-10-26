// Abonos programados: el admin fija las fechas (e importes) de los siguientes abonos de una clienta.
// Si en la fecha el abono no está cubierto, la clienta ve el aviso al abrir su enlace y recibe
// la notificación (si la activó). Las fechas se pueden reprogramar o quitar.
//
// Un abono programado está "cubierto" por los abonos registrados desde que se programó el plan,
// en orden de fecha: lo pagado se reparte entre los programados del más antiguo al más nuevo,
// así un pago tardío cubre primero el abono vencido.

export type ScheduleState = "pagado" | "pendiente" | "hoy" | "vencido";

export interface ScheduledPayment {
  id: string;
  due_date: string;
  amount_cents: number;
  covered_cents: number;
  remaining_cents: number;
  state: ScheduleState;
  rescheduled_from: string | null;
}

export const SCHEDULE_EVERY = ["una_vez", "semanal", "quincenal", "mensual"] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];

let scheduleReady: Promise<void> | null = null;

/** Crea la tabla si el despliegue aún no aplicó la migración 0004. */
export function ensureScheduleSchema(db: D1Database): Promise<void> {
  scheduleReady ??= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS scheduled_payments (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        due_date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        created_on TEXT NOT NULL,
        rescheduled_from TEXT,
        created_by TEXT REFERENCES admins(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_client ON scheduled_payments(client_id, due_date)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_payments(due_date)`),
    ])
    .then(
      () => undefined,
      (e) => {
        scheduleReady = null;
        throw e;
      },
    );
  return scheduleReady;
}

/** Suma días a una fecha AAAA-MM-DD. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

/** Suma meses conservando el día; si el mes es más corto, usa su último día (31 ene → 28/29 feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Fechas de un plan: `count` abonos a partir de `first`, cada semana, quincena o mes. */
export function planDates(first: string, every: ScheduleEvery, count: number): string[] {
  const n = every === "una_vez" ? 1 : count;
  return Array.from({ length: n }, (_, i) =>
    every === "semanal" ? addDays(first, 7 * i) : every === "quincenal" ? addDays(first, 14 * i) : every === "mensual" ? addMonths(first, i) : first,
  );
}

/** Reparte lo pagado entre los abonos programados (puro, para probarlo sin base de datos). */
export function coverSchedule(
  rows: { id: string; due_date: string; amount_cents: number; rescheduled_from: string | null }[],
  paidCents: number,
  balanceCents: number,
  today: string,
): ScheduledPayment[] {
  let left = paidCents;
  return [...rows]
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id))
    .map((r) => {
      const covered = balanceCents <= 0 ? r.amount_cents : Math.min(r.amount_cents, Math.max(0, left));
      left -= r.amount_cents;
      const remaining = r.amount_cents - covered;
      const state: ScheduleState = remaining === 0 ? "pagado" : r.due_date < today ? "vencido" : r.due_date === today ? "hoy" : "pendiente";
      return { ...r, covered_cents: covered, remaining_cents: remaining, state };
    });
}

/** Abonos programados de una clienta con su estado a la fecha `today` (hora de México). */
export async function getSchedule(db: D1Database, clientId: string, today: string): Promise<ScheduledPayment[]> {
  await ensureScheduleSchema(db);
  const [rows, sums] = await db.batch([
    db.prepare(`SELECT id, due_date, amount_cents, rescheduled_from, created_on FROM scheduled_payments WHERE client_id = ?1`).bind(clientId),
    db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(amount_cents) FROM payments WHERE client_id = ?1 AND status = 'valid'
                     AND paid_at >= COALESCE((SELECT MIN(created_on) FROM scheduled_payments WHERE client_id = ?1), '9999')), 0) AS paid,
           COALESCE((SELECT SUM(total_cents) FROM purchases WHERE client_id = ?1 AND status = 'active'), 0)
           - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE client_id = ?1 AND status = 'valid'), 0) AS balance`,
      )
      .bind(clientId),
  ]);
  const s = sums.results[0] as { paid: number; balance: number };
  return coverSchedule(rows.results as { id: string; due_date: string; amount_cents: number; rescheduled_from: string | null }[], s.paid, s.balance, today);
}

/** El primer abono programado sin cubrir (el que toca recordar), o null. */
export function nextDue(schedule: ScheduledPayment[]): ScheduledPayment | null {
  return schedule.find((x) => x.remaining_cents > 0) ?? null;
}
