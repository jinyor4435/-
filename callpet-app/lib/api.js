import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, createSession, userFromToken } from './auth.js';
import { checkEligibility } from './eligibility.js';
import { findCandidates, isValidBloodType, distanceKm } from './matching.js';
import { buildReport } from './report.js';
import { ARTICLES, CHALLENGE, REWARDS } from './content.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const POINTS_PER_DONATION = 100;
const BADGES = [
  { count: 1, name: '첫 헌혈' },
  { count: 3, name: '생명 지킴이' },
  { count: 5, name: '콜펫 영웅' },
];

const isoDate = (d) => d.toISOString().slice(0, 10);
const bool = (v) => (v ? 1 : 0);

function need(cond, status, message) {
  if (!cond) throw new HttpError(status, message);
}
function str(v, field, { max = 200, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    need(!required, 400, `${field} 값이 필요합니다.`);
    return null;
  }
  need(typeof v === 'string', 400, `${field} 형식이 올바르지 않습니다.`);
  const s = v.trim();
  need(!required || s.length > 0, 400, `${field} 값이 필요합니다.`);
  need(s.length <= max, 400, `${field}이(가) 너무 깁니다.`);
  return s;
}
function num(v, field, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    need(!required, 400, `${field} 값이 필요합니다.`);
    return null;
  }
  const n = Number(v);
  need(Number.isFinite(n) && n >= min && n <= max, 400, `${field} 값이 올바르지 않습니다.`);
  return n;
}
function date(v, field, { required = true } = {}) {
  const s = str(v, field, { max: 10, required });
  if (s === null) return null;
  need(/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime()), 400, `${field} 날짜 형식이 올바르지 않습니다.`);
  return s;
}
function phone(v) {
  const s = str(v, '전화번호', { max: 20 }).replace(/[-\s]/g, '');
  need(/^\d{9,11}$/.test(s), 400, '전화번호 형식이 올바르지 않습니다.');
  return s;
}
const maskPhone = (p) => p.replace(/^(\d{3})\d+(\d{4})$/, '$1-****-$2');

