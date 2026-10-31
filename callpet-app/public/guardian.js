import { h, mount, api, session, toast, guard, getPosition, SPECIES, BLOOD, KIND, MATCH, formatDate, field, select } from './common.js';

const root = document.getElementById('app');
const state = { me: null, tab: 'home', pets: [], petId: null, unread: 0, summary: null, matches: [], poll: null };

const currentPet = () => state.pets.find((p) => p.id === state.petId) ?? state.pets[0] ?? null;

async function boot() {
  if (!session.token) return renderAuth();
  try {
    const { user } = await api('GET', '/api/me');
    if (user.role !== 'guardian') {
      session.token = null;
      toast('보호자 계정으로 로그인해 주세요. 병원은 /hospital 에서 이용합니다.', 'error');
      return renderAuth();
    }
    state.me = user;
    await refresh();
    clearInterval(state.poll);
    state.poll = setInterval(pollNotifications, 15000);
    render();
  } catch (e) {
    if (e.status === 401) session.token = null;
    renderAuth();
  }
}

async function refresh() {
  const [pets, summary, matches, notes] = await Promise.all([
    api('GET', '/api/pets'),
    api('GET', '/api/callpet/summary'),
    api('GET', '/api/matches'),
    api('GET', '/api/notifications'),
  ]);
  state.pets = pets.pets;
  state.summary = summary;
  state.matches = matches.matches;
  state.unread = notes.unread;
  if (!state.pets.some((p) => p.id === state.petId)) state.petId = state.pets[0]?.id ?? null;
}

async function pollNotifications() {
  try {
    const before = state.unread;
    const [notes, summary, matches] = await Promise.all([api('GET', '/api/notifications'), api('GET', '/api/callpet/summary'), api('GET', '/api/matches')]);
    state.unread = notes.unread;
    state.summary = summary;
    state.matches = matches.matches;
    if (notes.unread > before) toast(notes.notifications[0].title);
    render();
  } catch { /* 일시적인 네트워크 오류는 다음 주기에 다시 시도 */ }
}

// ───────── 로그인 / 가입
function renderAuth(mode = 'login') {
  const loc = { lat: null, lng: null };
  const locStatus = h('p', { class: 'muted', text: '위치는 긴급 수혈 요청이 가까운 곳에만 가도록 쓰이며, 수락 전에는 병원에 보이지 않습니다.' });
  const name = h('input', { autocomplete: 'name' });
  const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '01012345678' });
  const password = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
  const submit = guard(async () => {
    const body = { phone: phone.value, password: password.value };
    if (mode === 'signup') Object.assign(body, { name: name.value, lat: loc.lat, lng: loc.lng });
    const res = await api('POST', mode === 'login' ? '/api/login' : '/api/signup/guardian', body);
    session.token = res.token;
    await boot();
  });
  mount(root, h('div', { class: 'center' },
    h('h1', { text: '콜펫 케어' }),
    h('p', { class: 'muted', text: '반려동물 건강 기록과 긴급 수혈 매칭을 한 곳에서.' }),
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); submit(); } },
      mode === 'signup' && field('이름', name),
      field('전화번호', phone),
      field(mode === 'signup' ? '비밀번호 (8자 이상)' : '비밀번호', password),
      mode === 'signup' && h('div', {},
        h('button', { type: 'button', class: 'btn ghost small', text: '내 위치 사용', onclick: guard(async () => {
          Object.assign(loc, await getPosition());
          locStatus.textContent = '위치를 가져왔습니다.';
        }) }),
        locStatus),
      h('button', { class: 'btn', type: 'submit', text: mode === 'login' ? '로그인' : '가입하기' })),
    h('button', { class: 'btn ghost', text: mode === 'login' ? '처음이신가요? 가입하기' : '이미 계정이 있어요', onclick: () => renderAuth(mode === 'login' ? 'signup' : 'login') }),
    h('p', { class: 'muted' }, '병원 관계자는 ', h('a', { href: '/hospital', text: '병원 관리 화면' }), '을 이용해 주세요.')));
}

// ───────── 공통 틀
const TABS = [['home', '홈'], ['book', '수첩'], ['callpet', '콜펫'], ['me', '내 정보']];

