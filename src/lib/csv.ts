import { formatCentsPlain } from "./validate";

export const money = formatCentsPlain;

/** Evita inyección de fórmulas en Excel en columnas de texto. */
function cell(value: string, numeric: boolean): string {
  let v = value;
  if (!numeric && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\r\n;]/.test(v) || v !== v.trim()) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}

/** Agrupa teléfonos con espacios para que Excel los conserve como texto. */
export function phoneText(digits: string): string {
  if (/^\d{10}$/.test(digits)) return `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  if (/^52\d{10}$/.test(digits)) return `52 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  return digits;
}

/**
 * CSV compatible con Excel en español (México): UTF-8 con BOM, separador coma,
 * punto decimal y fin de línea CRLF.
 */
export function csvResponse(name: string, header: string[], rows: string[][], numericCols: number[] = []): Response {
  const phoneCols = header.map((h, i) => (h === "Teléfono" ? i : -1)).filter((i) => i >= 0);
  const lines = [header.map((h) => cell(h, false)).join(",")];
  for (const r of rows) {
    lines.push(
      r
        .map((v, i) => cell(phoneCols.includes(i) ? phoneText(v) : v, numericCols.includes(i)))
        .join(","),
    );
  }
  const body = "﻿" + lines.join("\r\n") + "\r\n";
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
