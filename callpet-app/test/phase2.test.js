import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createApi, HttpError } from '../lib/api.js';

function setup() {
  const db = openDb();
  const clock = { now: new Date('2026-10-20T09:00:00Z') };
  const api = createApi(db, { adminKey: 'k', now: () => clock.now });
  const call = async (method, path, { token, body, admin } = {}) => {
    const url = new URL(path, 'http://x');
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (admin) headers['x-admin-key'] = 'k';
    return api(method, url.pathname, url.searchParams, headers, body);
  };
  const fail = (status, ...args) => assert.rejects(call(...args), (e) => e instanceof HttpError && e.status === status);
  return { clock, call, fail };
}

async function world(t) {
  const hs = await t.call('POST', '/api/signup/hospital', { body: { name: '튼튼동물병원', phone: '0212345678', password: 'password-1', address: '서울', license_no: 'L1', lat: 37.5665, lng: 126.978 } });
  const me = await t.call('GET', '/api/me', { token: hs.data.token });
  await t.call('POST', `/api/admin/hospitals/${me.data.hospital.id}/approve`, { admin: true });
  const g = await t.call('POST', '/api/signup/guardian', { body: { name: '보호자', phone: '01012340000', password: 'password-1', lat: 37.57, lng: 126.98 } });
  const pet = await t.call('POST', '/api/pets', { token: g.data.token, body: { name: '보리', species: 'dog', birth_date: '2022-01-01', weight_kg: 28, vaccinated: true, healthy: true } });
  return { hospital: { token: hs.data.token, id: me.data.hospital.id, code: me.data.hospital.code }, guardian: g.data.token, petId: pet.data.pet.id };
}