function render() {
  const pending = state.matches.filter((m) => m.status === 'notified' && m.request_status === 'open').length;
  const body = { home: renderHome, book: renderBook, callpet: renderCallpet, me: renderMe }[state.tab]();
  const tabs = h('nav', { class: 'tabs', 'aria-label': '주 메뉴' }, h('div', { class: 'tabs-inner' },
    TABS.map(([key, label]) => h('button', {
      class: 'tab', 'aria-current': state.tab === key ? 'page' : undefined,
      'aria-label': key === 'callpet' && pending > 0 ? `${label}, 응답 대기 ${pending}건` : label,
      onclick: () => { state.tab = key; render(); window.scrollTo(0, 0); },
    }, label, key === 'callpet' && pending > 0 && h('span', { class: 'badge', text: pending })))));
  mount(root, h('header', { class: 'topbar' }, h('strong', { text: '콜펫 케어' }), h('span', { class: 'muted', text: state.me.name })), body, tabs);
}

async function act(fn) {
  await guard(async () => { await fn(); await refresh(); render(); })();
}

// ───────── 홈
function renderHome() {
  const open = state.summary.open_requests;
  const waiting = state.matches.filter((m) => m.status === 'notified' && m.request_status === 'open');
  const readyPets = state.summary.donors.filter((d) => d.registered);
  const pet = currentPet();
  return h('main', {},
    h('section', { class: 'hero', 'aria-label': '콜펫' },
      h('h2', { text: waiting.length ? `긴급 수혈 요청 ${waiting.length}건이 기다려요` : '콜펫 · 긴급 수혈 매칭' }),
      h('p', { text: readyPets.length ? `${readyPets.map((d) => d.name).join(', ')} 헌혈 등록 완료. 지금 전국 ${open}건의 요청이 진행 중입니다.` : `지금 ${open}건의 요청이 진행 중입니다. 반려동물을 헌혈견·헌혈묘로 등록해 보세요.` }),
      h('button', { class: 'btn', text: waiting.length ? '요청 확인하기' : '콜펫 보기', onclick: () => { state.tab = 'callpet'; render(); } })),
    waiting.map((m) => matchCard(m)),
    !pet
      ? h('section', { class: 'card' }, h('h2', { text: '반려동물을 등록해 주세요' }), h('button', { class: 'btn', text: '등록하기', onclick: () => { state.tab = 'book'; render(); } }))
      : h('section', { class: 'card' },
        h('h2', { text: `${pet.name} 오늘 기록` }),
        h('div', { class: 'row' },
          quickLog(pet, 'walk', 30, '산책 30분'), quickLog(pet, 'meal', 1, '식사'), quickLog(pet, 'water', 1, '물'))),
    pet && challengeCard(pet),
    h('section', { class: 'card' }, h('h2', { text: '병원 공지' }), noticesList()),
    contentSection());
}

const challengeBox = h('div', {});
function challengeCard(pet) {
  const body = h('div', {}, h('p', { class: 'muted', text: '불러오는 중…' }));
  Promise.all([api('GET', `/api/pets/${pet.id}/challenge`), api('GET', '/api/content')]).then(([c, content]) => {
    const ch = content.challenge;
    body.replaceChildren(
      h('p', { text: `${c.round_done}/${c.days}일 완료${c.completed_rounds ? ` · 완료 ${c.completed_rounds}회` : ''}` }),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': c.days, 'aria-valuenow': c.round_done }, h('div', { class: `bar-fill w${c.round_done}` })),
      h('ul', { class: 'list' }, ch.tasks.map((t) => h('li', { class: 'muted', text: t }))),
      h('button', { class: 'btn small', disabled: c.checked_today, text: c.checked_today ? '오늘 체크인 완료' : '오늘 체크인', onclick: () => act(async () => {
        const r = await api('POST', `/api/pets/${pet.id}/challenge/checkin`);
        toast(r.completed ? `챌린지 완료! +${r.points}P` : '체크인했어요');
      }) }));
  }).catch(() => {});
  challengeBox.replaceChildren(h('section', { class: 'card' }, h('h2', { text: `${pet.name}의 7일 케어 챌린지` }), body));
  return challengeBox;
}

const contentBox = h('div', {});
function contentSection() {
  api('GET', '/api/content').then(({ articles }) => {
    contentBox.replaceChildren(h('section', { class: 'card' }, h('h2', { text: '케어 콘텐츠' }),
      articles.map((a) => h('details', {}, h('summary', { text: a.title }), h('p', { text: a.body })))));
  }).catch(() => {});
  return contentBox;
}

