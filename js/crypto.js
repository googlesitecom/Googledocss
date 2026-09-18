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