export function createApi(db, { adminKey = '', now = () => new Date() } = {}) {
  const q = (sql) => db.prepare(sql);
  const ts = () => now().toISOString();

  function notify(userId, kind, title, body, refId = null) {
    q('INSERT INTO notifications (user_id, kind, title, body, ref_id, read, created_at) VALUES (?,?,?,?,?,0,?)')
      .run(userId, kind, title, body, refId, ts());
  }
  function addPoints(userId, delta, reason) {
    q('INSERT INTO points (user_id, delta, reason, created_at) VALUES (?,?,?,?)').run(userId, delta, reason, ts());
  }
  function hospitalOf(user) {
    return q('SELECT h.*, u.lat, u.lng, u.phone FROM hospitals h JOIN users u ON u.id = h.user_id WHERE h.user_id = ?').get(user.id);
  }
  function ownPet(user, id) {
    const pet = q('SELECT * FROM pets WHERE id = ? AND owner_id = ?').get(Number(id), user.id);
    need(pet, 404, '반려동물을 찾을 수 없습니다.');
    return pet;
  }
  function linkedPet(hospital, id) {
    const pet = q(
      `SELECT p.* FROM pets p JOIN pet_hospitals ph ON ph.pet_id = p.id
       WHERE p.id = ? AND ph.hospital_id = ?`
    ).get(Number(id), hospital.id);
    need(pet, 404, '연결된 환자를 찾을 수 없습니다.');
    return pet;
  }
  function approvedHospital(user) {
    const h = hospitalOf(user);
    need(h, 403, '병원 계정이 아닙니다.');
    return h;
  }
  function publicUser(u) {
    return { id: u.id, role: u.role, name: u.name, phone: u.phone, lat: u.lat, lng: u.lng };
  }
  function newHospitalCode() {
    for (;;) {
      const code = randomBytes(3).toString('hex').toUpperCase();
      if (!q('SELECT 1 FROM hospitals WHERE code = ?').get(code)) return code;
    }
  }
  function donorInfo(pet) {
    const donor = q('SELECT * FROM donors WHERE pet_id = ?').get(pet.id);
    const eligibility = checkEligibility(pet, donor, now());
    return {
      registered: Boolean(donor && donor.active),
      consent_at: donor?.consent_at ?? null,
      last_donation_date: donor?.last_donation_date ?? null,
      blood_type_verified: Boolean(pet.blood_type_verified),
      ...eligibility,
    };
  }
  function petView(pet) {
    return { ...pet, neutered: Boolean(pet.neutered), vaccinated: Boolean(pet.vaccinated), healthy: Boolean(pet.healthy), blood_type_verified: Boolean(pet.blood_type_verified) };
  }
  function pointSummary(userId) {
    const total = q('SELECT COALESCE(SUM(delta),0) AS t FROM points WHERE user_id = ?').get(userId).t;
    const donations = q(
      `SELECT COUNT(*) AS c FROM matches m JOIN pets p ON p.id = m.pet_id
       WHERE p.owner_id = ? AND m.status = 'completed'`
    ).get(userId).c;
    const badges = BADGES.filter((b) => donations >= b.count).map((b) => b.name);
    return { total, donations, badges };
  }

  // 후보를 찾아 알림을 보낸다. 요청 등록 직후와 재탐색에 모두 쓴다.
  function dispatchRequest(request, hospital) {
    const candidates = findCandidates(db, request, hospital, now());
    for (const c of candidates) {
      q('INSERT INTO matches (request_id, pet_id, status, distance_km, notified_at) VALUES (?,?,?,?,?)')
        .run(request.id, c.id, 'notified', c.distance_km, ts());
      const matchId = q('SELECT id FROM matches WHERE request_id = ? AND pet_id = ?').get(request.id, c.id).id;
      notify(
        c.guardian_id,
        'transfusion_request',
        `긴급 수혈 요청: ${c.name}`,
        `${hospital.name}에서 ${request.blood_type} 혈액이 필요합니다. (약 ${c.distance_km.toFixed(1)}km, ${request.needed_by}까지)`,
        matchId
      );
    }
    return candidates.length;
  }

  const routes = [];
  const route = (method, path, auth, handler) => {
    const keys = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, pattern, keys, auth, handler });
  };

  // ───── 인증
  route('POST', '/api/signup/guardian', null, ({ body }) => {
    const name = str(body.name, '이름', { max: 40 });
    const ph = phone(body.phone);
    const password = str(body.password, '비밀번호', { max: 100 });
    need(password.length >= 8, 400, '비밀번호는 8자 이상이어야 합니다.');
    need(!q('SELECT 1 FROM users WHERE phone = ?').get(ph), 409, '이미 가입된 전화번호입니다.');
    const lat = num(body.lat, '위도', { min: -90, max: 90, required: false });
    const lng = num(body.lng, '경도', { min: -180, max: 180, required: false });
    const { hash, salt } = hashPassword(password);
    const info = q('INSERT INTO users (role, name, phone, pass_hash, salt, lat, lng, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('guardian', name, ph, hash, salt, lat, lng, ts());
    const token = createSession(db, Number(info.lastInsertRowid), now());
    return { status: 201, data: { token, user: publicUser(q('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) } };
  });

  route('POST', '/api/signup/hospital', null, ({ body }) => {
    const name = str(body.name, '병원명', { max: 60 });
    const ph = phone(body.phone);
    const password = str(body.password, '비밀번호', { max: 100 });
    need(password.length >= 8, 400, '비밀번호는 8자 이상이어야 합니다.');
    const address = str(body.address, '주소', { max: 200 });
    const license = str(body.license_no, '사업자·면허 번호', { max: 40 });
    const lat = num(body.lat, '위도', { min: -90, max: 90 });
    const lng = num(body.lng, '경도', { min: -180, max: 180 });
    need(!q('SELECT 1 FROM users WHERE phone = ?').get(ph), 409, '이미 가입된 전화번호입니다.');
    const { hash, salt } = hashPassword(password);
    const info = q('INSERT INTO users (role, name, phone, pass_hash, salt, lat, lng, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('hospital', name, ph, hash, salt, lat, lng, ts());
    const userId = Number(info.lastInsertRowid);
    q('INSERT INTO hospitals (user_id, name, address, license_no, code, status) VALUES (?,?,?,?,?,?)')
      .run(userId, name, address, license, newHospitalCode(), 'pending');
    const token = createSession(db, userId, now());
    return { status: 201, data: { token, user: publicUser(q('SELECT * FROM users WHERE id = ?').get(userId)), hospital_status: 'pending' } };
  });

  route('POST', '/api/login', null, ({ body }) => {
    const ph = phone(body.phone);
    const password = str(body.password, '비밀번호', { max: 100 });
    const user = q('SELECT * FROM users WHERE phone = ?').get(ph);
    // 존재하지 않는 계정도 동일한 시간·메시지로 응답한다.
    const fake = hashPassword('x');
    const ok = verifyPassword(password, user?.pass_hash ?? fake.hash, user?.salt ?? fake.salt);
    need(user && ok, 401, '전화번호 또는 비밀번호가 올바르지 않습니다.');
    return { data: { token: createSession(db, user.id, now()), user: publicUser(user) } };
  });

  route('GET', '/api/me', 'any', ({ user }) => {
    const data = { user: publicUser(user) };
    if (user.role === 'hospital') {
      const h = hospitalOf(user);
      data.hospital = { id: h.id, name: h.name, address: h.address, code: h.code, status: h.status };
    }
    return { data };
  });

  route('PATCH', '/api/me', 'any', ({ user, body }) => {
    const name = body.name === undefined ? user.name : str(body.name, '이름', { max: 40 });
    const lat = body.lat === undefined ? user.lat : num(body.lat, '위도', { min: -90, max: 90, required: false });
    const lng = body.lng === undefined ? user.lng : num(body.lng, '경도', { min: -180, max: 180, required: false });
    q('UPDATE users SET name = ?, lat = ?, lng = ? WHERE id = ?').run(name, lat, lng, user.id);
    return { data: { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) } };
  });

  // ───── 보호자: 반려동물
  const petFields = (body, current = {}) => {
    const species = body.species ?? current.species;
    need(['dog', 'cat'].includes(species), 400, '종은 dog 또는 cat이어야 합니다.');
    const out = {
      name: str(body.name ?? current.name, '이름', { max: 40 }),
      species,
      breed: str(body.breed ?? current.breed, '품종', { max: 40, required: false }),
      birth_date: date(body.birth_date ?? current.birth_date, '생년월일', { required: false }),
      weight_kg: num(body.weight_kg ?? current.weight_kg, '체중', { min: 0.1, max: 150, required: false }),
      neutered: bool(body.neutered ?? current.neutered),
      vaccinated: bool(body.vaccinated ?? current.vaccinated),
      healthy: bool(body.healthy ?? current.healthy),
    };
    // 혈액형은 병원이 검사로 확정한다. 보호자는 참고용으로 입력만 가능하고, 확정 전에는 매칭에 쓰지 않는다.
    const bt = body.blood_type ?? current.blood_type ?? null;
    if (bt) need(isValidBloodType(species, bt), 400, '혈액형이 올바르지 않습니다.');
    out.blood_type = bt || null;
    return out;
  };

  route('GET', '/api/pets', 'guardian', ({ user }) => {
    const pets = q('SELECT * FROM pets WHERE owner_id = ? ORDER BY id').all(user.id)
      .map((p) => ({ ...petView(p), donor: donorInfo(p) }));
    return { data: { pets } };
  });

  route('POST', '/api/pets', 'guardian', ({ user, body }) => {
    const f = petFields(body);
    const info = q(
      `INSERT INTO pets (owner_id, name, species, breed, birth_date, weight_kg, neutered, vaccinated, healthy, blood_type, blood_type_verified, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
    ).run(user.id, f.name, f.species, f.breed, f.birth_date, f.weight_kg, f.neutered, f.vaccinated, f.healthy, f.blood_type, ts());
    const pet = q('SELECT * FROM pets WHERE id = ?').get(info.lastInsertRowid);
    return { status: 201, data: { pet: { ...petView(pet), donor: donorInfo(pet) } } };
  });

  route('PATCH', '/api/pets/:id', 'guardian', ({ user, params, body }) => {
    const pet = ownPet(user, params.id);
    need(body.species === undefined || body.species === pet.species, 400, '종은 바꿀 수 없습니다.');
    const f = petFields(body, pet);
    // 보호자가 혈액형을 바꾸면 병원 확정이 풀린다.
    const verified = f.blood_type === pet.blood_type ? pet.blood_type_verified : 0;
    q(`UPDATE pets SET name=?, breed=?, birth_date=?, weight_kg=?, neutered=?, vaccinated=?, healthy=?, blood_type=?, blood_type_verified=? WHERE id=?`)
      .run(f.name, f.breed, f.birth_date, f.weight_kg, f.neutered, f.vaccinated, f.healthy, f.blood_type, verified, pet.id);
    const updated = q('SELECT * FROM pets WHERE id = ?').get(pet.id);
    return { data: { pet: { ...petView(updated), donor: donorInfo(updated) } } };
  });

  route('POST', '/api/pets/:id/hospitals', 'guardian', ({ user, params, body }) => {
    const pet = ownPet(user, params.id);
    const code = str(body.code, '병원 코드', { max: 12 }).toUpperCase();
    const h = q("SELECT * FROM hospitals WHERE code = ? AND status = 'approved'").get(code);
    need(h, 404, '병원 코드를 찾을 수 없습니다.');
    q('INSERT OR IGNORE INTO pet_hospitals (pet_id, hospital_id) VALUES (?,?)').run(pet.id, h.id);
    return { status: 201, data: { hospital: { id: h.id, name: h.name } } };
  });

  route('GET', '/api/pets/:id/hospitals', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    const hospitals = q(
      `SELECT h.id, h.name FROM hospitals h JOIN pet_hospitals ph ON ph.hospital_id = h.id WHERE ph.pet_id = ?`
    ).all(pet.id);
    return { data: { hospitals } };
  });

  route('DELETE', '/api/pets/:id/hospitals/:hid', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    q('DELETE FROM pet_hospitals WHERE pet_id = ? AND hospital_id = ?').run(pet.id, Number(params.hid));
    return { data: { ok: true } };
  });

  // ───── 보호자: 수첩(병원 기록 + 일상 기록)
  route('GET', '/api/pets/:id/records', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    const records = q(
      `SELECT r.id, r.kind, r.date, r.memo, r.next_date, h.name AS hospital_name
       FROM records r JOIN hospitals h ON h.id = r.hospital_id WHERE r.pet_id = ? ORDER BY r.date DESC, r.id DESC`
    ).all(pet.id);
    return { data: { records } };
  });

  route('GET', '/api/pets/:id/logs', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    const logs = q('SELECT * FROM health_logs WHERE pet_id = ? ORDER BY logged_at DESC, id DESC LIMIT 100').all(pet.id);
    return { data: { logs } };
  });

  route('POST', '/api/pets/:id/logs', 'guardian', ({ user, params, body }) => {
    const pet = ownPet(user, params.id);
    const kind = body.kind;
    need(['walk', 'meal', 'water', 'groom', 'memo'].includes(kind), 400, '기록 종류가 올바르지 않습니다.');
    const value = num(body.value, '값', { min: 0, max: 100000, required: false });
    const memo = str(body.memo, '메모', { max: 300, required: false });
    const info = q('INSERT INTO health_logs (pet_id, kind, value, memo, logged_at) VALUES (?,?,?,?,?)')
      .run(pet.id, kind, value, memo, ts());
    if (kind === 'walk' && value >= 10) {
      // 산책 10분 이상이면 하루 한 번 포인트를 준다.
      const today = isoDate(now());
      const already = q(
        `SELECT 1 FROM points WHERE user_id = ? AND reason = 'walk' AND substr(created_at,1,10) = ?`
      ).get(user.id, today);
      if (!already) addPoints(user.id, 10, 'walk');
    }
    return { status: 201, data: { log: q('SELECT * FROM health_logs WHERE id = ?').get(info.lastInsertRowid) } };
  });

  route('GET', '/api/notices', 'guardian', ({ user }) => {
    const notices = q(
      `SELECT DISTINCT n.id, n.title, n.body, n.created_at, h.name AS hospital_name
       FROM notices n JOIN hospitals h ON h.id = n.hospital_id
       JOIN pet_hospitals ph ON ph.hospital_id = h.id JOIN pets p ON p.id = ph.pet_id
       WHERE p.owner_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 30`
    ).all(user.id);
    return { data: { notices } };
  });

  // ───── 콜펫: 보호자
  route('PUT', '/api/pets/:id/donor', 'guardian', ({ user, params, body }) => {
    const pet = ownPet(user, params.id);
    need(body.consent === true, 400, '헌혈 동의가 필요합니다.');
    need(user.lat != null && user.lng != null, 400, '내 위치를 먼저 등록해 주세요.');
    q(`INSERT INTO donors (pet_id, consent_at, active) VALUES (?,?,1)
       ON CONFLICT(pet_id) DO UPDATE SET active = 1, consent_at = excluded.consent_at`).run(pet.id, ts());
    return { data: { donor: donorInfo(pet) } };
  });

  route('DELETE', '/api/pets/:id/donor', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    q('UPDATE donors SET active = 0 WHERE pet_id = ?').run(pet.id);
    q("UPDATE matches SET status = 'closed' WHERE pet_id = ? AND status = 'notified'").run(pet.id);
    return { data: { donor: donorInfo(pet) } };
  });

  route('GET', '/api/matches', 'guardian', ({ user }) => {
    const matches = q(
      `SELECT m.id, m.status, m.distance_km, m.notified_at, p.name AS pet_name,
              r.blood_type, r.units, r.needed_by, r.note, r.status AS request_status,
              h.name AS hospital_name, h.address AS hospital_address, hu.phone AS hospital_phone
       FROM matches m JOIN pets p ON p.id = m.pet_id JOIN requests r ON r.id = m.request_id
       JOIN hospitals h ON h.id = r.hospital_id JOIN users hu ON hu.id = h.user_id
       WHERE p.owner_id = ? ORDER BY m.id DESC LIMIT 50`
    ).all(user.id).map((m) =>
      // 병원 연락처는 수락한 뒤에만 공개한다.
      ['accepted', 'completed'].includes(m.status) ? m : { ...m, hospital_phone: null, hospital_address: null }
    );
    return { data: { matches } };
  });

  route('POST', '/api/matches/:id/respond', 'guardian', ({ user, params, body }) => {
    const m = q(
      `SELECT m.*, r.status AS request_status, r.hospital_id, p.name AS pet_name FROM matches m
       JOIN pets p ON p.id = m.pet_id JOIN requests r ON r.id = m.request_id
       WHERE m.id = ? AND p.owner_id = ?`
    ).get(Number(params.id), user.id);
    need(m, 404, '요청을 찾을 수 없습니다.');
    need(m.status === 'notified', 409, '이미 응답했거나 종료된 요청입니다.');
    need(m.request_status === 'open', 409, '이미 종료된 수혈 요청입니다.');
    need(typeof body.accept === 'boolean', 400, 'accept 값이 필요합니다.');
    q('UPDATE matches SET status = ?, responded_at = ? WHERE id = ?').run(body.accept ? 'accepted' : 'declined', ts(), m.id);
    if (body.accept) {
      const hospital = q('SELECT user_id FROM hospitals WHERE id = ?').get(m.hospital_id);
      notify(hospital.user_id, 'match_accepted', '헌혈 수락', `${m.pet_name}의 보호자가 헌혈을 수락했습니다.`, m.id);
    }
    return { data: { status: body.accept ? 'accepted' : 'declined' } };
  });

  route('GET', '/api/notifications', 'any', ({ user }) => {
    const items = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id)
      .map((n) => ({ ...n, read: Boolean(n.read) }));
    return { data: { notifications: items, unread: items.filter((n) => !n.read).length } };
  });

  route('POST', '/api/notifications/read', 'any', ({ user }) => {
    q('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
    return { data: { ok: true } };
  });

  route('GET', '/api/points', 'guardian', ({ user }) => {
    const history = q('SELECT delta, reason, created_at FROM points WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(user.id);
    return { data: { ...pointSummary(user.id), history } };
  });

  // 홈 배너용: 열린 요청 수와, 내 반려동물 중 헌혈 가능한 아이
  route('GET', '/api/callpet/summary', 'guardian', ({ user }) => {
    const open = q("SELECT COUNT(*) AS c FROM requests WHERE status = 'open'").get().c;
    const pets = q('SELECT * FROM pets WHERE owner_id = ?').all(user.id);
    const donors = pets.map((p) => ({ id: p.id, name: p.name, ...donorInfo(p) }));
    return { data: { open_requests: open, donors } };
  });

  // ───── 병원
  route('GET', '/api/hospital/patients', 'hospital', ({ user }) => {
    const h = approvedHospital(user);
    const patients = q(
      `SELECT p.id, p.name, p.species, p.breed, p.birth_date, p.weight_kg, p.blood_type, p.blood_type_verified,
              u.name AS guardian_name, u.phone AS guardian_phone
       FROM pets p JOIN pet_hospitals ph ON ph.pet_id = p.id JOIN users u ON u.id = p.owner_id
       WHERE ph.hospital_id = ? ORDER BY p.name`
    ).all(h.id).map((p) => ({ ...p, blood_type_verified: Boolean(p.blood_type_verified), guardian_phone: maskPhone(p.guardian_phone) }));
    return { data: { patients } };
  });

  const needApproved = (h) => need(h.status === 'approved', 403, '관리자 승인이 완료된 병원만 사용할 수 있습니다.');

  route('POST', '/api/hospital/patients/:id/records', 'hospital', ({ user, params, body }) => {
    const h = approvedHospital(user);
    needApproved(h);
    const pet = linkedPet(h, params.id);
    need(['visit', 'vaccine', 'medication'].includes(body.kind), 400, '기록 종류가 올바르지 않습니다.');
    const d = date(body.date, '날짜');
    const memo = str(body.memo, '메모', { max: 500, required: false });
    const next = date(body.next_date, '다음 방문일', { required: false });
    const info = q('INSERT INTO records (pet_id, hospital_id, kind, date, memo, next_date) VALUES (?,?,?,?,?,?)')
      .run(pet.id, h.id, body.kind, d, memo, next);
    if (body.kind === 'vaccine') q('UPDATE pets SET vaccinated = 1 WHERE id = ?').run(pet.id);
    const owner = q('SELECT owner_id FROM pets WHERE id = ?').get(pet.id).owner_id;
    notify(owner, 'record_added', `${pet.name} 진료 기록이 추가되었습니다`, `${h.name}에서 기록을 남겼습니다.`, Number(info.lastInsertRowid));
    return { status: 201, data: { id: Number(info.lastInsertRowid) } };
  });

  route('PUT', '/api/hospital/patients/:id/blood-type', 'hospital', ({ user, params, body }) => {
    const h = approvedHospital(user);
    needApproved(h);
    const pet = linkedPet(h, params.id);
    need(isValidBloodType(pet.species, body.blood_type), 400, '혈액형이 올바르지 않습니다.');
    q('UPDATE pets SET blood_type = ?, blood_type_verified = 1 WHERE id = ?').run(body.blood_type, pet.id);
    return { data: { ok: true } };
  });

  route('POST', '/api/hospital/notices', 'hospital', ({ user, body }) => {
    const h = approvedHospital(user);
    needApproved(h);
    const title = str(body.title, '제목', { max: 80 });
    const text = str(body.body, '내용', { max: 1000 });
    const info = q('INSERT INTO notices (hospital_id, title, body, created_at) VALUES (?,?,?,?)').run(h.id, title, text, ts());
    const owners = q(
      `SELECT DISTINCT p.owner_id FROM pets p JOIN pet_hospitals ph ON ph.pet_id = p.id WHERE ph.hospital_id = ?`
    ).all(h.id);
    for (const o of owners) notify(o.owner_id, 'notice', `${h.name} 공지`, title, Number(info.lastInsertRowid));
    return { status: 201, data: { id: Number(info.lastInsertRowid), notified: owners.length } };
  });

  route('POST', '/api/hospital/requests', 'hospital', ({ user, body }) => {
    const h = approvedHospital(user);
    needApproved(h);
    const species = body.species;
    need(['dog', 'cat'].includes(species), 400, '종은 dog 또는 cat이어야 합니다.');
    need(isValidBloodType(species, body.blood_type), 400, '혈액형이 올바르지 않습니다.');
    const units = num(body.units, '필요 수량', { min: 1, max: 10 });
    need(Number.isInteger(units), 400, '필요 수량은 정수여야 합니다.');
    const neededBy = str(body.needed_by, '필요 시한', { max: 40 });
    const note = str(body.note, '메모', { max: 300, required: false });
    const info = q('INSERT INTO requests (hospital_id, species, blood_type, units, needed_by, note, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(h.id, species, body.blood_type, units, neededBy, note, 'open', ts());
    const request = q('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
    const notified = dispatchRequest(request, h);
    return { status: 201, data: { request, notified } };
  });

  route('GET', '/api/hospital/requests', 'hospital', ({ user }) => {
    const h = approvedHospital(user);
    const requests = q(
      `SELECT r.*,
        (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id) AS notified,
        (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id AND m.status IN ('accepted','completed')) AS accepted,
        (SELECT COUNT(*) FROM matches m WHERE m.request_id = r.id AND m.status = 'completed') AS completed
       FROM requests r WHERE r.hospital_id = ? ORDER BY r.id DESC LIMIT 50`
    ).all(h.id);
    return { data: { requests } };
  });

  route('GET', '/api/hospital/requests/:id', 'hospital', ({ user, params }) => {
    const h = approvedHospital(user);
    const request = q('SELECT * FROM requests WHERE id = ? AND hospital_id = ?').get(Number(params.id), h.id);
    need(request, 404, '요청을 찾을 수 없습니다.');
    const matches = q(
      `SELECT m.id, m.status, m.distance_km, p.name AS pet_name, p.species, p.blood_type, p.weight_kg,
              u.name AS guardian_name, u.phone AS guardian_phone
       FROM matches m JOIN pets p ON p.id = m.pet_id JOIN users u ON u.id = p.owner_id
       WHERE m.request_id = ? ORDER BY m.distance_km`
    ).all(request.id).map((m) =>
      // 보호자 이름·연락처는 수락한 뒤에만 공개한다.
      ['accepted', 'completed'].includes(m.status) ? m : { ...m, guardian_name: null, guardian_phone: null }
    );
    return { data: { request, matches } };
  });

  route('POST', '/api/hospital/requests/:id/rematch', 'hospital', ({ user, params }) => {
    const h = approvedHospital(user);
    const request = q("SELECT * FROM requests WHERE id = ? AND hospital_id = ? AND status = 'open'").get(Number(params.id), h.id);
    need(request, 404, '진행 중인 요청을 찾을 수 없습니다.');
    return { data: { notified: dispatchRequest(request, h) } };
  });

  route('POST', '/api/hospital/requests/:id/cancel', 'hospital', ({ user, params }) => {
    const h = approvedHospital(user);
    const request = q("SELECT * FROM requests WHERE id = ? AND hospital_id = ? AND status = 'open'").get(Number(params.id), h.id);
    need(request, 404, '진행 중인 요청을 찾을 수 없습니다.');
    q("UPDATE requests SET status = 'cancelled' WHERE id = ?").run(request.id);
    q("UPDATE matches SET status = 'closed' WHERE request_id = ? AND status IN ('notified','accepted')").run(request.id);
    return { data: { ok: true } };
  });

  route('POST', '/api/hospital/matches/:id/complete', 'hospital', ({ user, params }) => {
    const h = approvedHospital(user);
    const m = q(
      `SELECT m.*, r.units, r.hospital_id, r.status AS request_status, p.owner_id, p.name AS pet_name
       FROM matches m JOIN requests r ON r.id = m.request_id JOIN pets p ON p.id = m.pet_id
       WHERE m.id = ? AND r.hospital_id = ?`
    ).get(Number(params.id), h.id);
    need(m, 404, '매칭을 찾을 수 없습니다.');
    need(m.status === 'accepted', 409, '수락된 매칭만 완료할 수 있습니다.');
    need(m.request_status === 'open', 409, '진행 중인 요청이 아닙니다.');
    const today = isoDate(now());
    q("UPDATE matches SET status = 'completed' WHERE id = ?").run(m.id);
    q('UPDATE donors SET last_donation_date = ? WHERE pet_id = ?').run(today, m.pet_id);
    addPoints(m.owner_id, POINTS_PER_DONATION, 'donation');
    notify(m.owner_id, 'donation_done', '헌혈 완료', `${m.pet_name} 덕분에 한 생명을 도왔습니다. 감사합니다!`, m.id);
    q('INSERT INTO records (pet_id, hospital_id, kind, date, memo) VALUES (?,?,?,?,?)')
      .run(m.pet_id, h.id, 'visit', today, '헌혈 완료');
    const done = q("SELECT COUNT(*) AS c FROM matches WHERE request_id = ? AND status = 'completed'").get(m.request_id).c;
    let fulfilled = false;
    if (done >= m.units) {
      q("UPDATE requests SET status = 'fulfilled' WHERE id = ?").run(m.request_id);
      q("UPDATE matches SET status = 'closed' WHERE request_id = ? AND status IN ('notified','accepted')").run(m.request_id);
      fulfilled = true;
    }
    return { data: { completed: done, units: m.units, fulfilled } };
  });

  // ───── 2차: 케어 리포트(규칙 기반 요약)
  route('GET', '/api/pets/:id/report', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    const records = q(
      `SELECT r.kind, r.date, r.memo, r.next_date, h.name AS hospital_name
       FROM records r JOIN hospitals h ON h.id = r.hospital_id WHERE r.pet_id = ?`
    ).all(pet.id);
    const donor = q('SELECT * FROM donors WHERE pet_id = ?').get(pet.id);
    return { data: { report: buildReport(pet, records, donor, now()) } };
  });

  // ───── 2차: 예약
  const APPT_STATUS_TEXT = { confirmed: '확정', declined: '거절', cancelled: '취소' };
  route('POST', '/api/pets/:id/appointments', 'guardian', ({ user, params, body }) => {
    const pet = ownPet(user, params.id);
    const hospitalId = num(body.hospital_id, '병원', { min: 1 });
    const link = q(
      `SELECT h.* FROM hospitals h JOIN pet_hospitals ph ON ph.hospital_id = h.id
       WHERE h.id = ? AND ph.pet_id = ? AND h.status = 'approved'`
    ).get(hospitalId, pet.id);
    need(link, 404, '연결된 병원이 아닙니다. 병원 코드로 먼저 연결해 주세요.');
    const d = date(body.date, '날짜');
    need(d >= isoDate(now()), 400, '지난 날짜는 예약할 수 없습니다.');
    const time = str(body.time, '시간', { max: 5 });
    need(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 400, '시간 형식이 올바르지 않습니다.');
    const reason = str(body.reason, '방문 사유', { max: 200, required: false });
    const dup = q(
      `SELECT 1 FROM appointments WHERE hospital_id = ? AND date = ? AND time = ? AND status IN ('requested','confirmed')`
    ).get(link.id, d, time);
    need(!dup, 409, '이미 예약이 있는 시간입니다. 다른 시간을 선택해 주세요.');
    const info = q('INSERT INTO appointments (pet_id, hospital_id, date, time, reason, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(pet.id, link.id, d, time, reason, 'requested', ts());
    notify(link.user_id, 'appointment_requested', '예약 요청', `${pet.name} ${d} ${time} 예약이 요청되었습니다.`, Number(info.lastInsertRowid));
    return { status: 201, data: { id: Number(info.lastInsertRowid) } };
  });

  route('GET', '/api/appointments', 'guardian', ({ user }) => {
    const appointments = q(
      `SELECT a.id, a.pet_id, a.date, a.time, a.reason, a.status, p.name AS pet_name, h.name AS hospital_name
       FROM appointments a JOIN pets p ON p.id = a.pet_id JOIN hospitals h ON h.id = a.hospital_id
       WHERE p.owner_id = ? ORDER BY a.date DESC, a.time DESC LIMIT 30`
    ).all(user.id);
    return { data: { appointments } };
  });

  route('POST', '/api/appointments/:id/cancel', 'guardian', ({ user, params }) => {
    const a = q(
      `SELECT a.*, h.user_id AS hospital_user, p.name AS pet_name FROM appointments a
       JOIN pets p ON p.id = a.pet_id JOIN hospitals h ON h.id = a.hospital_id
       WHERE a.id = ? AND p.owner_id = ?`
    ).get(Number(params.id), user.id);
    need(a, 404, '예약을 찾을 수 없습니다.');
    need(['requested', 'confirmed'].includes(a.status), 409, '이미 처리된 예약입니다.');
    q("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(a.id);
    notify(a.hospital_user, 'appointment_cancelled', '예약 취소', `${a.pet_name} ${a.date} ${a.time} 예약이 취소되었습니다.`, a.id);
    return { data: { ok: true } };
  });

  route('GET', '/api/hospital/appointments', 'hospital', ({ user }) => {
    const h = approvedHospital(user);
    const appointments = q(
      `SELECT a.id, a.date, a.time, a.reason, a.status, p.name AS pet_name, p.species, u.name AS guardian_name
       FROM appointments a JOIN pets p ON p.id = a.pet_id JOIN users u ON u.id = p.owner_id
       WHERE a.hospital_id = ? ORDER BY a.date, a.time LIMIT 100`
    ).all(h.id);
    return { data: { appointments } };
  });

  route('POST', '/api/hospital/appointments/:id/:action', 'hospital', ({ user, params }) => {
    const h = approvedHospital(user);
    needApproved(h);
    need(['confirm', 'decline'].includes(params.action), 400, '알 수 없는 작업입니다.');
    const a = q(
      `SELECT a.*, p.owner_id, p.name AS pet_name FROM appointments a JOIN pets p ON p.id = a.pet_id
       WHERE a.id = ? AND a.hospital_id = ?`
    ).get(Number(params.id), h.id);
    need(a, 404, '예약을 찾을 수 없습니다.');
    need(a.status === 'requested', 409, '이미 처리된 예약입니다.');
    const status = params.action === 'confirm' ? 'confirmed' : 'declined';
    q('UPDATE appointments SET status = ? WHERE id = ?').run(status, a.id);
    notify(a.owner_id, 'appointment_' + status, `예약 ${APPT_STATUS_TEXT[status]}`, `${h.name} ${a.date} ${a.time} ${a.pet_name} 예약이 ${APPT_STATUS_TEXT[status]}되었습니다.`, a.id);
    return { data: { status } };
  });

  // ───── 2차: 케어 콘텐츠 · 7일 챌린지
  route('GET', '/api/content', 'guardian', ({ user }) => {
    const species = new Set(q('SELECT DISTINCT species FROM pets WHERE owner_id = ?').all(user.id).map((r) => r.species));
    const articles = ARTICLES.filter((a) => a.species === 'all' || species.has(a.species) || species.size === 0);
    return { data: { articles, challenge: CHALLENGE } };
  });

  function challengeState(pet) {
    const total = q('SELECT COUNT(*) AS c FROM checkins WHERE pet_id = ?').get(pet.id).c;
    const checkedToday = Boolean(q('SELECT 1 FROM checkins WHERE pet_id = ? AND day = ?').get(pet.id, isoDate(now())));
    return { total, round_done: total % CHALLENGE.days, completed_rounds: Math.floor(total / CHALLENGE.days), checked_today: checkedToday, days: CHALLENGE.days };
  }
  route('GET', '/api/pets/:id/challenge', 'guardian', ({ user, params }) => ({ data: challengeState(ownPet(user, params.id)) }));
  route('POST', '/api/pets/:id/challenge/checkin', 'guardian', ({ user, params }) => {
    const pet = ownPet(user, params.id);
    const day = isoDate(now());
    need(!q('SELECT 1 FROM checkins WHERE pet_id = ? AND day = ?').get(pet.id, day), 409, '오늘은 이미 체크인했어요.');
    q('INSERT INTO checkins (pet_id, day) VALUES (?, ?)').run(pet.id, day);
    const state = challengeState(pet);
    const completed = state.total % CHALLENGE.days === 0;
    if (completed) {
      addPoints(user.id, CHALLENGE.rewardPoints, 'challenge');
      notify(user.id, 'challenge_done', '챌린지 완료', `${pet.name}와 ${CHALLENGE.name}를 완료했어요! +${CHALLENGE.rewardPoints}P`);
    }
    return { status: 201, data: { ...state, completed, points: completed ? CHALLENGE.rewardPoints : 0 } };
  });

  // ───── 2차: 포인트 교환(시연용 카탈로그)
  route('GET', '/api/rewards', 'guardian', ({ user }) => {
    const total = pointSummary(user.id).total;
    return { data: { total, rewards: REWARDS.map((r) => ({ ...r, affordable: total >= r.cost })) } };
  });
  route('POST', '/api/rewards/:id/redeem', 'guardian', ({ user, params }) => {
    const reward = REWARDS.find((r) => r.id === params.id);
    need(reward, 404, '교환 항목을 찾을 수 없습니다.');
    need(pointSummary(user.id).total >= reward.cost, 409, '포인트가 부족합니다.');
    addPoints(user.id, -reward.cost, `redeem:${reward.id}`);
    q('INSERT INTO redemptions (user_id, reward_id, cost, created_at) VALUES (?,?,?,?)').run(user.id, reward.id, reward.cost, ts());
    return { status: 201, data: { total: pointSummary(user.id).total, reward } };
  });

  // ───── 관리자: 병원 승인
  route('GET', '/api/admin/hospitals', 'admin', ({ query }) => {
    const status = query.get('status') || 'pending';
    return { data: { hospitals: q('SELECT id, name, address, license_no, code, status FROM hospitals WHERE status = ?').all(status) } };
  });
  route('POST', '/api/admin/hospitals/:id/:action', 'admin', ({ params }) => {
    need(['approve', 'reject'].includes(params.action), 400, '알 수 없는 작업입니다.');
    const status = params.action === 'approve' ? 'approved' : 'rejected';
    const info = q('UPDATE hospitals SET status = ? WHERE id = ?').run(status, Number(params.id));
    need(info.changes === 1, 404, '병원을 찾을 수 없습니다.');
    const h = q('SELECT user_id, name FROM hospitals WHERE id = ?').get(Number(params.id));
    notify(h.user_id, 'hospital_status', status === 'approved' ? '병원 승인 완료' : '병원 승인 거절', `${h.name} 계정이 ${status === 'approved' ? '승인' : '거절'}되었습니다.`);
    return { data: { status } };
  });

  // ───── 디스패치
  return async function handle(method, pathname, query, headers, body) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let user = null;
      if (r.auth === 'admin') {
        const given = String(headers['x-admin-key'] ?? '');
        need(adminKey && given.length === adminKey.length && given === adminKey, 403, '관리자 권한이 필요합니다.');
      } else if (r.auth) {
        const auth = String(headers.authorization ?? '');
        user = userFromToken(db, auth.startsWith('Bearer ') ? auth.slice(7) : '', now());
        need(user, 401, '로그인이 필요합니다.');
        if (r.auth !== 'any') need(user.role === r.auth, 403, '접근 권한이 없습니다.');
      }
      const result = r.handler({ user, params, query, body: body ?? {} });
      return { status: result.status ?? 200, data: result.data };
    }
    throw new HttpError(404, '존재하지 않는 API입니다.');
  };
}

export { distanceKm };
