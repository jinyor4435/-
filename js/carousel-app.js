/**
 * 카드뉴스 생성기 화면 — 주제를 넣으면 카피(Claude) → 카드 그림(캔버스) → PNG까지 잇는다.
 * API 호출은 앱 본체와 같은 js/llm.js를 그대로 쓴다.
 */
(function () {
  'use strict';

  const LS_KEY = 'carousel_last_v1';
  const $ = (sel) => document.querySelector(sel);

  const state = { data: null, photos: [], busy: false, abort: null };

  /* ───────── 화면 준비 ───────── */

  function init() {
    fillThemes();
    fillModels();
    restore();
    $('#gen').addEventListener('click', run);
    $('#sample').addEventListener('click', showSample);
    $('#theme').addEventListener('change', paint);
    $('#brand').addEventListener('input', debounce(paint, 250));
    $('#photos').addEventListener('change', loadPhotos);
    $('#saveAll').addEventListener('click', saveAll);
    $('#copyCaption').addEventListener('click', copyCaption);
    $('#key').addEventListener('change', () => {
      LLM.set({ apiKey: $('#key').value.trim(), model: $('#model').value });
      updateKeyHint();
    });
    $('#model').addEventListener('change', () => LLM.set({ model: $('#model').value }));
    updateKeyHint();
  }

  function fillThemes() {
    const sel = $('#theme');
    Object.keys(CarouselRender.THEMES).forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = CarouselRender.THEMES[id].name;
      sel.appendChild(o);
    });
  }

  function fillModels() {
    const sel = $('#model');
    LLM.MODELS.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name + ' — ' + m.hint;
      sel.appendChild(o);
    });
    const s = LLM.get();
    sel.value = s.model;
    $('#key').value = s.apiKey || '';
  }

  function updateKeyHint() {
    const ready = LLM.ready();
    $('#keyHint').textContent = ready
      ? '키가 저장돼 있습니다 (' + LLM.maskKey(LLM.get().apiKey) + '). 이 브라우저에만 남습니다.'
      : 'API 키가 없으면 생성 버튼이 동작하지 않습니다. 키 없이 레이아웃만 보려면 「샘플로 보기」를 누르세요.';
    $('#gen').disabled = !ready || state.busy;
  }

  /* ───────── 생성 ───────── */

  async function run() {
    if (state.busy) return;
    const topic = $('#topic').value.trim();
    if (!topic) { alert('주제나 제목을 먼저 넣어 주세요.'); $('#topic').focus(); return; }

    const input = {
      topic: topic,
      audience: $('#audience').value,
      message: $('#message').value,
      tone: $('#tone').value,
      platform: $('#platform').value,
      density: $('#density').value
    };

    setBusy(true, '카피를 쓰는 중…');
    state.abort = new AbortController();
    try {
      const text = await LLM.stream({
        prompt: CarouselPrompt.build(input),
        maxTokens: 8000,
        signal: state.abort.signal,
        onThinking: (t) => setStatus(t ? '생각하는 중…' : '카피를 쓰는 중…'),
        onToken: (_chunk, full) => setStatus('카피를 쓰는 중… ' + full.length + '자')
      });
      state.data = CarouselPrompt.parse(text);
      save();
      paint();
      setStatus('완성됐습니다. 카드를 확인하고 PNG로 내려받으세요.');
    } catch (e) {
      if (e && e.name === 'AbortError') setStatus('중단했습니다.');
      else { setStatus(''); alert(e.message || String(e)); }
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on, msg) {
    state.busy = on;
    $('#gen').disabled = on || !LLM.ready();
    $('#gen').textContent = on ? '생성 중…' : '카드뉴스 만들기';
    if (msg) setStatus(msg);
  }

  function setStatus(msg) { $('#status').textContent = msg || ''; }

  /* ───────── 그리기 ───────── */

  function paint() {
    const data = state.data;
    const wrap = $('#cards');
    wrap.innerHTML = '';
    if (!data) { $('#result').hidden = true; return; }
    $('#result').hidden = false;

    const theme = $('#theme').value;
    const brand = $('#brand').value.trim();
    const shots = CarouselRender.assignPhotos(data.cards, state.photos);

    data.cards.forEach((card, i) => {
      const fig = document.createElement('figure');
      fig.className = 'card';
      const canvas = document.createElement('canvas');
      CarouselRender.renderCard(canvas, card, {
        theme: theme, brand: brand, index: i, total: data.cards.length,
        photo: shots[i].photo, tiles: shots[i].tiles
      });
      const cap = document.createElement('figcaption');
      cap.innerHTML = '<span>' + (i + 1) + '. ' + kindLabel(card.kind) + '</span>';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini';
      btn.textContent = 'PNG';
      btn.addEventListener('click', () => download(canvas, i + 1));
      cap.appendChild(btn);
      fig.appendChild(canvas);
      fig.appendChild(cap);
      wrap.appendChild(fig);
    });

    paintChecks(CarouselPrompt.check(data));
    $('#caption').value = buildCaption(data);
    $('#meta').textContent = [data.topic, data.audience, data.message].filter(Boolean).join(' · ');
  }

  function kindLabel(kind) {
    return { hook: '훅', turn: '전환', step: '해법', outro: '회수·CTA' }[kind] || '본문';
  }

  function paintChecks(list) {
    const box = $('#checks');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<li class="ok">세 룰 통과 — 남은 건 사람이 볼 부분입니다. 훅이 정말 궁금한지, 전환에 힘이 있는지.</li>';
      return;
    }
    list.forEach((c) => {
      const li = document.createElement('li');
      li.className = c.level;
      li.textContent = c.text;
      box.appendChild(li);
    });
  }

  function buildCaption(data) {
    const tags = (data.hashtags || []).join(' ');
    return [data.caption || '', '', tags].join('\n').trim();
  }

  /* ───────── 사진 ───────── */

  function loadPhotos(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) { state.photos = []; paint(); return; }
    let left = files.length;
    const imgs = [];
    files.forEach((file, i) => {
      const img = new Image();
      img.onload = () => { imgs[i] = img; if (--left === 0) { state.photos = imgs.filter(Boolean); paint(); } };
      img.onerror = () => { if (--left === 0) { state.photos = imgs.filter(Boolean); paint(); } };
      img.src = URL.createObjectURL(file);
    });
    setStatus(files.length + '장을 배경과 사진으로 씁니다.');
  }

  /* ───────── 내보내기 ───────── */

  function download(canvas, n) {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'card-' + String(n).padStart(2, '0') + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  function saveAll() {
    const list = Array.from(document.querySelectorAll('#cards canvas'));
    list.forEach((c, i) => setTimeout(() => download(c, i + 1), i * 350));
    setStatus(list.length + '장을 내려받는 중입니다. 브라우저가 여러 파일 저장을 물어보면 허용하세요.');
  }

  function copyCaption() {
    const el = $('#caption');
    el.select();
    navigator.clipboard.writeText(el.value).then(
      () => setStatus('캡션을 복사했습니다.'),
      () => setStatus('복사가 막혔습니다 — 캡션 상자에서 직접 복사하세요.')
    );
  }

  /* ───────── 저장 / 샘플 ───────── */

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.data)); } catch (e) { /* 무시 */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { state.data = JSON.parse(raw); paint(); }
    } catch (e) { /* 무시 */ }
  }

  function showSample() {
    state.data = SAMPLE;
    paint();
    setStatus('샘플입니다. 주제를 넣고 「카드뉴스 만들기」를 누르면 내 주제로 바뀝니다.');
  }

  const SAMPLE = {
    topic: '저속노화 — 노화 속도를 늦추는 하루 습관',
    audience: '관리한다고 하는데 컨디션이 그대로인 30~40대',
    message: '노화는 더 챙겨서가 아니라 덜 무너져서 늦춰진다',
    cards: [
      { kind: 'hook', kicker: '저속노화 · 하루 습관 읽기', title: '노화는\n어젯밤에 정해집니다', body: [] },
      { kind: 'body', title: '관리한다고는 합니다', body: ['그런데 아침마다 더 피곤합니다', '일곱 시간을 자도 개운하지 않고', '오후 세 시면 단 게 당깁니다'] },
      { kind: 'body', title: '영양제는 늘었는데\n컨디션은 그대로입니다', body: ['좋다는 건 검색해서 다 해봤습니다', '그런데 진짜 문제는 여기가 아닙니다'] },
      { kind: 'body', title: '다들 뭘 더\n챙기라고 합니다', body: ['그래서 할 일이 계속 쌓입니다', '바쁜 주가 오면 제일 먼저 밀립니다'] },
      { kind: 'turn', title: '하지만\n노화를 늦추는 건\n더 하는 게 아니라\n덜 무너지는 겁니다', body: [] },
      { kind: 'step', step: 1, title: '밤에 몸을 식힙니다', body: ['잠은 체온이 내려갈 때 깊어집니다', '자기 한두 시간 전 미지근하게 씻고', '방은 조금 서늘하게 둡니다'] },
      { kind: 'step', step: 2, title: '혈당을\n출렁이게 두지 않습니다', body: ['채소 먼저, 단백질 다음, 밥은 마지막', '식후 10분만 걸어도 도움이 됩니다'] },
      { kind: 'step', step: 3, title: '근육은\n노화의 브레이크입니다', body: ['근육은 30대부터 조금씩 줄어듭니다', '주 2회, 다리와 등처럼 큰 근육부터'] },
      { kind: 'outro', title: '노화는 어젯밤에 정해졌고\n오늘 밤도 정해집니다', body: ['세 가지를 다 할 필요는 없습니다', '오늘 밤 하나만 골라도 충분합니다'], cta: '저장해두고 오늘 밤 한 가지만 해보세요' }
    ],
    caption: '관리하는데 왜 그대로일까요.\n\n몸은 더 챙긴 것보다 덜 무너진 쪽을 기억합니다. 밤에 잘 식은 몸, 출렁이지 않은 혈당, 버텨준 근육. 이 세 가지가 다음 날의 컨디션을 만듭니다.\n\n오늘 세 가지를 다 하려고 하지 마세요. 하나만 고르는 게 훨씬 오래 갑니다.',
    hashtags: ['#저속노화', '#웰니스', '#건강루틴', '#수면습관', '#혈당관리', '#근력운동', '#자기관리', '#컨디션관리', '#루틴만들기']
  };

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  document.addEventListener('DOMContentLoaded', init);
  window.CarouselApp = { paint: paint, showSample: showSample };
})();
