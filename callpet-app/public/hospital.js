import { h, mount, api, session, toast, guard, getPosition, SPECIES, BLOOD, KIND, MATCH, formatDate, field, select } from './common.js';

const root = document.getElementById('app');
const state = { me: null, hospital: null, tab: 'requests', patients: [], requests: [], open: null, locPicked: null };

async function boot() {
  if (!session.token) return renderAuth();
  try {
    const { user, hospital } = await api('GET', '/api/me');
    if (user.role !== 'hospital') {
      session.token = null;
      toast('병원 계정으로 로그인해 주세요.', 'error');
      return renderAuth();
    }
    state.me = user;
    state.hospital = hospital;
    if (hospital.status === 'approved') await refresh();
    render();
  } catch (e) {
    if (e.status === 401) session.token = null;
    renderAuth();
  }
}

async function refresh() {
  const [p, r] = await Promise.all([api('GET', '/api/hospital/patients'), api('GET', '/api/hospital/requests')]);
  state.patients = p.patients;
  state.requests = r.requests;
  if (state.open) state.open = await api('GET', `/api/hospital/requests/${state.open.request.id}`).catch(() => null);
}

const act = (fn) => guard(async () => { await fn(); await refresh(); render(); })();

function renderAuth(mode = 'login') {
  const f = {
    name: h('input'), phone: h('input', { type: 'tel', inputmode: 'numeric' }), password: h('input', { type: 'password' }),
    address: h('input'), license: h('input'), lat: h('input', { type: 'number', step: 'any' }), lng: h('input', { type: 'number', step: 'any' }),
  };
  const submit = guard(async () => {
    const body = { phone: f.phone.value, password: f.password.value };
    if (mode === 'signup') Object.assign(body, { name: f.name.value, address: f.address.value, license_no: f.license.value, lat: f.lat.value, lng: f.lng.value });
    const res = await api('POST', mode === 'login' ? '/api/login' : '/api/signup/hospital', body);
    session.token = res.token;
    await boot();
  });
  mount(root, h('div', { class: 'center' },
    h('h1', { text: '콜펫 병원 관리' }),
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); submit(); } },
      mode === 'signup' && [field('병원명', f.name), field('주소', f.address), field('사업자·면허 번호', f.license),
        h('button', { type: 'button', class: 'btn ghost small', text: '현재 위치로 입력', onclick: guard(async () => {
          const p = await getPosition(); f.lat.value = p.lat; f.lng.value = p.lng; }) }),
        field('위도', f.lat), field('경도', f.lng)],
      field('전화번호', f.phone), field('비밀번호 (8자 이상)', f.password),
      h('button', { class: 'btn', type: 'submit', text: mode === 'login' ? '로그인' : '가입 신청' })),
    mode === 'signup' && h('p', { class: 'disclaimer', text: '가입 후 관리자 승인이 완료되어야 기록 작성과 수혈 요청을 쓸 수 있어요.' }),
    h('button', { class: 'btn ghost', text: mode === 'login' ? '병원 가입 신청' : '이미 계정이 있어요', onclick: () => renderAuth(mode === 'login' ? 'signup' : 'login') }),
    h('p', { class: 'muted' }, h('a', { href: '/', text: '← 보호자 앱으로' }))));
}

