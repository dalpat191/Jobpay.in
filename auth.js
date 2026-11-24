// Password hashing (scrypt, built in) and session tokens. No dependencies.
const crypto = require("crypto");
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
const DUMMY_SALT = crypto.randomBytes(16);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + (await scrypt(pw, salt)).toString("hex");
}
// Unknown user => still burn the same time, so response time does not reveal who has an account.
async function verifyPassword(pw, stored) {
  if (!stored) { await scrypt(pw, DUMMY_SALT); return false; }
  const [s, h] = stored.split(":");
  const k = await scrypt(pw, Buffer.from(s, "hex")), hb = Buffer.from(h, "hex");
  return hb.length === k.length && crypto.timingSafeEqual(hb, k);
}
const newToken = () => crypto.randomBytes(32).toString("hex");
const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex"); // DB stores only the hash

module.exports = { hashPassword, verifyPassword, newToken, hashToken };
