/* crypto.js — PBKDF2-SHA256 vía WebCrypto (las contraseñas nunca salen en claro) */
'use strict';

const PBKDF2_ITERS = 60000;

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function deriveKey(password, saltHex, iters = PBKDF2_ITERS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iters, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/* ================== v10: AES-GCM para la copia de seguridad ==================
   La copia de seguridad viaja CIFRADA por el broker público: nadie (ni el
   broker) puede leer los chats sin la contraseña de la cuenta. La clave se
   deriva con PBKDF2 (sal propia, independiente del hash de autenticación)
   y se guarda en el dispositivo solo mientras la sesión está iniciada.   */

function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* clave AES-GCM 256 derivada de la contraseña (exportable: se cachea
   en el dispositivo durante la sesión para el auto-respaldo) */
async function deriveBackupKey(password, saltHex, iters = PBKDF2_ITERS) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iters, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}
async function exportKeyB64(key) {
  return bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}
async function importKeyB64(b64) {
  return crypto.subtle.importKey('raw', b64ToBytes(String(b64 || '').trim()), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/* cifra bytes → { iv (bytes), ct (bytes) } */
async function aesEncryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv, ct };
}
async function aesDecryptBytes(key, ivB64, ctBytes) {
  const iv = b64ToBytes(ivB64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctBytes));
}

async function sha256Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return bytesToHex(h);
}