function render() {
  const hs = state.hospital;
  const head = h('header', { class: 'topbar' },
    h('div', {}, h('strong', { text: hs.name }), ' ', h('span', { class: `pill ${hs.status === 'approved' ? 'ok' : 'warn'}`, text: { approved: '승인됨', pending: '승인 대기', rejected: '거절됨' }[hs.status] })),
    h('button', { class: 'btn ghost small', text: '로그아웃', onclick: () => { session.token = null; renderAuth(); } }));
  if (hs.status !== 'approved') {
    return mount(root, head, h('div', { class: 'card' },
      h('h2', { text: hs.status === 'pending' ? '승인을 기다리고 있어요' : '가입이 거절되었어요' }),
      h('p', { class: 'muted', text: '승인이 완료되면 새로고침해 주세요.' }),
      h('button', { class: 'btn', text: '새로고침', onclick: boot })));
  }
  const tabs = h('div', { class: 'htabs', role: 'tablist' }, [['requests', '수혈 요청'], ['patients', '환자·기록'], ['notices', '공지']].map(([k, t]) =>
    h('button', { class: 'tab', role: 'tab', 'aria-current': state.tab === k ? 'page' : undefined, text: t, onclick: () => { state.tab = k; render(); } })));
  const body = { requests: renderRequests, patients: renderPatients, notices: renderNotices }[state.tab]();
  mount(root, head,
    h('p', { class: 'muted' }, '보호자 앱에서 이 코드를 입력하면 환자로 연결돼요: ', h('strong', { text: hs.code })),
    tabs, body);
}

// ───────── 수혈 요청
function renderRequests() {
  const species = select(Object.entries(SPECIES), 'dog');
  const blood = select(BLOOD.dog.map((b) => [b, b]), 'DEA1.1-');
  species.addEventListener('change', () => blood.replaceChildren(...BLOOD[species.value].map((b) => h('option', { value: b, text: b }))));
  const units = h('input', { type: 'number', min: '1', max: '10', value: '1' });
  const by = h('input', { placeholder: '예: 오늘 18시까지' });
  const note = h('input', { placeholder: '메모 (선택)' });
  const form = h('section', { class: 'card' },
    h('h2', { text: '긴급 수혈 요청 등록' }),
    h('p', { class: 'disclaimer', text: '등록하면 반경 30km 안의 헌혈 가능 후보(혈액형 병원 확인 완료)에게 즉시 알림이 갑니다. 수혈 여부와 적합성은 담당 수의사가 최종 판단하세요.' }),
    h('div', { class: 'row' }, field('종', species), field('필요 혈액형', blood), field('수량', units)),
    field('필요 시한', by), field('메모', note),
    h('button', { class: 'btn', text: '요청 보내기', onclick: () => act(async () => {
      const r = await api('POST', '/api/hospital/requests', { species: species.value, blood_type: blood.value, units: Number(units.value), needed_by: by.value, note: note.value || null });
      toast(`후보 ${r.notified}명에게 알림을 보냈어요`);
    }) }));
  const list = h('section', {}, h('h2', { text: '요청 목록' }),
    state.requests.length ? state.requests.map((r) => h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('strong', { text: `${SPECIES[r.species]} ${r.blood_type} × ${r.units}` }),
        h('span', { class: `pill ${r.status === 'fulfilled' ? 'ok' : r.status === 'open' ? 'warn' : ''}`, text: { open: '진행 중', fulfilled: '완료', cancelled: '취소' }[r.status] })),
      h('p', { class: 'muted', text: `${r.needed_by} · 알림 ${r.notified} · 수락 ${r.accepted} · 완료 ${r.completed}` }),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost small', text: '매칭 현황', onclick: guard(async () => { state.open = await api('GET', `/api/hospital/requests/${r.id}`); render(); }) }),
        r.status === 'open' && h('button', { class: 'btn ghost small', text: '후보 다시 찾기', onclick: () => act(async () => { const x = await api('POST', `/api/hospital/requests/${r.id}/rematch`); toast(`${x.notified}명에게 추가 알림`); }) }),
        r.status === 'open' && h('button', { class: 'btn danger small', text: '요청 취소', onclick: () => act(() => api('POST', `/api/hospital/requests/${r.id}/cancel`)) }))))
      : h('p', { class: 'muted', text: '등록한 요청이 없어요.' }));
  return h('div', {}, form, state.open && matchPanel(), list);
}

