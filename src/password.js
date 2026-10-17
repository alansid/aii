// C-223 密碼雜湊：PBKDF2-SHA256 加鹽慢雜湊（WebCrypto，Workers 與 Node 都能跑）。
// 存的格式：pbkdf2-sha256$次數$鹽$雜湊，次數寫在裡面，之後要調整也不影響舊密碼。
// Workers 的 PBKDF2 最多 100000 次。
const ITER = 100_000;
const enc = s => new TextEncoder().encode(s);
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}

// 逐位比對（不因第一個不同就提早結束）
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function verifyPassword(password, stored) {
  const [alg, it, salt, hash] = String(stored || '').split('$');
  const iterations = Number(it);
  if (alg !== 'pbkdf2-sha256' || !(iterations > 0 && iterations <= ITER) || !salt || !hash) return false;
  try { return same(await derive(String(password), unb64(salt), iterations), unb64(hash)); } catch { return false; }
}

// 帳號：4～30 字，英文、數字、. _ -；不分大小寫（存小寫）
export const USERNAME_RULE = '帳號需為 4～30 字，只能用英文、數字、. _ -';
export const normUsername = raw => String(raw ?? '').trim().toLowerCase();
export const validUsername = u => /^[a-z0-9._-]{4,30}$/.test(u);
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
