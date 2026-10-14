// Validación estricta de entradas en el servidor.

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

export class HttpError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export const MAX_AMOUNT_CENTS = 100_000_000; // 1 000 000.00 MXN por operación

/**
 * Convierte un importe en pesos ("1,250.50", "1250.5", 1250.5) a centavos enteros
 * sin pasar por aritmética de punto flotante.
 */
export function parseMoney(field: string, value: unknown, opts: { allowZero?: boolean } = {}): number {
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(field, "Importe inválido");
    s = value.toFixed(2);
    if (Math.abs(Number(s) - value) > 1e-9) throw new ValidationError(field, "Máximo dos decimales");
  } else if (typeof value === "string") {
    s = value.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  } else {
    throw new ValidationError(field, "Importe requerido");
  }
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new ValidationError(field, "Importe inválido: usa números positivos con hasta dos decimales");
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new ValidationError(field, "Importe inválido");
  if (cents === 0 && !opts.allowZero) throw new ValidationError(field, "El importe debe ser mayor que cero");
  if (cents > MAX_AMOUNT_CENTS) throw new ValidationError(field, "Importe demasiado grande");
  return cents;
}

export function formatCentsPlain(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function text(field: string, value: unknown, opts: { min?: number; max: number; required?: boolean }): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new ValidationError(field, "Texto inválido");
  // Quita caracteres de control (excepto saltos de línea y tabuladores).
  const v = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  const min = opts.min ?? (opts.required ? 1 : 0);
  if (v.length < min) throw new ValidationError(field, "Campo requerido");
  if (v.length > opts.max) throw new ValidationError(field, `Máximo ${opts.max} caracteres`);
  return v;
}

export function phone(field: string, value: unknown): string {
  const raw = text(field, value, { max: 40 });
  const digits = raw.replace(/[\s\-().+]/g, "");
  if (digits === "") return "";
  if (!/^\d{7,15}$/.test(digits)) throw new ValidationError(field, "Teléfono inválido: usa de 7 a 15 dígitos");
  return digits;
}

export function isoDate(field: string, value: unknown, opts: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required) throw new ValidationError(field, "Fecha requerida");
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(field, "Fecha inválida (AAAA-MM-DD)");
  }
  const d = new Date(value + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(field, "Fecha inválida");
  }
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) throw new ValidationError(field, "Fecha fuera de rango");
  return value;
}

export function integer(field: string, value: unknown, min: number, max: number): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(field, `Debe ser un entero entre ${min} y ${max}`);
  }
  return n;
}

export const PAYMENT_METHODS = ["efectivo", "transferencia", "tarjeta", "deposito", "otro"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function paymentMethod(field: string, value: unknown): PaymentMethod {
  if (typeof value !== "string" || !(PAYMENT_METHODS as readonly string[]).includes(value)) {
    throw new ValidationError(field, "Método de pago inválido");
  }
  return value as PaymentMethod;
}

export function uuid(field: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ValidationError(field, "Identificador inválido");
  }
  return value;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("body", "Solicitud inválida");
  return value as Record<string, unknown>;
}
