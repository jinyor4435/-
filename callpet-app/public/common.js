// 공통 유틸: DOM 헬퍼(항상 textContent로 넣어 XSS를 막는다), API 호출, 세션 보관.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat().filter(Boolean));
}

// 병원 화면과 보호자 앱이 같은 브라우저에서 서로 로그아웃시키지 않도록 키를 나눈다.
const TOKEN_KEY = location.pathname.startsWith('/hospital') ? 'callpet_hospital_token' : 'callpet_token';
export const session = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* 저장소를 못 쓰는 환경 */ }
  },
};

export async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || '요청에 실패했습니다.');
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: 'status', text: message });
  box.append(t);
  setTimeout(() => t.remove(), 3500);
}

// 비동기 동작을 감싸 오류를 토스트로 보여준다.
export function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (e) { toast(e.message, 'error'); }
  };
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('이 기기에서는 위치를 가져올 수 없습니다.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('위치 권한이 필요합니다. 브라우저 설정을 확인해 주세요.')),
      { timeout: 10000 }
    );
  });
}

export const SPECIES = { dog: '강아지', cat: '고양이' };
export const BLOOD = { dog: ['DEA1.1+', 'DEA1.1-'], cat: ['A', 'B', 'AB'] };
export const KIND = { visit: '진료', vaccine: '접종', medication: '복약', walk: '산책', meal: '식사', water: '음수', groom: '미용', memo: '메모' };
export const MATCH = { notified: '응답 대기', accepted: '수락', declined: '거절', completed: '완료', closed: '종료' };

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export function field(label, input) {
  return h('label', { class: 'field' }, h('span', { text: label }), input);
}

export function select(options, value, props = {}) {
  return h('select', props, options.map(([v, t]) => h('option', { value: v, text: t, selected: v === value })));
}