function quickLog(pet, kind, value, label) {
  return h('button', { class: 'btn ghost small', text: `+ ${label}`, onclick: () => act(async () => {
    await api('POST', `/api/pets/${pet.id}/logs`, { kind, value });
    toast(`${label} 기록했어요`);
  }) });
}

const noticeBox = h('div', {}, h('p', { class: 'muted', text: '불러오는 중…' }));
function noticesList() {
  api('GET', '/api/notices').then(({ notices }) => {
    noticeBox.replaceChildren(...(notices.length
      ? notices.slice(0, 5).map((n) => h('div', { class: 'notice' }, h('strong', { text: n.title }), h('p', { class: 'muted', text: `${n.hospital_name} · ${formatDate(n.created_at)}` }), h('p', { text: n.body })))
      : [h('p', { class: 'muted', text: '연결된 병원의 공지가 여기에 표시됩니다.' })]));
  }).catch(() => {});
  return noticeBox;
}

// ───────── 수첩
function renderBook() {
  const pet = currentPet();
  return h('main', {},
    h('div', { class: 'row between' }, h('h1', { text: '수첩' }),
      h('button', { class: 'btn small', text: '+ 반려동물', onclick: () => petForm() })),
    state.pets.length > 1 && select(state.pets.map((p) => [String(p.id), p.name]), String(pet?.id), {
      'aria-label': '반려동물 선택', onchange: (e) => { state.petId = Number(e.target.value); render(); } }),
    pet ? petSection(pet) : h('p', { class: 'muted', text: '아직 등록한 반려동물이 없어요.' }));
}

function petSection(pet) {
  const records = h('div', {}, h('p', { class: 'muted', text: '불러오는 중…' }));
  const logs = h('div', {});
  const hospitals = h('div', {});
  api('GET', `/api/pets/${pet.id}/records`).then(({ records: rs }) => {
    records.replaceChildren(rs.length
      ? h('ul', { class: 'list' }, rs.map((r) => h('li', {},
        h('span', { class: 'pill', text: KIND[r.kind] }), ' ', h('strong', { text: formatDate(r.date) }), ` · ${r.hospital_name}`,
        r.memo && h('p', { text: r.memo }), r.next_date && h('p', { class: 'muted', text: `다음 방문 ${formatDate(r.next_date)}` }))))
      : h('p', { class: 'muted', text: '병원이 남긴 기록이 여기에 표시됩니다. 아래에서 병원 코드를 입력해 연결하세요.' }));
  }).catch(() => {});
  api('GET', `/api/pets/${pet.id}/logs`).then(({ logs: ls }) => {
    logs.replaceChildren(ls.length
      ? h('ul', { class: 'list' }, ls.slice(0, 10).map((l) => h('li', {}, h('span', { class: 'pill', text: KIND[l.kind] }), ' ', formatDate(l.logged_at), l.value != null && ` · ${l.value}`, l.memo && ` · ${l.memo}`)))
      : h('p', { class: 'muted', text: '산책·식사·물 기록은 홈에서 한 번에 남길 수 있어요.' }));
  }).catch(() => {});
  api('GET', `/api/pets/${pet.id}/hospitals`).then(({ hospitals: hs }) => {
    hospitals.replaceChildren(hs.length ? h('p', { class: 'muted', text: `연결된 병원: ${hs.map((x) => x.name).join(', ')}` }) : h('span'));
  }).catch(() => {});
  const code = h('input', { placeholder: '병원 코드 (예: A1B2C3)', 'aria-label': '병원 코드', maxlength: 12 });
  return h('div', {},
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { text: `${pet.name} · ${SPECIES[pet.species]}` }), h('button', { class: 'btn ghost small', text: '수정', onclick: () => petForm(pet) })),
      h('p', { class: 'muted', text: [pet.breed, pet.weight_kg && `${pet.weight_kg}kg`, pet.birth_date && formatDate(pet.birth_date)].filter(Boolean).join(' · ') }),
      h('p', {}, '혈액형 ', pet.blood_type ? h('span', { class: `pill ${pet.blood_type_verified ? 'ok' : 'warn'}`, text: `${pet.blood_type} ${pet.blood_type_verified ? '병원 확인' : '미확인'}` }) : h('span', { class: 'pill', text: '미등록' }))),
    reportCard(pet),
    h('section', { class: 'card' }, h('h2', { text: '병원 기록' }), records, hospitals,
      h('div', { class: 'row' }, code, h('button', { class: 'btn small', text: '병원 연결', onclick: () => act(async () => {
        await api('POST', `/api/pets/${pet.id}/hospitals`, { code: code.value });
        toast('병원을 연결했어요');
      }) }))),
    appointmentCard(pet),
    h('section', { class: 'card' }, h('h2', { text: '일상 기록' }), logs));
}

