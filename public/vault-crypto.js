/* MemKey 共享加密核心 —— 浏览器与 Node 通用，零依赖。
 * 作为经典 <script> 加载时，本文件顶层声明的常量与函数进入全局词法环境，
 * index.html 内联脚本可直接使用（enc/dec/b64/unb64/KDF_ITERS/加密与恢复码/TOTP 等）；
 * 在 Node 中 require() 时通过 module.exports 暴露同一套 API（供 memkey-cli.js 使用）。
 * 两端共用同一实现，保证密文格式与解锁行为完全一致。
 */
'use strict';

/* Node 18 默认无全局 webcrypto（19 起才有），补挂到 globalThis；浏览器已有，跳过 */
if (typeof globalThis.crypto === 'undefined' && typeof require === 'function') {
  globalThis.crypto = require('crypto').webcrypto;
}

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for(let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
const KDF_ITERS = 600000;

/* ================= 加密核心 =================
 * 密码库外壳 v2：随机数据密钥 DK 加密整库，主密码与恢复码各自包裹 DK。
 * 修改主密码只需重新包裹 DK，无需改写库密文；恢复码信封不随主密码变化。
 * v1（整库直接由主密码密钥加密）在解锁时自动迁移。
 */
async function deriveMasterBits(password, salt, iterations){
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations, hash:'SHA-256' }, base, 256);
}
function masterKeyFromBits(bits){
  return crypto.subtle.importKey('raw', bits, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function encryptJSON(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), data: b64(ct) };
}
async function decryptJSON(key, env){
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data));
  return JSON.parse(dec.decode(pt));
}
function makeBlobV2(kdf, wpw, extras){
  const blob = { v:2, kdf, wpw };
  return extras ? Object.assign(blob, extras) : blob;
}

/* ================= 恢复码（DK 的第二重包裹） ================= */
const REC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I / L / O / 0 / 1；31 字符 × 20 位 ≈ 99 bit
const REC_ITERS = 100000; // 恢复码是 ~99bit 随机串，10 万轮足够，且解锁派生更快
function randInt(max){ // 拒绝采样，保证均匀
  const lim = Math.floor(0x100000000 / max) * max;
  const u = new Uint32Array(1);
  do { crypto.getRandomValues(u); } while(u[0] >= lim);
  return u[0] % max;
}
function genRecCode(){
  let s = '';
  for(let i = 0; i < 20; i++) s += REC_ALPHABET[randInt(REC_ALPHABET.length)];
  return s.match(/.{5}/g).join('-');
}
function normalizeRecCode(raw){
  return String(raw || '').toUpperCase().replace(/[\s\-]/g, '');
}
async function deriveRecKey(code, salt, iterations){
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations, hash:'SHA-256' }, base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function makeRecEnvelope(code, dkBits){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveRecKey(normalizeRecCode(code), salt, REC_ITERS);
  return Object.assign({ kdf:{ name:'PBKDF2-SHA256', iterations:REC_ITERS, salt:b64(salt) } }, await encryptJSON(key, { dk: b64(dkBits) }));
}
async function unwrapRec(code, rec){
  const key = await deriveRecKey(normalizeRecCode(code), unb64(rec.kdf.salt), rec.kdf.iterations);
  return decryptJSON(key, rec); // { dk: ... }
}

/* ================= TOTP（RFC 6238，SHA-1 / 6 位 / 30 秒） ================= */
const TOTP_PERIOD = 30, TOTP_DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function normalizeTotpInput(raw){
  const s = String(raw || '').trim();
  if(!s) return '';
  let secret = s;
  const m = s.match(/^otpauth:\/\/totp\/[^?]*\?(.*)$/i);
  if(m) secret = new URLSearchParams(m[1]).get('secret') || '';
  return secret.replace(/[\s\-_]/g, '').toUpperCase().replace(/=+$/, '');
}
function decodeBase32(str){
  const s = String(str || '').toUpperCase();
  if(!s) return null;
  let bits = 0, val = 0;
  const out = [];
  for(const ch of s){
    const idx = B32.indexOf(ch);
    if(idx < 0) return null;
    val = (val << 5) | idx;
    bits += 5;
    if(bits >= 8){ bits -= 8; out.push((val >>> bits) & 0xff); }
  }
  return out.length ? new Uint8Array(out) : null;
}
async function totpCode(secret, now = Date.now()){
  try{
    const keyBytes = decodeBase32(secret);
    if(!keyBytes) return '';
    const counter = Math.floor(now / 1000 / TOTP_PERIOD);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name:'HMAC', hash:'SHA-1' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const off = sig[sig.length - 1] & 0x0f;
    const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
    return String(bin % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
  }catch{ return ''; }
}

/* ================= Node 导出（memkey-cli.js 使用） ================= */
if (typeof module === 'object' && module.exports) {
  module.exports = {
    enc, dec, b64, unb64, randInt, KDF_ITERS,
    deriveMasterBits, masterKeyFromBits, encryptJSON, decryptJSON, makeBlobV2,
    REC_ALPHABET, REC_ITERS, genRecCode, normalizeRecCode, deriveRecKey, makeRecEnvelope, unwrapRec,
    TOTP_PERIOD, TOTP_DIGITS, normalizeTotpInput, decodeBase32, totpCode,
  };
}
