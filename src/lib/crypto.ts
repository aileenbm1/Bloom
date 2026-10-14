// Utilidades criptográficas basadas en WebCrypto (disponible en Workers).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/** Comparación en tiempo constante de dos cadenas. */
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // Compara contra sí misma para no filtrar la longitud por tiempo.
    crypto.subtle.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/** Token aleatorio de 32 bytes (256 bits) en base64url: 43 caracteres. */
export function newToken(): string {
  return b64url(randomBytes(32));
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// --- Contraseñas: PBKDF2-SHA256 ---------------------------------------------
// Formato: pbkdf2_sha256$<iteraciones>$<sal base64>$<hash base64>
// Workers admite como máximo 100 000 iteraciones de PBKDF2.
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const h = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(h)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000) return false;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, expected);
}

// Hash ficticio para igualar tiempos cuando el usuario no existe.
export const DUMMY_HASH =
  "pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// --- Claves derivadas de APP_SECRET -----------------------------------------
const keyCache = new Map<string, Promise<CryptoKey>>();

async function baseKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
}

function derived(secret: string, purpose: "link-encryption" | "ip-hash"): Promise<CryptoKey> {
  const cacheKey = purpose + ":" + secret;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const base = await baseKey(secret);
      const params = { name: "HKDF", hash: "SHA-256", salt: enc.encode("bloom-v1"), info: enc.encode(purpose) };
      if (purpose === "link-encryption") {
        return crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      }
      return crypto.subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
    })();
    keyCache.set(cacheKey, p);
  }
  return p;
}

export async function encryptToken(secret: string, token: string): Promise<string> {
  const key = await derived(secret, "link-encryption");
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptToken(secret: string, payload: string): Promise<string | null> {
  try {
    const [v, ivs, cts] = payload.split(".");
    if (v !== "v1") return null;
    const key = await derived(secret, "link-encryption");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(ivs) }, key, fromB64url(cts));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** Hash con clave de la IP: permite limitar intentos sin guardar la IP en claro. */
export async function hashIp(secret: string, ip: string): Promise<string> {
  const key = await derived(secret, "ip-hash");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ip));
  return hex(sig).slice(0, 32);
}