function reportCard(pet) {
  const box = h('div', {}, h('p', { class: 'muted', text: '정리하는 중…' }));
  api('GET', `/api/pets/${pet.id}/report`).then(({ report }) => {
    box.replaceChildren(
      h('p', { class: 'disclaimer', text: report.notice }),
      h('ul', { class: 'list' }, report.items.map((i) => h('li', {}, h('span', { class: `pill ${i.level === 'ok' ? 'ok' : i.level === 'warn' ? 'warn' : ''}`, text: i.title }), ' ', i.text))));
  }).catch(() => box.replaceChildren(h('p', { class: 'muted', text: '리포트를 불러오지 못했어요.' })));
  return h('section', { class: 'card' }, h('h2', { text: `${pet.name} 케어 리포트` }), box);
}

function appointmentCard(pet) {
  const list = h('div', {});
  const form = h('div', {});
  const STATUS = { requested: '확인 대기', confirmed: '확정', declined: '거절', cancelled: '취소' };
  Promise.all([api('GET', `/api/pets/${pet.id}/hospitals`), api('GET', '/api/appointments')]).then(([{ hospitals }, { appointments }]) => {
    const mine = appointments.filter((a) => a.pet_id === pet.id);
    list.replaceChildren(mine.length ? h('ul', { class: 'list' }, mine.slice(0, 5).map((a) => h('li', {},
      h('strong', { text: `${a.date} ${a.time}` }), ` · ${a.hospital_name} `, h('span', { class: `pill ${a.status === 'confirmed' ? 'ok' : a.status === 'requested' ? 'warn' : ''}`, text: STATUS[a.status] }),
      a.reason && h('p', { class: 'muted', text: a.reason }),
      ['requested', 'confirmed'].includes(a.status) && h('button', { class: 'btn danger small', text: '예약 취소', onclick: () => act(() => api('POST', `/api/appointments/${a.id}/cancel`)) }))))
      : h('p', { class: 'muted', text: '예정된 예약이 없어요.' }));
    if (!hospitals.length) return form.replaceChildren(h('p', { class: 'muted', text: '병원을 연결하면 앱에서 예약할 수 있어요.' }));
    const hosp = select(hospitals.map((x) => [String(x.id), x.name]), String(hospitals[0].id), { 'aria-label': '병원' });
    const d = h('input', { type: 'date', 'aria-label': '날짜' });
    const t = h('input', { type: 'time', 'aria-label': '시간', value: '10:00' });
    const reason = h('input', { placeholder: '방문 사유 (선택)', 'aria-label': '방문 사유' });
    form.replaceChildren(field('병원', hosp), h('div', { class: 'row' }, field('날짜', d), field('시간', t)), field('방문 사유', reason),
      h('button', { class: 'btn small', text: '예약 요청', onclick: () => act(async () => {
        await api('POST', `/api/pets/${pet.id}/appointments`, { hospital_id: Number(hosp.value), date: d.value, time: t.value, reason: reason.value || null });
        toast('예약을 요청했어요. 병원이 확인하면 알려드려요.');
      }) }));
  }).catch(() => {});
  return h('section', { class: 'card' }, h('h2', { text: '병원 예약' }), list, form);
}

