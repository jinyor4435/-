import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSession(db, userId, now) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now.toISOString());
  return token;
}

export function userFromToken(db, token, now) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.role, u.name, u.phone, u.lat, u.lng, s.created_at AS session_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  const ageDays = (now - new Date(row.session_at)) / 86400000;
  if (ageDays > SESSION_DAYS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const { session_at, ...user } = row;
  return user;
}
