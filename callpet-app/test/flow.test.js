import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createApi, HttpError } from '../lib/api.js';

const ADMIN = 'test-admin-key';

function setup() {
  const db = openDb();
  const clock = { now: new Date('2026-10-20T09:00:00Z') };
  const api = createApi(db, { adminKey: ADMIN, now: () => clock.now });
  const call = async (method, path, { token, body, admin } = {}) => {
    const url = new URL(path, 'http://x');
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (admin) headers['x-admin-key'] = ADMIN;
    return api(method, url.pathname, url.searchParams, headers, body);
  };
  const fail = async (status, ...args) => {
    await assert.rejects(call(...args), (e) => e instanceof HttpError && e.status === status);
  };
  return { db, clock, call, fail };
}

// 서울 시청 근처 병원, 보호자는 가까운 곳과 먼 곳
const HOSPITAL = { name: '튼튼동물병원', phone: '0212345678', password: 'password-1', address: '서울 중구', license_no: 'L-001', lat: 37.5665, lng: 126.978 };
const NEAR = { lat: 37.57, lng: 126.98 };
const FAR = { lat: 35.1796, lng: 129.0756 }; // 부산

async function makeHospital(t) {
  const signup = await t.call('POST', '/api/signup/hospital', { body: HOSPITAL });
  const token = signup.data.token;
  const me = await t.call('GET', '/api/me', { token });
  await t.call('POST', `/api/admin/hospitals/${me.data.hospital.id}/approve`, { admin: true });
  return { token, code: me.data.hospital.code, id: me.data.hospital.id };
}

async function makeDonor(t, hospital, { phone, loc, name = '보리', bloodType = 'DEA1.1-' }) {
  const g = await t.call('POST', '/api/signup/guardian', { body: { name: `보호자${phone.slice(-2)}`, phone, password: 'password-1', ...loc } });
  const token = g.data.token;
  const pet = await t.call('POST', '/api/pets', {
    token,
    body: { name, species: 'dog', breed: '리트리버', birth_date: '2022-01-01', weight_kg: 28, vaccinated: true, healthy: true, blood_type: bloodType },
  });
  const petId = pet.data.pet.id;
  await t.call('POST', `/api/pets/${petId}/hospitals`, { token, body: { code: hospital.code } });
  await t.call('PUT', `/api/hospital/patients/${petId}/blood-type`, { token: hospital.token, body: { blood_type: bloodType } });
  await t.call('PUT', `/api/pets/${petId}/donor`, { token, body: { consent: true } });
  return { token, petId };
}

test('병원은 승인 전에는 요청을 만들 수 없다', async () => {
  const t = setup();
  const signup = await t.call('POST', '/api/signup/hospital', { body: HOSPITAL });
  await t.fail(403, 'POST', '/api/hospital/requests', { token: signup.data.token, body: { species: 'dog', blood_type: 'DEA1.1-', units: 1, needed_by: '오늘' } });
});

test('관리자 키 없이는 병원 승인이 안 된다', async () => {
  const t = setup();
  await t.fail(403, 'POST', '/api/admin/hospitals/1/approve');
});

test('긴급 수혈 요청은 가까운 적합 후보에게만 알림이 가고, 위치는 수락 전 비공개다', async () => {
  const t = setup();
  const hospital = await makeHospital(t);
  const near = await makeDonor(t, hospital, { phone: '01011110001', loc: NEAR });
  await makeDonor(t, hospital, { phone: '01011110002', loc: FAR, name: '멀리' });

  const created = await t.call('POST', '/api/hospital/requests', {
    token: hospital.token,
    body: { species: 'dog', blood_type: 'DEA1.1+', units: 1, needed_by: '오늘 18시' },
  });
  assert.equal(created.data.notified, 1);

  const notifications = await t.call('GET', '/api/notifications', { token: near.token });
  assert.equal(notifications.data.unread, 1);
  assert.match(notifications.data.notifications[0].title, /긴급 수혈 요청/);

  const detail = await t.call('GET', `/api/hospital/requests/${created.data.request.id}`, { token: hospital.token });
  assert.equal(detail.data.matches.length, 1);
  assert.equal(detail.data.matches[0].guardian_phone, null, '수락 전에는 보호자 연락처가 숨겨져야 한다');

  const mine = await t.call('GET', '/api/matches', { token: near.token });
  assert.equal(mine.data.matches[0].hospital_phone, null, '수락 전에는 병원 연락처도 숨겨진다');
});