test('예약: 연결된 병원만, 중복 시간 불가, 병원이 확정하면 보호자에게 알림', async () => {
  const t = setup();
  const w = await world(t);
  const body = { hospital_id: w.hospital.id, date: '2026-10-25', time: '14:30', reason: '정기 검진' };
  await t.fail(404, 'POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body });
  await t.call('POST', `/api/pets/${w.petId}/hospitals`, { token: w.guardian, body: { code: w.hospital.code } });
  await t.fail(400, 'POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body: { ...body, date: '2026-10-01' } });
  await t.fail(400, 'POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body: { ...body, time: '25:00' } });
  const created = await t.call('POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body });
  await t.fail(409, 'POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body });

  const list = await t.call('GET', '/api/hospital/appointments', { token: w.hospital.token });
  assert.equal(list.data.appointments[0].status, 'requested');
  await t.call('POST', `/api/hospital/appointments/${created.data.id}/confirm`, { token: w.hospital.token });
  await t.fail(409, 'POST', `/api/hospital/appointments/${created.data.id}/decline`, { token: w.hospital.token });

  const notes = await t.call('GET', '/api/notifications', { token: w.guardian });
  assert.match(notes.data.notifications[0].title, /예약 확정/);
  const mine = await t.call('GET', '/api/appointments', { token: w.guardian });
  assert.equal(mine.data.appointments[0].status, 'confirmed');

  await t.call('POST', `/api/appointments/${created.data.id}/cancel`, { token: w.guardian });
  // 취소된 시간은 다시 예약할 수 있다
  await t.call('POST', `/api/pets/${w.petId}/appointments`, { token: w.guardian, body });
});

test('케어 리포트: 병원 기록을 쉬운 문장으로 정리하고 접종 경과·다음 일정을 알린다', async () => {
  const t = setup();
  const w = await world(t);
  await t.call('POST', `/api/pets/${w.petId}/hospitals`, { token: w.guardian, body: { code: w.hospital.code } });
  const empty = await t.call('GET', `/api/pets/${w.petId}/report`, { token: w.guardian });
  assert.match(empty.data.report.items[0].text, /아직 없어요/);

  await t.call('POST', `/api/hospital/patients/${w.petId}/records`, { token: w.hospital.token, body: { kind: 'vaccine', date: '2025-08-01', memo: '종합백신' } });
  await t.call('POST', `/api/hospital/patients/${w.petId}/records`, { token: w.hospital.token, body: { kind: 'visit', date: '2026-10-10', memo: '피부 확인', next_date: '2026-10-24' } });
  const r = (await t.call('GET', `/api/pets/${w.petId}/report`, { token: w.guardian })).data.report;
  const by = Object.fromEntries(r.items.map((i) => [i.title, i]));
  assert.match(by['최근 진료'].text, /10일 전/);
  assert.equal(by['접종'].level, 'warn');
  assert.match(by['다음 일정'].text, /D-4/);
  assert.match(r.notice, /진단이 아닙니다/);
  await t.fail(404, 'GET', `/api/pets/${w.petId}/report`, { token: (await t.call('POST', '/api/signup/guardian', { body: { name: '남', phone: '01000009999', password: 'password-1' } })).data.token });
});

test('7일 챌린지: 하루 한 번만 체크인, 7일째에 포인트, 교환은 잔액 한도 내', async () => {
  const t = setup();
  const w = await world(t);
  await t.fail(409, 'POST', '/api/rewards/treat/redeem', { token: w.guardian });
  for (let i = 0; i < 7; i++) {
    const res = await t.call('POST', `/api/pets/${w.petId}/challenge/checkin`, { token: w.guardian });
    assert.equal(res.data.completed, i === 6);
    if (i < 6) await t.fail(409, 'POST', `/api/pets/${w.petId}/challenge/checkin`, { token: w.guardian });
    t.clock.now = new Date(t.clock.now.getTime() + 86400000);
  }
  const state = await t.call('GET', `/api/pets/${w.petId}/challenge`, { token: w.guardian });
  assert.equal(state.data.completed_rounds, 1);
  assert.equal((await t.call('GET', '/api/points', { token: w.guardian })).data.total, 50);

  await t.fail(409, 'POST', '/api/rewards/treat/redeem', { token: w.guardian }); // 300P 필요
  await t.fail(404, 'POST', '/api/rewards/nope/redeem', { token: w.guardian });
});

test('포인트가 충분하면 교환되고 잔액이 줄어든다', async () => {
  const t = setup();
  const w = await world(t);
  // 헌혈 3회로 300P를 만든다: 요청 3건을 순서대로 완료
  await t.call('POST', `/api/pets/${w.petId}/hospitals`, { token: w.guardian, body: { code: w.hospital.code } });
  await t.call('PUT', `/api/hospital/patients/${w.petId}/blood-type`, { token: w.hospital.token, body: { blood_type: 'DEA1.1-' } });
  await t.call('PUT', `/api/pets/${w.petId}/donor`, { token: w.guardian, body: { consent: true } });
  for (let i = 0; i < 3; i++) {
    const req = await t.call('POST', '/api/hospital/requests', { token: w.hospital.token, body: { species: 'dog', blood_type: 'DEA1.1-', units: 1, needed_by: '오늘' } });
    assert.equal(req.data.notified, 1);
    const matches = await t.call('GET', '/api/matches', { token: w.guardian });
    const m = matches.data.matches.find((x) => x.status === 'notified');
    await t.call('POST', `/api/matches/${m.id}/respond`, { token: w.guardian, body: { accept: true } });
    await t.call('POST', `/api/hospital/matches/${m.id}/complete`, { token: w.hospital.token });
    t.clock.now = new Date(t.clock.now.getTime() + 60 * 86400000); // 헌혈 간격 경과
    // 세션은 30일 뒤 만료되므로 다시 로그인한다.
    w.guardian = (await t.call('POST', '/api/login', { body: { phone: '01012340000', password: 'password-1' } })).data.token;
    w.hospital.token = (await t.call('POST', '/api/login', { body: { phone: '0212345678', password: 'password-1' } })).data.token;
  }
  const rewards = await t.call('GET', '/api/rewards', { token: w.guardian });
  assert.equal(rewards.data.total, 300);
  assert.equal(rewards.data.rewards[0].affordable, true);
  const redeemed = await t.call('POST', '/api/rewards/treat/redeem', { token: w.guardian });
  assert.equal(redeemed.data.total, 0);
  assert.equal((await t.call('GET', '/api/points', { token: w.guardian })).data.donations, 3);
});

test('콘텐츠는 키우는 종에 맞춰 보여준다', async () => {
  const t = setup();
  const w = await world(t);
  const res = await t.call('GET', '/api/content', { token: w.guardian });
  const ids = res.data.articles.map((a) => a.id);
  assert.ok(ids.includes('walk-basics') && !ids.includes('cat-water'));
});