function petForm(pet) {
  const f = {
    name: h('input', { value: pet?.name ?? '' }),
    species: select(Object.entries(SPECIES), pet?.species ?? 'dog', { disabled: Boolean(pet) }),
    breed: h('input', { value: pet?.breed ?? '' }),
    birth: h('input', { type: 'date', value: pet?.birth_date ?? '' }),
    weight: h('input', { type: 'number', step: '0.1', min: '0.1', value: pet?.weight_kg ?? '' }),
    vaccinated: h('input', { type: 'checkbox', checked: pet?.vaccinated }),
    healthy: h('input', { type: 'checkbox', checked: pet?.healthy }),
    blood: select([['', '모름'], ...BLOOD.dog.concat(BLOOD.cat).map((b) => [b, b])], pet?.blood_type ?? ''),
  };
  const dialog = h('div', { class: 'card', role: 'dialog', 'aria-label': pet ? '반려동물 수정' : '반려동물 등록' },
    h('h2', { text: pet ? '반려동물 수정' : '반려동물 등록' }),
    field('이름', f.name), field('종', f.species), field('품종', f.breed), field('생년월일', f.birth), field('체중(kg)', f.weight),
    h('label', { class: 'check' }, f.vaccinated, '예방접종을 완료했어요'),
    h('label', { class: 'check' }, f.healthy, '최근 건강에 특이사항이 없어요 (자가 확인)'),
    field('혈액형 (병원 검사로 확인되기 전에는 매칭에 쓰이지 않아요)', f.blood),
    h('div', { class: 'row' },
      h('button', { class: 'btn', text: '저장', onclick: () => act(async () => {
        const body = { name: f.name.value, species: f.species.value, breed: f.breed.value || null, birth_date: f.birth.value || null,
          weight_kg: f.weight.value || null, vaccinated: f.vaccinated.checked, healthy: f.healthy.checked, blood_type: f.blood.value || null };
        if (pet) { delete body.species; await api('PATCH', `/api/pets/${pet.id}`, body); }
        else { const r = await api('POST', '/api/pets', body); state.petId = r.pet.id; }
        render();
      }) }),
      h('button', { class: 'btn ghost', text: '취소', onclick: render })));
  mount(root, dialog);
}

// ───────── 콜펫
function matchCard(m) {
  const waiting = m.status === 'notified' && m.request_status === 'open';
  return h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', { text: `${m.pet_name} · ${m.blood_type}` }), h('span', { class: `pill ${m.status === 'completed' ? 'ok' : waiting ? 'warn' : ''}`, text: MATCH[m.status] })),
    h('p', { text: `${m.hospital_name} 에서 ${m.units}마리분 필요 · ${m.needed_by}까지` }),
    m.distance_km != null && h('p', { class: 'muted', text: `약 ${m.distance_km.toFixed(1)}km` }),
    m.note && h('p', { text: m.note }),
    m.hospital_phone && h('p', {}, '병원 연락처 ', h('a', { href: `tel:${m.hospital_phone}`, text: m.hospital_phone })),
    m.hospital_address && h('p', { class: 'muted', text: m.hospital_address }),
    waiting && h('div', { class: 'row' },
      h('button', { class: 'btn', text: '헌혈할게요', onclick: () => act(() => api('POST', `/api/matches/${m.id}/respond`, { accept: true })) }),
      h('button', { class: 'btn ghost', text: '어려워요', onclick: () => act(() => api('POST', `/api/matches/${m.id}/respond`, { accept: false })) })));
}