test('수락 → 병원 확인 → 완료 시 포인트·배지·헌혈 간격이 반영된다', async () => {
  const t = setup();
  const hospital = await makeHospital(t);
  const donor = await makeDonor(t, hospital, { phone: '01011110003', loc: NEAR });
  const created = await t.call('POST', '/api/hospital/requests', {
    token: hospital.token,
    body: { species: 'dog', blood_type: 'DEA1.1-', units: 1, needed_by: '오늘' },
  });
  const requestId = created.data.request.id;
  const matches = await t.call('GET', '/api/matches', { token: donor.token });
  const matchId = matches.data.matches[0].id;

  await t.call('POST', `/api/matches/${matchId}/respond`, { token: donor.token, body: { accept: true } });
  const accepted = await t.call('GET', `/api/hospital/requests/${requestId}`, { token: hospital.token });
  assert.ok(accepted.data.matches[0].guardian_phone, '수락 후에는 연락처가 공개된다');

  const done = await t.call('POST', `/api/hospital/matches/${matchId}/complete`, { token: hospital.token });
  assert.equal(done.data.fulfilled, true);

  const points = await t.call('GET', '/api/points', { token: donor.token });
  assert.equal(points.data.total, 100);
  assert.deepEqual(points.data.badges, ['첫 헌혈']);

  const pets = await t.call('GET', '/api/pets', { token: donor.token });
  const info = pets.data.pets[0].donor;
  assert.equal(info.eligible, false);
  assert.match(info.reasons.join(' '), /56일/);

  // 같은 요청을 다시 완료할 수 없다
  await t.fail(409, 'POST', `/api/hospital/matches/${matchId}/complete`, { token: hospital.token });

  // 56일이 지나면 다시 가능하다
  t.clock.now = new Date('2026-12-20T09:00:00Z');
  // 세션은 30일 뒤 만료되므로 다시 로그인한다.
  await t.fail(401, 'GET', '/api/pets', { token: donor.token });
  const relogin = await t.call('POST', '/api/login', { body: { phone: '01011110003', password: 'password-1' } });
  const later = await t.call('GET', '/api/pets', { token: relogin.data.token });
  assert.equal(later.data.pets[0].donor.eligible, true);
});

test('보호자가 입력한 혈액형은 병원 확정 전에는 매칭에 쓰이지 않는다', async () => {
  const t = setup();
  const hospital = await makeHospital(t);
  const g = await t.call('POST', '/api/signup/guardian', { body: { name: '가', phone: '01022220001', password: 'password-1', ...NEAR } });
  const pet = await t.call('POST', '/api/pets', {
    token: g.data.token,
    body: { name: '미확정', species: 'dog', birth_date: '2022-01-01', weight_kg: 30, vaccinated: true, healthy: true, blood_type: 'DEA1.1-' },
  });
  await t.call('PUT', `/api/pets/${pet.data.pet.id}/donor`, { token: g.data.token, body: { consent: true } });
  const created = await t.call('POST', '/api/hospital/requests', {
    token: hospital.token,
    body: { species: 'dog', blood_type: 'DEA1.1-', units: 1, needed_by: '오늘' },
  });
  assert.equal(created.data.notified, 0);
});

test('다른 보호자의 반려동물과 매칭에는 접근할 수 없다', async () => {
  const t = setup();
  const hospital = await makeHospital(t);
  const a = await makeDonor(t, hospital, { phone: '01033330001', loc: NEAR });
  const b = await t.call('POST', '/api/signup/guardian', { body: { name: '남', phone: '01033330002', password: 'password-1' } });
  await t.fail(404, 'GET', `/api/pets/${a.petId}/records`, { token: b.data.token });
  await t.fail(404, 'PUT', `/api/pets/${a.petId}/donor`, { token: b.data.token, body: { consent: true } });
  await t.fail(401, 'GET', '/api/pets');
  await t.fail(403, 'GET', '/api/hospital/patients', { token: b.data.token });
});

test('입력 검증: 약한 비밀번호, 중복 가입, 잘못된 혈액형', async () => {
  const t = setup();
  await t.fail(400, 'POST', '/api/signup/guardian', { body: { name: 'a', phone: '01044440001', password: 'short' } });
  await t.call('POST', '/api/signup/guardian', { body: { name: 'a', phone: '01044440001', password: 'password-1' } });
  await t.fail(409, 'POST', '/api/signup/guardian', { body: { name: 'b', phone: '010-4444-0001', password: 'password-1' } });
  const login = await t.call('POST', '/api/login', { body: { phone: '01044440001', password: 'password-1' } });
  const pet = await t.call('POST', '/api/pets', { token: login.data.token, body: { name: '냥', species: 'cat' } });
  await t.fail(400, 'PATCH', `/api/pets/${pet.data.pet.id}`, { token: login.data.token, body: { blood_type: 'DEA1.1+' } });
  await t.fail(401, 'POST', '/api/login', { body: { phone: '01044440001', password: 'wrong-password' } });
});

test('병원 공지와 진료 기록이 보호자 수첩에 나타난다', async () => {
  const t = setup();
  const hospital = await makeHospital(t);
  const donor = await makeDonor(t, hospital, { phone: '01055550001', loc: NEAR });
  await t.call('POST', `/api/hospital/patients/${donor.petId}/records`, {
    token: hospital.token,
    body: { kind: 'vaccine', date: '2026-10-01', memo: '종합백신', next_date: '2027-10-01' },
  });
  await t.call('POST', '/api/hospital/notices', { token: hospital.token, body: { title: '휴진 안내', body: '추석 연휴 휴진' } });
  const records = await t.call('GET', `/api/pets/${donor.petId}/records`, { token: donor.token });
  assert.equal(records.data.records[0].kind, 'vaccine');
  const notices = await t.call('GET', '/api/notices', { token: donor.token });
  assert.equal(notices.data.notices[0].title, '휴진 안내');
});