function matchPanel() {
  const { request, matches } = state.open;
  return h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', { text: `매칭 현황 · ${SPECIES[request.species]} ${request.blood_type}` }), h('button', { class: 'btn ghost small', text: '닫기', onclick: () => { state.open = null; render(); } })),
    h('p', { class: 'muted', text: '보호자 이름과 연락처는 수락한 뒤에만 보여요.' }),
    matches.length ? h('ul', { class: 'list' }, matches.map((m) => h('li', {},
      h('div', { class: 'row between' },
        h('span', {}, h('strong', { text: m.pet_name }), ` · ${m.blood_type} · ${m.weight_kg ?? '?'}kg · ${m.distance_km?.toFixed(1)}km`),
        h('span', { class: `pill ${m.status === 'accepted' || m.status === 'completed' ? 'ok' : ''}`, text: MATCH[m.status] })),
      m.guardian_name && h('p', {}, `${m.guardian_name} `, h('a', { href: `tel:${m.guardian_phone}`, text: m.guardian_phone })),
      m.status === 'accepted' && request.status === 'open' && h('button', { class: 'btn small', text: '헌혈 완료 확정', onclick: () => act(async () => {
        const r = await api('POST', `/api/hospital/matches/${m.id}/complete`);
        toast(r.fulfilled ? '필요 수량을 모두 채웠어요' : `${r.completed}/${r.units} 완료`);
      }) })))) : h('p', { class: 'muted', text: '아직 알림을 받은 후보가 없어요. 후보 다시 찾기를 눌러 보세요.' }));
}

// ───────── 환자·기록
function renderPatients() {
  if (!state.patients.length) return h('p', { class: 'muted', text: '연결된 환자가 없어요. 보호자에게 병원 코드를 알려 주세요.' });
  return h('div', { class: 'grid' }, state.patients.map(patientCard));
}

function patientCard(p) {
  const kind = select([['visit', '진료'], ['vaccine', '접종'], ['medication', '복약']], 'visit');
  const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const next = h('input', { type: 'date' });
  const memo = h('input', { placeholder: '메모' });
  const blood = select([['', '혈액형 확정…'], ...BLOOD[p.species].map((b) => [b, b])], p.blood_type_verified ? p.blood_type : '');
  return h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', { text: `${p.name} (${SPECIES[p.species]})` }),
      h('span', { class: `pill ${p.blood_type_verified ? 'ok' : 'warn'}`, text: p.blood_type_verified ? `혈액형 ${p.blood_type} 확정` : '혈액형 미확정' })),
    h('p', { class: 'muted', text: `보호자 ${p.guardian_name} · ${p.guardian_phone}` }),
    h('div', { class: 'row' }, field('종류', kind), field('날짜', date), field('다음 방문', next)),
    field('메모', memo),
    h('button', { class: 'btn small', text: '기록 추가', onclick: () => act(async () => {
      await api('POST', `/api/hospital/patients/${p.id}/records`, { kind: kind.value, date: date.value, next_date: next.value || null, memo: memo.value || null });
      toast('기록을 남겼어요');
    }) }),
    h('div', { class: 'row' }, field('검사로 확인한 혈액형', blood),
      h('button', { class: 'btn ghost small', text: '확정', onclick: () => blood.value ? act(async () => { await api('PUT', `/api/hospital/patients/${p.id}/blood-type`, { blood_type: blood.value }); toast('혈액형을 확정했어요'); }) : toast('혈액형을 선택해 주세요', 'error') })));
}

// ───────── 공지
function renderNotices() {
  const title = h('input', { maxlength: 80 });
  const body = h('textarea', { rows: 4, maxlength: 1000 });
  return h('section', { class: 'card' },
    h('h2', { text: '연결된 보호자에게 공지' }),
    field('제목', title), field('내용', body),
    h('button', { class: 'btn', text: '보내기', onclick: () => act(async () => {
      const r = await api('POST', '/api/hospital/notices', { title: title.value, body: body.value });
      toast(`${r.notified}명에게 보냈어요`);
    }) }));
}

boot();
