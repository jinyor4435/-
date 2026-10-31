// 시연용 데이터를 만든다. 실제 서비스 데이터가 아니며 비밀번호가 공개되어 있으므로 운영 DB에 쓰지 않는다.
//   DB_PATH=demo.db node --disable-warning=ExperimentalWarning scripts/seed.js --reset
import { existsSync, rmSync } from 'node:fs';
import { openDb } from '../lib/db.js';
import { createApi } from '../lib/api.js';

const path = process.env.DB_PATH ?? 'callpet.db';
if (existsSync(path)) {
  if (!process.argv.includes('--reset')) {
    console.error(`${path} 가 이미 있습니다. 지우고 다시 만들려면 --reset 을 붙이세요.`);
    process.exit(1);
  }
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
}

const ADMIN_KEY = 'seed-only-key';
const PASSWORD = 'demo-pass-1234';
const db = openDb(path);
const api = createApi(db, { adminKey: ADMIN_KEY });
const call = async (method, p, { token, body, admin } = {}) => {
  const url = new URL(p, 'http://x');
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = ADMIN_KEY;
  return (await api(method, url.pathname, url.searchParams, headers, body)).data;
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAhead = (n) => daysAgo(-n);

async function hospital(name, phone, address, lat, lng) {
  const s = await call('POST', '/api/signup/hospital', { body: { name, phone, password: PASSWORD, address, license_no: 'DEMO-' + phone.slice(-4), lat, lng } });
  const me = await call('GET', '/api/me', { token: s.token });
  await call('POST', `/api/admin/hospitals/${me.hospital.id}/approve`, { admin: true });
  return { token: s.token, id: me.hospital.id, code: me.hospital.code, name };
}

async function guardian(name, phone, lat, lng, pets, hosp) {
  const s = await call('POST', '/api/signup/guardian', { body: { name, phone, password: PASSWORD, lat, lng } });
  const out = [];
  for (const p of pets) {
    const { pet } = await call('POST', '/api/pets', { token: s.token, body: p.body });
    await call('POST', `/api/pets/${pet.id}/hospitals`, { token: s.token, body: { code: hosp.code } });
    if (p.verified) await call('PUT', `/api/hospital/patients/${pet.id}/blood-type`, { token: hosp.token, body: { blood_type: p.body.blood_type } });
    if (p.donor) await call('PUT', `/api/pets/${pet.id}/donor`, { token: s.token, body: { consent: true } });
    out.push(pet.id);
  }
  return { token: s.token, petIds: out, phone };
}

const h1 = await hospital('튼튼동물병원', '0212340001', '서울 중구 세종대로 110', 37.5665, 126.978);
const h2 = await hospital('포근동물의료센터', '0212340002', '서울 마포구 월드컵북로 21', 37.5563, 126.9236);

const dog = (name, extra = {}) => ({ name, species: 'dog', breed: '골든 리트리버', birth_date: '2021-03-05', weight_kg: 29, vaccinated: true, healthy: true, blood_type: 'DEA1.1-', ...extra });
const g1 = await guardian('김하늘', '01090000001', 37.571, 126.985, [{ body: dog('보리'), verified: true, donor: true }], h1);
const g2 = await guardian('이도윤', '01090000002', 37.552, 126.93, [{ body: dog('코코', { blood_type: 'DEA1.1+', weight_kg: 26 }), verified: true, donor: true }], h2);
const g3 = await guardian('박서연', '01090000003', 37.563, 126.975, [
  { body: { name: '나비', species: 'cat', breed: '코리안 숏헤어', birth_date: '2022-06-01', weight_kg: 4.6, vaccinated: true, healthy: true, blood_type: 'A' }, verified: true, donor: true },
  { body: dog('두부', { birth_date: '2025-09-01', weight_kg: 8, blood_type: null }), verified: false, donor: false },
], h1);

// 병원 기록·공지
await call('POST', `/api/hospital/patients/${g1.petIds[0]}/records`, { token: h1.token, body: { kind: 'vaccine', date: daysAgo(400), memo: '종합백신' } });
await call('POST', `/api/hospital/patients/${g1.petIds[0]}/records`, { token: h1.token, body: { kind: 'visit', date: daysAgo(12), memo: '피부 가려움 확인, 약 처방', next_date: daysAhead(5) } });
await call('POST', `/api/hospital/patients/${g1.petIds[0]}/records`, { token: h1.token, body: { kind: 'medication', date: daysAgo(12), memo: '피부 연고 7일분' } });
await call('POST', `/api/hospital/patients/${g3.petIds[0]}/records`, { token: h1.token, body: { kind: 'vaccine', date: daysAgo(60), memo: '고양이 종합백신' } });
await call('POST', '/api/hospital/notices', { token: h1.token, body: { title: '개원 10주년 건강검진 안내', body: '이번 달 한 달간 노령견 기초 검진을 할인합니다. 예약은 앱에서 해 주세요.' } });

// 일상 기록·챌린지·예약
for (const [kind, value] of [['walk', 35], ['meal', 1], ['water', 1]]) await call('POST', `/api/pets/${g1.petIds[0]}/logs`, { token: g1.token, body: { kind, value } });
await call('POST', `/api/pets/${g1.petIds[0]}/challenge/checkin`, { token: g1.token });
await call('POST', `/api/pets/${g1.petIds[0]}/appointments`, { token: g1.token, body: { hospital_id: h1.id, date: daysAhead(5), time: '14:30', reason: '피부 재검진' } });

// 열려 있는 긴급 수혈 요청: 가까운 후보(보리, 코코)에게 알림이 간다
await call('POST', '/api/hospital/requests', { token: h1.token, body: { species: 'dog', blood_type: 'DEA1.1+', units: 1, needed_by: '오늘 18시까지', note: '수술 중 출혈, 급해요' } });

console.log(`시연 데이터를 ${path} 에 만들었습니다. 모든 계정의 비밀번호: ${PASSWORD}`);
console.log('보호자: 01090000001(김하늘, 보리 · 긴급 요청 알림 대기), 01090000002(이도윤, 코코 · 알림 대기), 01090000003(박서연, 고양이 나비)');
console.log(`병원:   0212340001(${h1.name}, 코드 ${h1.code}), 0212340002(${h2.name}, 코드 ${h2.code})`);