function renderCallpet() {
  const waiting = state.matches.filter((m) => m.status === 'notified' && m.request_status === 'open');
  const others = state.matches.filter((m) => !waiting.includes(m));
  const points = h('div', {});
  api('GET', '/api/points').then((p) => {
    points.replaceChildren(
      h('p', {}, h('strong', { text: `${p.total}P` }), ` · 헌혈 ${p.donations}회`),
      p.badges.length ? h('div', { class: 'row' }, p.badges.map((b) => h('span', { class: 'pill ok', text: b }))) : h('p', { class: 'muted', text: '첫 헌혈을 하면 배지를 받아요.' }),
      h('p', { class: 'muted', text: '포인트는 감사의 표시이며 현금으로 바꿀 수 없어요.' }));
  }).catch(() => {});
  const rewards = h('div', {});
  api('GET', '/api/rewards').then((r) => {
    rewards.replaceChildren(h('ul', { class: 'list' }, r.rewards.map((x) => h('li', { class: 'row between' },
      h('span', { text: `${x.name} · ${x.cost}P` }),
      h('button', { class: 'btn ghost small', disabled: !x.affordable, text: '교환', onclick: () => act(async () => {
        await api('POST', `/api/rewards/${x.id}/redeem`);
        toast('교환했어요 (시연용 교환권)');
      }) })))));
  }).catch(() => {});
  return h('main', {},
    h('h1', { text: '콜펫' }),
    h('p', { class: 'disclaimer', text: '헌혈 가능 여부와 수혈 판단은 수의사가 최종 확인합니다. 아래 기준은 참고용이에요.' }),
    waiting.length > 0 && h('div', {}, h('h2', { text: '응답 대기' }), waiting.map(matchCard)),
    h('section', { class: 'card' }, h('h2', { text: '헌혈 등록' }), state.pets.length ? state.pets.map(donorCard) : h('p', { class: 'muted', text: '먼저 수첩에서 반려동물을 등록해 주세요.' })),
    h('section', { class: 'card' }, h('h2', { text: '나의 기여' }), points),
    h('section', { class: 'card' }, h('h2', { text: '포인트 교환' }), h('p', { class: 'muted', text: '시연용 목록이에요. 실제 교환은 제휴가 연결된 뒤에 가능해요.' }), rewards),
    others.length > 0 && h('div', {}, h('h2', { text: '진행·지난 요청' }), others.map(matchCard)));
}

function donorCard(pet) {
  const d = pet.donor;
  const consent = h('input', { type: 'checkbox' });
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', { text: pet.name }),
      h('span', { class: `pill ${d.registered ? 'ok' : ''}`, text: d.registered ? '헌혈 등록됨' : '미등록' })),
    !d.blood_type_verified && h('p', { class: 'muted', text: '병원에서 혈액형 검사를 받으면 매칭 후보가 될 수 있어요. 수첩에서 병원을 연결해 주세요.' }),
    d.eligible
      ? h('p', { class: 'pill ok', text: '현재 헌혈 가능 조건을 충족해요' })
      : h('ul', { class: 'list' }, d.reasons.map((r) => h('li', { class: 'muted', text: r }))),
    d.registered
      ? h('button', { class: 'btn danger small', text: '등록 해제', onclick: () => act(() => api('DELETE', `/api/pets/${pet.id}/donor`)) })
      : h('div', {},
        h('label', { class: 'check' }, consent, '반려동물의 헌혈 참여에 동의하며, 긴급 요청 알림과 위치 기반 매칭에 동의합니다. 언제든 해제할 수 있어요.'),
        h('button', { class: 'btn small', text: '헌혈 등록', onclick: () => {
          if (!consent.checked) return toast('동의가 필요합니다.', 'error');
          act(async () => { await api('PUT', `/api/pets/${pet.id}/donor`, { consent: true }); toast('헌혈 등록이 완료되었어요'); });
        } })));
}

// ───────── 내 정보
function renderMe() {
  const name = h('input', { value: state.me.name });
  const list = h('div', {});
  api('GET', '/api/notifications').then(({ notifications }) => {
    list.replaceChildren(notifications.length
      ? h('ul', { class: 'list' }, notifications.slice(0, 20).map((n) => h('li', {}, h('strong', { text: n.title }), n.read ? '' : ' ●', h('p', { class: 'muted', text: n.body }))))
      : h('p', { class: 'muted', text: '알림이 없어요.' }));
    if (state.unread) api('POST', '/api/notifications/read').then(() => { state.unread = 0; }).catch(() => {});
  }).catch(() => {});
  return h('main', {},
    h('h1', { text: '내 정보' }),
    h('section', { class: 'card' },
      field('이름', name),
      h('p', { class: 'muted', text: `위치: ${state.me.lat != null ? '등록됨' : '미등록'}` }),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', text: '저장', onclick: guard(async () => { const r = await api('PATCH', '/api/me', { name: name.value }); state.me = r.user; toast('저장했어요'); render(); }) }),
        h('button', { class: 'btn ghost small', text: '현재 위치로 갱신', onclick: guard(async () => { const r = await api('PATCH', '/api/me', await getPosition()); state.me = r.user; toast('위치를 갱신했어요'); render(); }) }))),
    h('section', { class: 'card' }, h('h2', { text: '알림' }), list),
    h('button', { class: 'btn ghost', text: '로그아웃', onclick: () => { session.token = null; clearInterval(state.poll); renderAuth(); } }));
}

boot();
