/**
 * 앱 본체 — 단계별 위저드, 프로젝트 상태(localStorage), 프롬프트 복사/응답 파싱.
 */
(function () {
  'use strict';

  const LS_KEY = 'gfp_projects_v1';

  const STEPS = [
    { id: 'setup', label: '설정 · 사업 유형', num: '⚙' },
    { id: 'announce', label: '공고문 분석', num: '0' },
    { id: 'idea', label: '아이템 발굴·재정의', num: '1' },
    { id: 'plan', label: '사업 기획 (PSST)', num: '2' },
    { id: 'poc', label: 'PoC 검증 설계', num: '3' },
    { id: 'write', label: '사업계획서 작성', num: '4' },
    { id: 'review', label: '모의심사', num: '5' },
    { id: 'deck', label: 'IR Deck', num: '6' },
    { id: 'export', label: '내보내기', num: '📦' }
  ];

  let state = { projects: {}, currentId: null };
  const ui = { step: 'setup', activeSectionId: null, ideaFields: ['ai'], ideaMode: 'new', prompts: {}, run: null, abort: null, batch: null };

  /* ───────── 저장/로드 ───────── */

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) state = JSON.parse(raw);
    } catch (e) { /* 손상 시 초기화 */ }
    if (!state.projects) state = { projects: {}, currentId: null };
    if (!state.currentId || !state.projects[state.currentId]) {
      const ids = Object.keys(state.projects);
      if (ids.length) state.currentId = ids[0];
      else newProject('내 첫 프로젝트');
    }
  }

  let saveTimer = null;
  let storageBlocked = false;
  function save() {
    const p = cur();
    if (p) p.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 일부 환경(내장 프레임, 시크릿 모드)은 저장소를 막는다. 이때도 앱은 계속 동작해야 한다.
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
        flashSave('저장됨 ✓');
      } catch (e) {
        const first = !storageBlocked;
        storageBlocked = true;
        flashSave('임시 저장 (브라우저 저장 불가)', 3000);
        if (first) {
          toast('이 환경에서는 브라우저 저장소가 막혀 있어, 새로고침하면 작업 내용이 사라집니다. ' +
            '내보내기 → 프로젝트 백업으로 수시로 저장해 주세요.', 'warn', 12000);
          render();  // 상단 경고 배너를 띄운다
        }
      }
    }, 250);
  }

  function flashSave(text, ms) {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    el.textContent = text;
    setTimeout(() => { el.textContent = ''; }, ms || 1500);
  }

  function cur() { return state.projects[state.currentId]; }

  function newProject(name) {
    const id = 'p' + Date.now().toString(36);
    state.projects[id] = {
      id, name: name || '새 프로젝트', createdAt: Date.now(), updatedAt: Date.now(),
      programType: 'package',
      company: {},
      announcement: { rawText: '', analysis: null, files: [] },
      form: { rawText: '', analysis: null, files: [] },
      ideas: [], selectedIdeaIndex: -1,
      reframeBiz: '',
      planning: { raw: '' }, poc: null, sections: {}, review: { content: '' }, deck: null
    };
    state.currentId = id;
    return state.projects[id];
  }

  /* ───────── 완료 판정 ───────── */

  function stepDone(stepId) {
    const p = cur();
    if (!p) return false;
    switch (stepId) {
      case 'setup': return !!p.programType;
      case 'announce': return !!((p.form && p.form.analysis) || (p.announcement && p.announcement.analysis));
      case 'idea': return p.selectedIdeaIndex >= 0 && !!(p.ideas || [])[p.selectedIdeaIndex];
      case 'plan': return !!(p.planning && p.planning.raw);
      case 'poc': return !!(p.poc && Array.isArray(p.poc.metrics) && p.poc.metrics.length);
      case 'write': {
        const secs = getSections(p);
        return secs.length > 0 && secs.every((s) => p.sections[s.id] && p.sections[s.id].content);
      }
      case 'review': return !!(p.review && p.review.content);
      case 'deck': return !!(p.deck && p.deck.slides && p.deck.slides.length);
      default: return false;
    }
  }

  /* ───────── 알림·확인·입력 (브라우저 기본 대화상자는 내장 환경에서 무시된다) ───────── */

  function esc2(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /** 화면 우측 상단 알림. type: info | ok | warn | error */
  function toast(message, type, ms) {
    let box = document.getElementById('toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastBox';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast-msg">${esc2(message).replace(/\n/g, '<br>')}</span>
      <button class="toast-x" aria-label="닫기">×</button>`;
    el.querySelector('.toast-x').addEventListener('click', () => el.remove());
    box.appendChild(el);
    const life = ms || (type === 'error' ? 9000 : type === 'warn' ? 7000 : 3500);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, life);
    return el;
  }

  /**
   * 앱 자체 대화상자. opts.input 을 주면 입력창을 띄운다.
   * 반환: 확인 시 true(또는 입력값), 취소 시 false(또는 null)
   */
  function dialog(opts) {
    return new Promise((resolve) => {
      const o = opts || {};
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${esc2(o.title || '확인')}</h3>
          ${o.message ? `<p>${esc2(o.message).replace(/\n/g, '<br>')}</p>` : ''}
          ${o.input !== undefined ? `<input type="text" class="modal-input" value="${esc2(o.input)}">` : ''}
          <div class="modal-actions">
            <button class="btn secondary" data-role="cancel">${esc2(o.cancelText || '취소')}</button>
            <button class="btn ${o.danger ? 'danger-solid' : ''}" data-role="ok">${esc2(o.okText || '확인')}</button>
          </div>
        </div>`;
      document.body.appendChild(back);

      const field = back.querySelector('.modal-input');
      const done = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
      const cancelValue = o.input !== undefined ? null : false;
      const okValue = () => (o.input !== undefined ? (field.value.trim() || o.input) : true);

      back.querySelector('[data-role="cancel"]').addEventListener('click', () => done(cancelValue));
      back.querySelector('[data-role="ok"]').addEventListener('click', () => done(okValue()));
      back.addEventListener('click', (e) => { if (e.target === back) done(cancelValue); });

      const onKey = (e) => {
        if (e.key === 'Escape') done(cancelValue);
        if (e.key === 'Enter' && field) done(okValue());
      };
      document.addEventListener('keydown', onKey);

      setTimeout(() => { (field || back.querySelector('[data-role="ok"]')).focus(); if (field) field.select(); }, 30);
    });
  }

  /** 제출본 형태의 전체 미리보기 — 크게 보고 그 자리에서 인쇄까지 */
  function openPreview(project) {
    const secs = getSections(project);
    const written = secs.filter((s) => (project.sections || {})[s.id] && project.sections[s.id].content).length;
    if (!written) { toast('아직 작성된 섹션이 없습니다. 4단계에서 먼저 작성해 주세요.', 'warn'); return; }

    const back = document.createElement('div');
    back.className = 'modal-back preview-back';
    back.innerHTML = `
      <div class="preview-shell" role="dialog" aria-modal="true" aria-label="사업계획서 미리보기">
        <div class="preview-bar">
          <b>사업계획서 미리보기</b>
          <span class="hint">${written}/${secs.length} 섹션${project.poc ? ' · PoC 붙임 포함' : ''}</span>
          <span style="flex:1"></span>
          <button class="btn secondary small" data-role="print">🖨 인쇄 · PDF</button>
          <button class="btn secondary small" data-role="close">닫기</button>
        </div>
        <div class="preview-page preview">${buildPlanHtml(project)}</div>
      </div>`;
    document.body.appendChild(back);

    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.querySelector('[data-role="close"]').addEventListener('click', close);
    back.querySelector('[data-role="print"]').addEventListener('click', () => {
      const how = exportPdf(project);
      if (how === false) toast('이 환경에서는 인쇄가 막혀 있습니다. DOCX나 한글 파일을 내려받아 저장해 주세요.', 'error');
    });
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
  }

  const confirmDialog = (message, opts) => dialog(Object.assign({ title: '확인', message }, opts || {}));
  const promptDialog = (message, value, opts) => dialog(Object.assign({ title: message, input: value || '' }, opts || {}));

  /** 클립보드 복사 — 권한이 막힌 환경에서도 최대한 성공시키고, 실패는 눈에 보이게 알린다 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 아래 폴백 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /* ───────── 공용 렌더 헬퍼 ───────── */

  function promptBlock(key, generateFn, buttonLabel) {
    const val = ui.prompts[key] || '';
    return `
      <div class="btn-row">
        <button class="btn" data-act="genPrompt" data-key="${key}">🪄 ${buttonLabel || '프롬프트 생성'}</button>
        ${val ? `<button class="btn secondary" data-act="copyPrompt" data-key="${key}">📋 복사</button>` : ''}
      </div>
      ${val ? `<textarea class="prompt-out" id="prompt_${key}" readonly>${esc2(val)}</textarea>
      <ol class="howto">
        <li>위 <b>복사</b> 버튼을 누릅니다.</li>
        <li><b>Claude(claude.ai)</b> 대화창에 붙여넣고 답변을 받습니다.</li>
        <li>Claude가 준 <b>답변</b>을 아래 칸에 붙여넣습니다. <span class="warn-inline">이 프롬프트를 그대로 붙여넣으면 안 됩니다.</span></li>
      </ol>` : ''}`;
  }

  function pasteBlock(key, placeholder) {
    return `
      <textarea id="paste_${key}" placeholder="${esc2(placeholder || 'Claude가 준 답변을 여기에 붙여넣으세요 (위 프롬프트가 아니라, Claude의 응답입니다)')}"></textarea>
      <div class="btn-row"><button class="btn" data-act="savePaste" data-key="${key}">💾 응답 저장 · 파싱</button></div>`;
  }

  /**
   * 생성 블록 — API 키가 있으면 버튼 한 번으로 결과만 흘려주고,
   * 없으면 기존 복사·붙여넣기(수동) 흐름을 그대로 보여준다.
   */
  function genBlock(key, label, placeholder) {
    const manual = promptBlock(key, null, (label || '프롬프트') + ' 프롬프트 생성') + pasteBlock(key, placeholder);

    if (!LLM.ready()) {
      return `<div class="alert info">🤖 <b>자동 생성</b>을 쓰려면 <b>설정</b> 단계에서 Claude API 키를 한 번만 넣으면 됩니다.
        그러면 프롬프트를 복사해 붙여넣을 필요 없이 <b>결과만</b> 이 화면에 나옵니다.
        <button class="btn secondary small" data-act="goStep" data-step="setup">설정으로 이동</button></div>${manual}`;
    }

    const run = ui.run && ui.run.key === key ? ui.run : null;
    const busy = !!run && run.status === 'running';
    const head = busy
      ? (run.thinking ? '🧠 심사 기준에 맞춰 구상하는 중…' : '✍️ 작성 중…')
      : (run && run.status === 'error' ? '⚠ 생성이 끝나지 못했습니다' : '✅ 생성 결과');
    const streamPanel = run ? `
      <div class="stream-wrap ${esc2(run.status)}">
        <div class="stream-head" id="streamhead_${key}">${head}</div>
        <pre class="stream-out" id="stream_${key}">${esc2(run.text || '')}</pre>
        ${run.status === 'error' && run.error ? `<div class="alert error">${esc2(run.error).replace(/\n/g, '<br>')}</div>` : ''}
        ${!busy && run.text ? `<div class="btn-row">
          <button class="btn secondary small" data-act="useRun" data-key="${key}">이 결과 그대로 저장</button>
          <button class="btn secondary small" data-act="copyRun" data-key="${key}">📋 결과 복사</button>
        </div>` : ''}
      </div>` : '';

    return `
      <div class="btn-row">
        <button class="btn ${busy ? 'secondary' : ''}" data-act="autoGen" data-key="${key}" ${busy ? 'disabled' : ''}>${busy ? '⏳ 생성 중…' : '🤖 ' + esc2(label || '자동 생성')}</button>
        ${busy ? '<button class="btn secondary" data-act="stopGen">■ 중단</button>' : ''}
      </div>
      ${streamPanel}
      <details class="collapse manual"><summary>수동 모드 — 프롬프트를 복사해 Claude 앱에 붙여넣기</summary><div class="inner">${manual}</div></details>`;
  }

  /* ───────── 자동 생성 설정 ───────── */

  function renderLlmCard() {
    const s = LLM.get();
    const ready = LLM.ready();
    const opts = LLM.MODELS.map((m) => `<option value="${m.id}" ${s.model === m.id ? 'selected' : ''}>${esc2(m.name)} — ${esc2(m.hint)}</option>`).join('');
    return `
      <div class="card">
        <h3>🤖 자동 생성 <span class="hint" style="display:inline">— 프롬프트 붙여넣기 없이, 결과만 받아 보기</span></h3>
        ${ready
          ? `<div class="alert ok">자동 생성이 켜져 있습니다 (키 ${esc2(LLM.maskKey(s.apiKey))}). 각 단계에서 <b>🤖 버튼 한 번</b>이면 앱이 알아서 최적 프롬프트를 만들어 실행하고 결과만 보여줍니다.</div>`
          : `<div class="alert info">Claude API 키를 넣으면 모든 단계가 <b>버튼 한 번</b>으로 진행됩니다. 넣지 않아도 기존처럼 프롬프트를 복사해 쓰는 수동 모드로 쓸 수 있습니다.</div>`}
        <div class="form-grid">
          <label>API 키</label>
          <input type="password" id="llmKey" value="${esc2(s.apiKey || '')}" placeholder="sk-ant-... (console.anthropic.com에서 발급)" autocomplete="off" spellcheck="false">
          <label>모델</label>
          <select id="llmModel">${opts}</select>
        </div>
        <div class="btn-row">
          <button class="btn" data-act="saveLlm">저장 · 연결 테스트</button>
          <button class="btn secondary" data-act="toggleKeyView">키 보기/숨기기</button>
          ${ready ? '<button class="btn secondary" data-act="clearLlm">키 삭제</button>' : ''}
        </div>
        <p class="hint">키는 <b>이 브라우저에만</b> 저장되고, 요청은 앱에서 Anthropic으로 바로 나갑니다 (중계 서버 없음). 사용량만큼 API 요금이 청구됩니다.</p>
        <p class="hint">⚠ 게시된 <b>웹 링크(아티팩트)</b> 안에서는 보안 정책상 외부 통신이 막혀 자동 생성이 동작하지 않습니다. 아래 버튼으로 이 앱을 파일로 저장한 뒤, 그 파일을 브라우저로 열면 자동 생성이 동작합니다.</p>
        <div class="btn-row"><button class="btn secondary" data-act="saveSelf">⬇ 이 앱을 파일로 저장 (자동 생성용)</button></div>
      </div>`;
  }

  /* ───────── 단계별 렌더 ───────── */

  function renderSetup(p) {
    const typeCards = Object.values(PROGRAMS).map((pr) => `
      <div class="type-card ${p.programType === pr.id ? 'selected' : ''}" data-act="pickType" data-type="${pr.id}">
        <b>${esc2(pr.name)}</b>
        <p>${esc2(pr.description)}</p>
        <p>기본 페이지 제한: ${pr.pageLimit}p · ${esc2(pr.format)}</p>
      </div>`).join('');
    const c = p.company || {};
    return `
      <h1 class="step-title">설정 · 사업 유형</h1>
      <p class="step-desc">어떤 지원사업에 낼지 선택하세요. 유형에 따라 목차·배점·심사 관점이 완전히 달라집니다.</p>
      <div class="card"><h3>프로젝트 이름</h3>
        <input type="text" id="projName" value="${esc2(p.name)}" data-act="editName">
      </div>
      <div class="card"><h3>사업 유형</h3><div class="type-grid">${typeCards}</div></div>
      <div class="card"><h3>지원자(팀) 정보 <span class="hint" style="display:inline">— 선택 입력. 비워두면 계획서의 팀 관련 서술은 【확인】 마커로 남습니다.</span></h3>
        <div class="form-grid">
          <label>회사/팀명</label><input type="text" data-company="name" value="${esc2(c.name || '')}" placeholder="예: (주)딥테크랩 또는 예비창업자 홍길동">
          <label>단계</label><input type="text" data-company="stage" value="${esc2(c.stage || '')}" placeholder="예: 예비창업 / 법인 설립 1년차 / 시제품 보유">
          <label>팀 구성</label><input type="text" data-company="team" value="${esc2(c.team || '')}" placeholder="예: 대표(AI박사), CTO(반도체 10년), 개발 2명">
          <label>보유 자산</label><input type="text" data-company="assets" value="${esc2(c.assets || '')}" placeholder="예: 특허 출원 1건(10-2025-XXXX), PoC 완료, MOU 2건">
          <label>기타</label><input type="text" data-company="notes" value="${esc2(c.notes || '')}" placeholder="자유 기재">
        </div>
      </div>
      ${renderLlmCard()}
      <div class="btn-row"><button class="btn big" data-act="goStep" data-step="announce">다음: 공고문 분석 →</button></div>`;
  }

  /** 업로드한 파일 목록 표시 */
  function fileRowsHtml(files) {
    return (files || []).map((f) => `
      <div class="file-row ${f.error ? 'bad' : ''}">
        <span class="file-kind">${esc2(f.kind || '?')}</span>
        <span class="file-name">${esc2(f.name)}</span>
        ${f.error
          ? `<span class="file-msg bad">${esc2(f.error)}</span>`
          : `<span class="file-msg">${f.chars.toLocaleString()}자 추출${f.warning ? ' · ⚠ ' + esc2(f.warning) : ''}</span>`}
      </div>`).join('');
  }

  function dropZoneHtml(target, label) {
    return `
      <div class="drop-zone" data-act="pickFiles" data-target="${target}">
        <div class="drop-icon">📄</div>
        <div><b>${esc2(label)}</b></div>
        <div class="hint">HWP · HWPX · PDF · DOCX · PPTX · TXT — 여러 개를 한 번에 올릴 수 있습니다</div>
      </div>`;
  }

  function renderAnnounce(p) {
    const a = p.announcement || {};
    const fm = p.form || {};
    const an = a.analysis;
    const fa = fm.analysis;

    let annResult = '';
    if (an) {
      const secRows = (an.sections || []).map((x) => `<tr><td>${esc2(x.title)}</td><td>${esc2(x.score == null ? '-' : x.score)}</td><td>${esc2(x.guide || '')}</td></tr>`).join('');
      annResult = `
        <div class="preview">
          <p><b>${esc2(an.title || '(공고명 미확인)')}</b> — ${esc2(an.agency || '')}</p>
          <p>마감: ${esc2(an.deadline || '-')} · 페이지 제한: ${esc2(an.pageLimit || '-')} · 지원 규모: ${esc2(an.budget || '-')}</p>
          <p>심사 기준: ${esc2(an.evaluationCriteria || '-')}</p>
          ${(an.keywords || []).map((k) => `<span class="pill">${esc2(k)}</span>`).join('')}
          ${secRows && !fa ? `<table><tr><th>공고문에서 뽑은 목차</th><th>배점</th><th>확인 포인트</th></tr>${secRows}</table>` : ''}
          ${(an.redFlags || []).length ? `<p><b>⚠ 실격/감점 조건:</b> ${an.redFlags.map(esc2).join(' · ')}</p>` : ''}
          ${an.fitAdvice ? `<p><b>프레이밍 조언:</b> ${esc2(an.fitAdvice)}</p>` : ''}
        </div>`;
    }

    let formResult = '';
    if (fa) {
      const rows = (fa.sections || []).map((x) => {
        const limit = [x.pages ? x.pages + 'p' : '', x.minChars ? '≥' + x.minChars + '자' : '', x.maxChars ? '≤' + x.maxChars + '자' : '']
          .filter(Boolean).join(' · ');
        const tables = (x.tables || []).map((t) => t.caption || '표').join(', ');
        return `<tr><td>${esc2(x.title)}</td><td>${esc2(x.score == null ? '-' : x.score)}</td><td>${esc2(limit || '-')}</td><td>${esc2(tables || '-')}</td><td>${esc2((x.guide || '').slice(0, 120))}</td></tr>`;
      }).join('');
      const st = fa.summaryTable;
      formResult = `
        <div class="preview">
          <p><b>${esc2(fa.title || '사업계획서 양식')}</b>${fa.pageLimit ? ` · 전체 ${esc2(fa.pageLimit)}페이지 이내` : ''}</p>
          ${st && (st.rows || []).length ? `<p><b>${esc2(st.caption || '요약표')}</b>: ${(st.rows || []).map((r) => esc2(r.label)).join(' · ')}</p>` : ''}
          <table><tr><th>양식 항목 (원문 그대로)</th><th>배점</th><th>분량</th><th>필수 표</th><th>작성 안내문</th></tr>${rows}</table>
          ${(fa.notes || []).length ? `<p><b>작성 유의사항:</b> ${fa.notes.map(esc2).join(' / ')}</p>` : ''}
        </div>
        <div class="alert ok">이 양식이 <b>4단계 작성의 절대 기준</b>이 됩니다. 항목명·작성 안내문·필수 표·분량 요건이 그대로 프롬프트에 들어가고, 5단계 모의심사에서 양식 준수 여부를 점검합니다.</div>`;
    }

    return `
      <h1 class="step-title">0. 공고문 · 양식 분석 <span class="hint" style="display:inline">(타겟 공고가 있으면 강력 추천)</span></h1>
      <p class="step-desc">기관이 배포한 <b>사업계획서 양식</b>이 있으면 반드시 올려주세요. 양식을 추측해서 쓰는 것이 가장 흔한 탈락 사유입니다. 파일은 이 브라우저 안에서만 처리되며 어디로도 전송되지 않습니다.</p>

      <div class="card">
        <h3>① 사업계획서 양식 <span class="hint" style="display:inline">— 가장 중요합니다. 있으면 이것이 목차의 기준이 됩니다.</span></h3>
        ${dropZoneHtml('form', '양식 파일을 끌어다 놓거나 클릭해서 선택')}
        <input type="file" id="formFiles" multiple accept=".hwp,.hwpx,.pdf,.docx,.pptx,.txt,.md" style="display:none">
        <div id="formParseStatus" class="hint"></div>
        ${(fm.files || []).length ? `<div class="file-list">${fileRowsHtml(fm.files)}</div>` : ''}
        <h3 style="margin-top:14px">양식 원문</h3>
        <textarea id="formRaw" placeholder="양식 파일을 올리면 여기 텍스트가 쌓입니다. 직접 붙여넣어도 됩니다.">${esc2(fm.rawText || '')}</textarea>
        <div class="btn-row">${(fm.rawText || '').trim() ? '<button class="btn secondary" data-act="clearRaw" data-target="form">비우기</button>' : ''}</div>
        ${genBlock('form', '양식 구조 자동 분석')}
      </div>
      ${formResult ? `<div class="card"><h3>양식 분석 결과</h3>${formResult}</div>` : ''}

      <div class="card">
        <h3>② 공고문 <span class="hint" style="display:inline">— 배점·자격·마감·실격 조건을 뽑습니다.</span></h3>
        ${dropZoneHtml('announcement', '공고문 파일을 끌어다 놓거나 클릭해서 선택')}
        <input type="file" id="annFiles" multiple accept=".hwp,.hwpx,.pdf,.docx,.pptx,.txt,.md" style="display:none">
        <div id="parseStatus" class="hint"></div>
        ${(a.files || []).length ? `<div class="file-list">${fileRowsHtml(a.files)}</div>` : ''}
        <h3 style="margin-top:14px">공고문 원문</h3>
        <textarea id="annRaw" placeholder="공고문 텍스트 전체를 붙여넣으세요">${esc2(a.rawText || '')}</textarea>
        <div class="btn-row">${(a.rawText || '').trim() ? '<button class="btn secondary" data-act="clearRaw" data-target="announcement">비우기</button>' : ''}</div>
        ${genBlock('announce', '공고문 자동 분석')}
      </div>
      ${annResult ? `<div class="card"><h3>공고 분석 결과</h3>${annResult}</div>` : ''}

      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="setup">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="idea">다음: 아이템 발굴 →</button>
      </div>`;
  }

  function renderIdea(p) {
    const chips = DEEPTECH_FIELDS.map((f) => `
      <div class="field-chip ${ui.ideaFields.includes(f.id) ? 'selected' : ''}" data-act="toggleField" data-field="${f.id}">
        <div><b>${esc2(f.name)}</b><span>${esc2(f.hint)}</span></div>
      </div>`).join('');
    const cards = (p.ideas || []).map((idea, i) => `
      <div class="idea-card ${p.selectedIdeaIndex === i ? 'selected' : ''}" data-act="pickIdea" data-idx="${i}">
        <span class="score">심사위원 매력도 ${esc2(idea.evaluatorScore || '-')}</span>
        <h4>${p.selectedIdeaIndex === i ? '✅ ' : ''}${esc2(idea.title)}</h4>
        <div class="row"><dt>정의</dt><dd>${esc2(idea.oneLiner)}</dd></div>
        ${idea.before ? `<div class="row"><dt>기존 프레임</dt><dd>${esc2(idea.before)}</dd></div>
        <div class="row"><dt>딥테크 프레임</dt><dd><b>${esc2(idea.after || '')}</b></dd></div>` : ''}
        <div class="row"><dt>기술 장벽</dt><dd>${esc2(idea.tech)}</dd></div>
        <div class="row"><dt>문제</dt><dd>${esc2(idea.problem)}</dd></div>
        <div class="row"><dt>지불 주체</dt><dd>${esc2(idea.customer)}</dd></div>
        <div class="row"><dt>차별성</dt><dd>${esc2(idea.moat)}</dd></div>
        ${idea.minusPlus ? `<div class="row"><dt>절감/증대 효과</dt><dd>${esc2(idea.minusPlus)}</dd></div>` : ''}
        <div class="row"><dt>정책 연계</dt><dd>${esc2(idea.policyFit)} · TRL ${esc2(idea.trl)}</dd></div>
        <div class="row"><dt>리스크</dt><dd>${esc2(idea.risk)}</dd></div>
      </div>`).join('');
    const isReframe = ui.ideaMode === 'reframe';
    const modePanel = isReframe ? `
        <div style="margin-top:12px"><label class="hint">현재 사업 설명 — 업종, 하는 일, 반복 업무(비효율), 보유 데이터(장부/POS/리뷰/상담기록/사진 등)를 자세히</label>
        <textarea id="reframeBiz" placeholder="예: 동네 베이커리 운영 5년차. 매일 새벽 생산량을 감으로 결정, 당일 폐기율 약 25%. POS 3년치 판매 기록과 네이버 리뷰 1,200건 보유.">${esc2(p.reframeBiz || '')}</textarea></div>`
      : `<div class="field-grid" style="margin-top:8px">${chips}</div>`;
    return `
      <h1 class="step-title">1. 아이템 발굴 · 재정의</h1>
      <p class="step-desc">신규 딥테크 아이템을 발굴하거나, 이미 하고 있는 사업을 심사위원이 "딥테크 과제"로 인식하도록 재정의합니다. 지원금의 단위를 바꾸는 것은 기술력이 아니라 프레임입니다.</p>
      <div class="card">
        <div class="btn-row">
          <button class="btn ${isReframe ? 'secondary' : ''}" data-act="ideaMode" data-mode="new">🔭 신규 아이템 발굴</button>
          <button class="btn ${isReframe ? '' : 'secondary'}" data-act="ideaMode" data-mode="reframe">♻️ 기존 사업 딥테크 재정의</button>
        </div>
        ${isReframe ? '<p class="hint">기존 사업의 비효율을 기술적 병목으로, 보유 데이터를 해자로 격상하는 재정의안 3~5개를 생성합니다.</p>' : '<p class="hint">탐색 분야 선택 (복수 가능)</p>'}
        ${modePanel}
        <div style="margin-top:12px"><label class="hint">추가 방향성 (선택)</label>
        <input type="text" id="ideaDirection" placeholder="예: 하드웨어 없이 소프트웨어만으로 가능한 것, B2B 위주"></div>
        ${genBlock('idea', isReframe ? '딥테크 재정의안 자동 생성' : '딥테크 아이템 자동 발굴')}
      </div>
      ${cards ? `<div class="card"><h3>생성된 아이템 — 클릭해서 1개 선정</h3>${cards}</div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="announce">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="plan">다음: 사업 기획 →</button>
      </div>`;
  }

  function renderPlan(p) {
    const hasIdea = p.selectedIdeaIndex >= 0 && (p.ideas || [])[p.selectedIdeaIndex];
    const parsed = parsePlanning(p.planning && p.planning.raw);
    const view = parsed.length
      ? parsed.map(([tag, title, body]) => `<details class="collapse"><summary>[${esc2(tag)}] ${esc2(title)}</summary><div class="inner preview">${blocksToHtml(parseContent(body))}</div></details>`).join('')
      : '';
    return `
      <h1 class="step-title">2. 사업 기획 (PSST)</h1>
      <p class="step-desc">선정 아이템의 기획을 확정합니다. 여기서 정한 수치(시장, KPI, 매출, BEP)가 사업계획서와 IR Deck 전체의 <b>단일 진실 공급원</b>이 됩니다 — 문서 간 수치 불일치는 대표적 감점 요인입니다.</p>
      ${hasIdea ? '' : '<div class="alert warn">1단계에서 아이템을 먼저 선정하세요.</div>'}
      <div class="card"><h3>PSST 기획</h3>${genBlock('plan', 'PSST 기획 자동 생성', '기획 본문을 붙여넣으세요 ([P1]~[P11] 태그 포함)')}</div>
      ${view ? `<div class="card"><h3>확정된 기획</h3>${view}</div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="idea">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="poc">다음: PoC 검증 설계 →</button>
      </div>`;
  }

  function renderPoc(p) {
    const poc = p.poc;
    let canvas = '';
    if (poc) {
      canvas = `
        <div class="card"><h3>PoC 캔버스</h3>
          <div class="preview">${blocksToHtml(parseContent(pocToMarkdown(poc)))}</div>
          <div class="btn-row">
            <button class="btn secondary" data-act="copyPocMd">📋 계획서 붙여넣기용 텍스트 복사 (개조식+표)</button>
          </div>
          <div class="alert ok">이 PoC 계획은 4단계 섹션 작성 프롬프트에 자동 포함되고, 문서 내보내기 시 "붙임. PoC 검증 계획"으로 첨부됩니다.</div>
        </div>`;
    }
    return `
      <h1 class="step-title">3. PoC 검증 설계</h1>
      <p class="step-desc">심사위원이 가장 싫어하는 문장은 "검증하겠습니다"(숫자·방법 없음)입니다. 가설 1개 → 환경·방법 → 지표(정의·단위·측정법·산출식) → 숫자 임계값(Go/No-Go) → Plan B 구조의 검증계획을 설계합니다.</p>
      ${p.planning && p.planning.raw ? '' : '<div class="alert warn">2단계 기획을 먼저 완료하면 PoC가 기획 수치와 일치하게 설계됩니다.</div>'}
      <div class="card"><h3>PoC 검증 설계</h3>${genBlock('poc', 'PoC 검증계획 자동 설계')}</div>
      ${canvas}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="plan">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="write">다음: 사업계획서 작성 →</button>
      </div>`;
  }

  function renderWrite(p) {
    const secs = getSections(p);
    if (!ui.activeSectionId || !secs.find((s) => s.id === ui.activeSectionId)) ui.activeSectionId = secs[0] && secs[0].id;
    const doneCount = secs.filter((s) => p.sections[s.id] && p.sections[s.id].content).length;
    const list = secs.map((s) => {
      const content = (p.sections[s.id] || {}).content || '';
      const done = !!content;
      const chars = content.replace(/\s/g, '').length ? content.length : 0;
      const short = s.minChars && chars && chars < s.minChars;
      const over = s.maxChars && chars > s.maxChars;
      const meta = [s.score ? '배점 ' + s.score : '', limitText(s)].filter(Boolean).join(' · ');
      return `<div class="section-item ${ui.activeSectionId === s.id ? 'active' : ''}" data-act="pickSection" data-sec="${s.id}">
        <span class="status ${done ? (short || over ? 'warn' : 'done') : 'todo'}">${done ? (short ? '분량 부족' : over ? '분량 초과' : '완료') : '미작성'}</span>
        <span>${esc2(s.title)}</span>
        <span class="meta">${esc2(meta || s.pages + 'p')}${done ? ' · ' + chars.toLocaleString() + '자' : ''}</span>
      </div>`;
    }).join('');
    const active = secs.find((s) => s.id === ui.activeSectionId);
    const cont = active && p.sections[active.id] && p.sections[active.id].content;
    const activeChars = cont ? cont.length : 0;
    const limitInfo = active ? limitText(active) : '';
    const charNote = active && (active.minChars || active.maxChars) && cont
      ? `<span class="${(active.minChars && activeChars < active.minChars) || (active.maxChars && activeChars > active.maxChars) ? 'warn-inline' : 'ok-inline'}">현재 ${activeChars.toLocaleString()}자</span>`
      : (cont ? `<span class="hint" style="display:inline">현재 ${activeChars.toLocaleString()}자</span>` : '');
    const tableReq = active && (active.tables || []).length
      ? `<p class="hint">📋 양식이 요구하는 표: ${(active.tables || []).map((t) => esc2(t.caption || '표') + ((t.columns || []).length ? ' (' + t.columns.map(esc2).join(' | ') + ')' : '')).join(' · ')}</p>`
      : '';
    const activePanel = active ? `
      <div class="card"><h3>✍ ${esc2(active.title)}</h3>
        ${active.source === 'form' ? '<div class="alert info" style="margin-top:0"><b>양식에 적힌 작성 안내문</b><br>' + esc2(active.guide || '(안내문 없음)').replace(/\n/g, '<br>') + '</div>' : `<p class="hint">${esc2(active.guide)}</p>`}
        <p class="hint">${esc2(limitInfo || '권장 약 ' + active.pages + '페이지')} ${charNote}</p>
        ${tableReq}
        ${genBlock('sec_' + active.id, '이 섹션 자동 작성', '섹션 본문을 붙여넣으세요 (□/○/- 개조식, 표는 마크다운)')}
        ${cont ? `<h3 style="margin-top:16px">저장된 본문</h3><div class="preview">${blocksToHtml(parseContent(cont))}</div>` : ''}
      </div>` : '';
    return `
      <h1 class="step-title">4. 사업계획서 작성</h1>
      <p class="step-desc">배점에 비례해 지면을 배분한 목차입니다. 섹션을 하나씩 작성하세요 — 각 프롬프트에는 확정 기획과 이미 쓴 섹션의 요지가 함께 들어가 문서 전체 일관성을 유지합니다.</p>
      <div class="card">
        <h3>진행 상황 ${doneCount}/${secs.length}</h3>
        <div class="progress-track"><div class="progress-fill" style="width:${secs.length ? Math.round(doneCount / secs.length * 100) : 0}%"></div></div>
        ${list}
        ${LLM.ready() ? `<div class="btn-row">
          ${ui.batch ? `<button class="btn secondary" data-act="stopGen">■ 전체 작성 중단 (${ui.batch.done}/${ui.batch.total})</button>`
            : `<button class="btn" data-act="autoAll">🚀 미작성 ${secs.length - doneCount}개 섹션 전부 자동 작성</button>`}
        </div>${ui.batch ? `<p class="hint">${esc2(ui.batch.label || '')}</p>` : '<p class="hint">앞 섹션부터 차례로 쓰며, 먼저 쓴 내용을 다음 섹션 프롬프트에 넣어 수치 일관성을 유지합니다.</p>'}` : ''}
      </div>
      ${activePanel}
      ${doneCount === secs.length && secs.length ? '<div class="alert ok">전 섹션 작성 완료. 5단계 모의심사로 검증하세요.</div>' : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="poc">← 이전</button>
        ${doneCount ? '<button class="btn secondary" data-act="openPreview">👀 사업계획서 미리보기</button>' : ''}
        <button class="btn big" data-act="goStep" data-step="review">다음: 모의심사 →</button>
      </div>`;
  }

  function renderReview(p) {
    return `
      <h1 class="step-title">5. 모의심사</h1>
      <p class="step-desc">제출 전, 심사위원 페르소나가 실제 심사처럼 채점합니다 — 섹션별 점수, 감점 요인 전수 점검, 문서 간 수치 불일치, 【확인】 마커 목록, 점수를 가장 올릴 수정 3가지.</p>
      <div class="card"><h3>모의심사 실행</h3>${genBlock('review', '모의심사 자동 실행', '심사 결과를 붙여넣으세요')}</div>
      ${p.review && p.review.content ? `<div class="card"><h3>심사 결과</h3><div class="review-out">${esc2(p.review.content)}</div></div>
      <div class="alert warn">지적된 사항을 3단계로 돌아가 수정한 뒤, 모의심사를 다시 돌리는 것을 권장합니다 (합격선 통과 판정까지 반복).</div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="write">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="deck">다음: IR Deck →</button>
      </div>`;
  }

  function renderDeck(p) {
    const deck = p.deck;
    const slides = deck && deck.slides ? deck.slides.map((s, i) => `
      <div class="slide-card">
        <h4>${i + 1}. ${esc2(s.title)}</h4>
        <ul>${(s.bullets || []).map((b) => '<li>' + esc2(b) + '</li>').join('')}</ul>
        ${s.visual ? `<div class="visual">🎨 ${esc2(s.visual)}</div>` : ''}
        ${s.script ? `<div class="script">🎤 ${esc2(s.script)}</div>` : ''}
      </div>`).join('') : '';
    return `
      <h1 class="step-title">6. IR Deck (대면평가 발표자료)</h1>
      <p class="step-desc">확정 사업계획서와 수치가 일치하는 발표자료를 설계합니다. 슬라이드당 메시지 1개, 발표 대본 포함.</p>
      <div class="card"><h3>IR Deck 설계</h3>${genBlock('deck', 'IR Deck 자동 설계')}</div>
      ${slides ? `<div class="card"><h3>${esc2(deck.title || '')} — ${deck.slides.length}장</h3>${slides}
        <div class="btn-row"><button class="btn big" data-act="exportPptx">⬇ PPTX 다운로드</button></div></div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="review">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="export">다음: 내보내기 →</button>
      </div>`;
  }

  function renderExport(p) {
    const secs = getSections(p);
    const doneCount = secs.filter((s) => p.sections[s.id] && p.sections[s.id].content).length;
    return `
      <h1 class="step-title">내보내기</h1>
      <p class="step-desc">사업계획서 ${doneCount}/${secs.length} 섹션 작성됨${p.poc ? ' · PoC 검증 계획 포함(붙임 첨부)' : ''}${p.deck ? ' · IR Deck ' + (p.deck.slides || []).length + '장 준비됨' : ''}</p>
      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn big" data-act="openPreview">👀 사업계획서 미리보기</button>
        <button class="btn secondary" data-act="exportHwpx">🇰🇷 한글 파일(.hwpx) 다운로드</button>
        <button class="btn secondary" data-act="exportDocx">📄 DOCX 다운로드</button>
      </div>
      <div class="export-grid">
        <div class="export-card"><h4>🇰🇷 한글 파일 (.hwpx)</h4><p>한컴오피스 한글 2014 이상에서 바로 열립니다. 열어서 <b>다른 이름으로 저장 → .hwp</b>로 바꾸면 제출용 한글 파일이 됩니다.</p>
          <button class="btn" data-act="exportHwpx">HWPX 다운로드</button></div>
        <div class="export-card"><h4>📄 DOCX (Word)</h4><p>맑은 고딕 · 개조식 · 표 포함. 한글에서도 열립니다. 가장 확실한 형식입니다.</p>
          <button class="btn" data-act="exportDocx">DOCX 다운로드</button></div>
        <div class="export-card"><h4>📑 PDF</h4><p>인쇄 대화상자가 열립니다. "PDF로 저장"을 선택하세요. 여기서 실제 페이지 수도 확인하세요.</p>
          <button class="btn" data-act="exportPdf">PDF 만들기</button></div>
        <div class="export-card"><h4>📊 PPTX (IR Deck)</h4><p>표지 + 슬라이드 + 발표 대본(발표자 노트). 16:9 와이드.</p>
          <button class="btn" data-act="exportPptx">PPTX 다운로드</button></div>
        <div class="export-card"><h4>📋 한글에 붙여넣기</h4><p>파일을 받지 않고, 열려 있는 한글 문서에 서식 그대로 붙여넣습니다.</p>
          <div class="btn-row">
            <button class="btn secondary" data-act="copyHwp">서식 복사 (한글에 붙여넣기)</button>
            <button class="btn secondary" data-act="hwpGuide">DOCX→HWP 변환 안내</button>
          </div></div>
        <div class="export-card"><h4>🗂 프로젝트 백업</h4><p>전체 프로젝트를 JSON으로 백업/복원합니다. localStorage가 지워져도 복구 가능.</p>
          <div class="btn-row">
            <button class="btn secondary" data-act="exportJson">백업 다운로드</button>
            <button class="btn secondary" data-act="importJson">백업 불러오기</button>
            <input type="file" id="importFile" accept=".json" style="display:none">
          </div></div>
        <div class="export-card"><h4>👀 전체 미리보기</h4><p>제출본 형태로 전체 문서를 크게 확인하고, 그 화면에서 바로 인쇄할 수 있습니다.</p>
          <button class="btn secondary" data-act="openPreview">미리보기 열기</button></div>
      </div>
      <div class="alert warn"><b>제출 전 체크리스트:</b> ① 실제 워드/한글에서 연 페이지 수가 제한 이내인지 (이 미리보기의 페이지 수는 근사치) ② 【확인】 마커가 모두 채워졌는지 ③ 요약-본문-Deck의 수치가 일치하는지 ④ 공고의 실격 조건(자격, 중복 수혜)에 걸리지 않는지</div>`;
  }

  /* ───────── 기획 파서 ───────── */

  function parsePlanning(raw) {
    if (!raw) return [];
    const titles = {
      P1: '문제 정의', P2: '솔루션', P3: '기술 차별성', P4: '시장', P5: '수익모델',
      P6: '매출 추정', P7: '로드맵', P8: '자금 계획', P9: '팀', P10: '리스크'
    };
    const out = [];
    const re = /\[(P\d{1,2})\]([^\n]*)\n?/g;
    let m; const marks = [];
    while ((m = re.exec(raw))) marks.push({ tag: m[1], head: m[2].trim(), start: m.index, end: re.lastIndex });
    marks.forEach((mk, i) => {
      const body = raw.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : raw.length).trim();
      out.push([mk.tag, mk.head.replace(/^[—\-–:\s]+/, '') || titles[mk.tag] || '', body]);
    });
    return out;
  }

  /* ───────── 액션 처리 ───────── */

  function buildPrompt(key) {
    const p = cur();
    if (key === 'form') {
      const raw = document.getElementById('formRaw');
      if (raw) { p.form.rawText = raw.value; save(); }
      if (!(p.form.rawText || '').trim()) { toast('양식 원문을 먼저 올리거나 붙여넣어 주세요.', 'warn'); return null; }
      return buildFormPrompt(p);
    }
    if (key === 'announce') {
      const raw = document.getElementById('annRaw');
      if (raw) { p.announcement.rawText = raw.value; save(); }
      if (!p.announcement.rawText.trim()) { toast('공고문 원문을 먼저 붙여넣거나 파일을 올려주세요.', 'warn'); return null; }
      return buildAnnouncementPrompt(p);
    }
    if (key === 'idea') {
      const dir = document.getElementById('ideaDirection');
      const direction = dir ? dir.value.trim() : '';
      if (ui.ideaMode === 'reframe') {
        const biz = document.getElementById('reframeBiz');
        if (biz) { p.reframeBiz = biz.value; save(); }
        if (!(p.reframeBiz || '').trim()) { toast('현재 사업 설명을 먼저 입력하세요.', 'warn'); return null; }
        return buildReframePrompt(p, p.reframeBiz.trim(), direction);
      }
      return buildIdeaPrompt(p, ui.ideaFields, direction);
    }
    if (key === 'poc') {
      if (!(p.selectedIdeaIndex >= 0 && p.ideas[p.selectedIdeaIndex])) { toast('1단계에서 아이템을 먼저 선정하세요.', 'warn'); return null; }
      return buildPocPrompt(p);
    }
    if (key === 'plan') {
      if (!(p.selectedIdeaIndex >= 0 && p.ideas[p.selectedIdeaIndex])) { toast('1단계에서 아이템을 먼저 선정하세요.', 'warn'); return null; }
      return buildPlanningPrompt(p);
    }
    if (key.startsWith('sec_')) {
      const sec = getSections(p).find((s) => s.id === key.slice(4));
      if (!sec) return null;
      if (!p.planning.raw) {
        toast('2단계 기획이 없어 문서 간 수치가 어긋나기 쉽습니다. 기획을 먼저 확정하는 편이 안전합니다.', 'warn');
      }
      return buildSectionPrompt(p, sec);
    }
    if (key === 'review') {
      const secs = getSections(p);
      if (!secs.some((s) => p.sections[s.id] && p.sections[s.id].content)) { toast('4단계에서 섹션을 먼저 작성하세요.', 'warn'); return null; }
      return buildReviewPrompt(p);
    }
    if (key === 'deck') {
      if (!Object.values(p.sections || {}).some((s) => s && s.content)) { toast('4단계 사업계획서를 먼저 작성하세요.', 'warn'); return null; }
      return buildDeckPrompt(p);
    }
    return null;
  }

  /** JSON을 못 찾았을 때, 무엇이 문제인지 짚어준다 */
  function explainJsonFailure(text, needLabel) {
    if (quietPaste) return;   // 자동 재시도가 뒤따르므로 사용자를 놀라게 하지 않는다
    if (looksLikePrompt(text)) {
      dialog({
        title: '프롬프트를 그대로 붙여넣으신 것 같습니다',
        message: '지금 붙여넣은 내용은 이 앱이 만들어 준 프롬프트입니다.\n\n' +
          '1) 위 프롬프트를 복사해서\n' +
          '2) Claude(claude.ai)에 붙여넣고\n' +
          '3) Claude가 답으로 준 JSON 코드블록을 여기에 붙여넣어 주세요.',
        okText: '알겠습니다', cancelText: '닫기'
      });
      return;
    }
    if (!/[{[]/.test(text)) {
      toast('JSON이 보이지 않습니다. Claude 답변의 JSON 코드블록을 통째로 복사해 붙여넣어 주세요.', 'error');
      return;
    }
    toast('JSON이 중간에서 잘린 것 같습니다. 맨 처음 여는 괄호부터 마지막 닫는 괄호까지 빠짐없이 복사해 주세요.' +
      (needLabel ? ' (' + needLabel + ' 항목이 있어야 합니다)' : ''), 'error', 11000);
  }

  function savePaste(key, text) {
    const p = cur();
    if (!text.trim()) { toast('붙여넣은 내용이 없습니다.', 'warn'); return false; }

    // 프롬프트를 그대로 되붙이면 자리표시자가 저장되므로 먼저 막는다
    if (looksLikePrompt(text)) { explainJsonFailure(text); return false; }

    if (key === 'form') {
      const json = extractJson(text, (v) => v && !Array.isArray(v) && Array.isArray(v.sections) && v.sections.length);
      if (!json || !Array.isArray(json.sections) || !json.sections.length) { explainJsonFailure(text, 'sections'); return false; }
      p.form.analysis = json;
      ui.activeSectionId = null;   // 목차가 바뀌므로 선택을 초기화한다
      toast(`양식 항목 ${json.sections.length}개를 인식했습니다. 4단계 작성 목차가 이 양식으로 바뀝니다.`, 'ok', 7000);
    } else if (key === 'announce') {
      const json = extractJson(text, (v) => v && !Array.isArray(v) && (v.sections || v.title || v.agency));
      if (!json || Array.isArray(json)) { explainJsonFailure(text, 'sections'); return false; }
      p.announcement.analysis = json;
      if (json.pageLimit && Number(json.pageLimit)) p.pageLimitOverride = Number(json.pageLimit);
    } else if (key === 'idea') {
      const pickIdeas = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.ideas) ? v.ideas : null));
      const json = extractJson(text, (v) => {
        const a = pickIdeas(v);
        return !!(a && a.length && a[0] && a[0].title);
      });
      const arr = pickIdeas(json);
      if (!arr || !arr.length) { explainJsonFailure(text, 'title'); return false; }
      p.ideas = arr;
      p.selectedIdeaIndex = -1;
    } else if (key === 'plan') {
      p.planning = { raw: text.trim() };
      if (!/\[P\d/.test(text)) toast('저장했습니다. 다만 [P1]~[P11] 태그가 없어 항목별로 정리되지 않습니다.', 'warn');
    } else if (key === 'poc') {
      const json = extractJson(text, (v) => v && !Array.isArray(v) && Array.isArray(v.metrics) && v.metrics.length);
      if (!json || Array.isArray(json)) { explainJsonFailure(text, 'metrics'); return false; }
      if (!Array.isArray(json.metrics) || !json.metrics.length) {
        toast('JSON은 찾았지만 지표(metrics) 항목이 비어 있습니다. Claude에게 metrics 배열을 채워 다시 출력해 달라고 요청해 보세요.', 'error', 11000);
        return false;
      }
      p.poc = json;
    } else if (key.startsWith('sec_')) {
      p.sections[key.slice(4)] = { content: text.trim(), updatedAt: Date.now() };
    } else if (key === 'review') {
      p.review = { content: text.trim(), at: Date.now() };
    } else if (key === 'deck') {
      const json = extractJson(text, (v) => v && Array.isArray(v.slides) && v.slides.length);
      if (!json || !Array.isArray(json.slides) || !json.slides.length) { explainJsonFailure(text, 'slides'); return false; }
      p.deck = json;
    }
    save();
    render();
    return true;
  }

  /* ───────── 자동 생성 실행 ───────── */

  function tokensFor(key) {
    if (key.indexOf('sec_') === 0) return 20000;
    return ({ plan: 20000, review: 16000, deck: 16000, form: 12000, announce: 12000, idea: 12000, poc: 12000 })[key] || 12000;
  }

  const RETRY_SUFFIX = '\n\n[재요청] 직전 출력이 지정 형식과 달라 앱이 읽지 못했습니다. ' +
    '이번에는 인사말·설명·맺음말 없이 지정된 형식(JSON이면 코드블록 하나)만, 중간에 잘리지 않게 끝까지 출력하세요.';

  let quietPaste = false;   // 자동 재시도 중에는 파싱 실패 안내를 띄우지 않는다

  function streamInto(key, prompt) {
    ui.run = { key, text: '', status: 'running', thinking: false, error: '' };
    ui.abort = new AbortController();
    render();
    return LLM.stream({
      prompt,
      maxTokens: tokensFor(key),
      signal: ui.abort.signal,
      onToken: (chunk, full) => {
        if (!ui.run || ui.run.key !== key) return;
        ui.run.text = full;
        const el = document.getElementById('stream_' + key);
        if (el) { el.textContent = full; el.scrollTop = el.scrollHeight; }
      },
      onThinking: (thinking) => {
        if (!ui.run || ui.run.key !== key) return;
        ui.run.thinking = thinking;
        const h = document.getElementById('streamhead_' + key);
        if (h) h.textContent = thinking ? '🧠 심사 기준에 맞춰 구상하는 중…' : '✍️ 작성 중…';
      }
    });
  }

  /** 프롬프트 생성 → 호출 → 검증·저장까지 한 번에. 형식이 어긋나면 한 번 자동 재시도한다. */
  async function autoGen(key, opts) {
    const o = opts || {};
    const prompt = o.prompt || buildPrompt(key);
    if (!prompt) return false;
    ui.prompts[key] = o.prompt ? prompt : ui.prompts[key] || prompt;

    let text;
    try {
      text = await streamInto(key, prompt);
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      if (ui.run && ui.run.key === key) {
        ui.run.status = 'error';
        ui.run.error = aborted ? '중단했습니다.' : (e.message || String(e));
      }
      render();
      if (!aborted) toast(e.message || '자동 생성에 실패했습니다.', 'error', 15000);
      return false;
    }

    if (ui.run && ui.run.key === key) ui.run.status = 'done';
    quietPaste = !o.retried;
    const ok = savePaste(key, text);
    quietPaste = false;
    if (ok) { ui.run = null; render(); return true; }
    if (!o.retried) return autoGen(key, { prompt: prompt + RETRY_SUFFIX, retried: true });

    if (ui.run && ui.run.key === key) {
      ui.run.status = 'error';
      ui.run.error = '두 번 시도했지만 응답 형식이 맞지 않아 자동 저장하지 못했습니다. ' +
        '아래 “이 결과 그대로 저장”을 누르거나, 다시 생성해 보세요.';
    }
    render();
    return false;
  }

  /** 4단계 — 미작성 섹션을 앞에서부터 차례로 전부 작성한다 */
  async function autoAllSections() {
    const p = cur();
    const todo = getSections(p).filter((s) => !((p.sections[s.id] || {}).content));
    if (!todo.length) { toast('이미 모든 섹션이 작성되어 있습니다.', 'info'); return; }
    ui.batch = { total: todo.length, done: 0, label: '' };
    for (let i = 0; i < todo.length; i++) {
      if (!ui.batch) break;
      const sec = todo[i];
      ui.activeSectionId = sec.id;
      ui.batch.label = `(${ui.batch.done + 1}/${ui.batch.total}) ${sec.title} 작성 중…`;
      const ok = await autoGen('sec_' + sec.id);
      if (!ui.batch) break;
      if (!ok) { toast(`"${sec.title}"에서 멈췄습니다. 확인 후 이어서 진행해 주세요.`, 'warn', 9000); break; }
      ui.batch.done++;
    }
    const done = ui.batch ? ui.batch.done : 0;
    ui.batch = null;
    render();
    if (done) toast(`${done}개 섹션을 자동 작성했습니다.`, 'ok', 6000);
  }

  function stopGen() {
    ui.batch = null;
    if (ui.abort) { try { ui.abort.abort(); } catch (e) { /* 무시 */ } }
  }

  function saveLlmSettings() {
    const keyEl = document.getElementById('llmKey');
    const modelEl = document.getElementById('llmModel');
    const apiKey = keyEl ? keyEl.value.trim() : '';
    const model = modelEl ? modelEl.value : LLM.get().model;
    if (!apiKey) { toast('API 키를 입력해 주세요. console.anthropic.com → API Keys에서 발급합니다.', 'warn'); return; }
    LLM.set({ apiKey, model });
    toast('연결을 확인하는 중…', 'info', 2500);
    LLM.test(apiKey, model).then(() => {
      render();
      toast('연결됐습니다. 이제 각 단계의 🤖 버튼만 누르면 됩니다.', 'ok', 6000);
    }).catch((e) => {
      render();
      toast(e.message || '연결에 실패했습니다.', 'error', 15000);
    });
  }

  function handleAction(el) {
    const act = el.getAttribute('data-act');
    const p = cur();
    switch (act) {
      case 'goStep': ui.step = el.getAttribute('data-step'); render(); break;
      case 'pickType': p.programType = el.getAttribute('data-type'); save(); render(); break;
      case 'toggleField': {
        const f = el.getAttribute('data-field');
        const i = ui.ideaFields.indexOf(f);
        if (i >= 0) ui.ideaFields.splice(i, 1); else ui.ideaFields.push(f);
        render(); break;
      }
      case 'pickIdea': p.selectedIdeaIndex = Number(el.getAttribute('data-idx')); save(); render(); break;
      case 'ideaMode': ui.ideaMode = el.getAttribute('data-mode'); render(); break;
      case 'copyPocMd':
        if (p.poc) {
          copyText(pocToMarkdown(p.poc)).then((ok) => {
            if (ok) { flash(el, '✓ 복사됨'); toast('PoC 계획을 복사했습니다.', 'ok'); }
            else toast('복사가 차단되었습니다. 아래 캔버스의 표를 직접 선택해 복사해 주세요.', 'error');
          });
        }
        break;
      case 'pickSection': ui.activeSectionId = el.getAttribute('data-sec'); render(); break;
      case 'genPrompt': {
        const key = el.getAttribute('data-key');
        const prompt = buildPrompt(key);
        if (prompt) { ui.prompts[key] = prompt; render(); }
        break;
      }
      case 'copyPrompt': {
        const key = el.getAttribute('data-key');
        copyText(ui.prompts[key] || '').then((ok) => {
          if (ok) { el.textContent = '✓ 복사됨'; toast('프롬프트를 복사했습니다. Claude에 붙여넣으세요.', 'ok'); setTimeout(render, 1200); }
          else {
            const ta = document.getElementById('prompt_' + key);
            if (ta) { ta.focus(); ta.select(); }
            toast('복사가 차단되었습니다. 프롬프트 전체를 선택해 두었으니 Ctrl+C(Mac은 ⌘C)로 복사해 주세요.', 'error');
          }
        });
        break;
      }
      case 'autoGen': autoGen(el.getAttribute('data-key')); break;
      case 'autoAll': autoAllSections(); break;
      case 'stopGen': stopGen(); break;
      case 'useRun': {
        const key = el.getAttribute('data-key');
        if (ui.run && ui.run.key === key && ui.run.text) {
          if (savePaste(key, ui.run.text)) { ui.run = null; render(); toast('저장했습니다.', 'ok'); }
        }
        break;
      }
      case 'copyRun': {
        const text = ui.run ? ui.run.text : '';
        copyText(text).then((ok) => { if (ok) flash(el, '✓ 복사됨'); else toast('복사가 차단되었습니다. 결과를 직접 선택해 복사해 주세요.', 'error'); });
        break;
      }
      case 'saveLlm': saveLlmSettings(); break;
      case 'saveSelf': {
        try {
          // API 키가 화면에 그려져 있으므로, 본문을 비운 사본을 저장한다
          const clone = document.documentElement.cloneNode(true);
          const main = clone.querySelector('#main');
          if (main) main.innerHTML = '';
          Array.prototype.forEach.call(clone.querySelectorAll('#toastBox, .modal-back'), (n) => n.remove());
          const html = '<!doctype html>\n' + clone.outerHTML;
          downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), '딥테크-사업계획서-생성기.html');
          toast('앱을 파일로 저장했습니다. 그 파일을 브라우저로 열면 자동 생성까지 동작합니다.', 'ok', 9000);
        } catch (e) { toast('파일 저장에 실패했습니다: ' + e.message, 'error'); }
        break;
      }
      case 'toggleKeyView': {
        const k = document.getElementById('llmKey');
        if (k) k.type = k.type === 'password' ? 'text' : 'password';
        break;
      }
      case 'clearLlm':
        confirmDialog('저장된 API 키를 이 브라우저에서 지웁니다.', { title: 'API 키 삭제', okText: '삭제', danger: true })
          .then((ok) => { if (ok) { LLM.clear(); render(); toast('API 키를 삭제했습니다. 수동 모드로 계속 쓸 수 있습니다.', 'ok'); } });
        break;
      case 'savePaste': {
        const key = el.getAttribute('data-key');
        const ta = document.getElementById('paste_' + key);
        savePaste(key, ta ? ta.value : '');
        break;
      }
      case 'saveAnnRaw': {
        const ta = document.getElementById('annRaw');
        if (ta) { p.announcement.rawText = ta.value; save(); flash(el, '저장됨 ✓'); }
        break;
      }
      case 'clearRaw': {
        const slot = el.getAttribute('data-target') === 'form' ? 'form' : 'announcement';
        const label = slot === 'form' ? '양식' : '공고문';
        confirmDialog(`${label} 원문과 파일 목록, 분석 결과를 모두 비웁니다.`,
          { title: label + ' 비우기', okText: '비우기', danger: true }).then((ok) => {
          if (!ok) return;
          p[slot] = { rawText: '', analysis: null, files: [] };
          ui.activeSectionId = null;
          save(); render();
          toast(label + '을 비웠습니다.', 'ok');
        });
        break;
      }
      case 'pickFiles': {
        const input = document.getElementById(el.getAttribute('data-target') === 'form' ? 'formFiles' : 'annFiles');
        if (input) input.click();
        break;
      }
      case 'exportDocx':
        exportDocx(p).then(() => toast('DOCX를 내려받았습니다.', 'ok'))
          .catch((e) => toast('DOCX 생성 실패: ' + e.message, 'error'));
        break;
      case 'exportPdf': {
        const how = exportPdf(p);
        if (how === 'window') toast('새 창에서 인쇄 대화상자를 엽니다. "PDF로 저장"을 선택하세요.', 'ok', 6000);
        else if (how === 'iframe') toast('인쇄 대화상자를 엽니다. 열리지 않으면 DOCX를 내려받아 워드에서 PDF로 저장해 주세요.', 'warn', 8000);
        else toast('이 환경에서는 인쇄가 막혀 있습니다. DOCX를 내려받아 워드나 한글에서 PDF로 저장해 주세요.', 'error');
        break;
      }
      case 'exportPptx':
        if (exportPptx(p)) toast('PPTX를 내려받았습니다.', 'ok');
        else toast('IR Deck 데이터가 없습니다. 6단계에서 Deck 결과를 먼저 저장해 주세요.', 'warn');
        break;
      case 'exportJson': exportProjectJson(p); toast('프로젝트 백업을 내려받았습니다.', 'ok'); break;
      case 'importJson': document.getElementById('importFile').click(); break;
      case 'copyHwp':
        copyHwpHtml(p).then((ok) => {
          if (ok) toast('서식 있는 본문을 복사했습니다. 한글(HWP)을 열고 붙여넣기(Ctrl+V) 하세요.', 'ok', 6000);
          else toast('복사가 차단되었습니다. DOCX를 내려받아 한글에서 여는 방법을 이용해 주세요.', 'error');
        });
        break;
      case 'hwpGuide':
        dialog({
          title: 'DOCX를 HWP로 바꾸는 방법',
          message: '1) 이 화면에서 DOCX를 내려받습니다.\n' +
                   '2) 한컴오피스 한글(2014 이상)에서 그 DOCX 파일을 그대로 엽니다.\n' +
                   '3) 다른 이름으로 저장 → 파일 형식을 "한글 문서(*.hwp)"로 선택합니다.\n\n' +
                   '개조식 계층과 표 서식이 유지됩니다.',
          okText: '알겠습니다', cancelText: '닫기'
        });
        break;
      case 'openPreview': openPreview(p); break;
      case 'exportHwpx':
        try {
          exportHwpx(p);
          toast('한글 파일(.hwpx)을 내려받았습니다. 한글에서 열고 "다른 이름으로 저장 → .hwp"로 바꾸면 제출용이 됩니다.', 'ok', 9000);
        } catch (e) {
          toast('한글 파일 생성 실패: ' + e.message + ' — DOCX를 이용해 주세요.', 'error');
        }
        break;
    }
  }

  /* ───────── 공고문 파일 처리 ───────── */

  let parsing = false;

  /** 올린 파일들의 텍스트를 뽑아 해당 원문 칸에 이어 붙인다 (target: announcement | form) */
  async function handleUploadedFiles(fileList, target) {
    const files = Array.from(fileList || []);
    if (!files.length || parsing) return;
    const p = cur();
    const slot = target === 'form' ? 'form' : 'announcement';
    if (!p[slot]) p[slot] = { rawText: '', analysis: null, files: [] };
    if (!p[slot].files) p[slot].files = [];
    const taId = slot === 'form' ? 'formRaw' : 'annRaw';

    // 사용자가 직접 입력 중이던 내용을 잃지 않도록 먼저 반영한다
    const ta = document.getElementById(taId);
    if (ta) p[slot].rawText = ta.value;

    parsing = true;
    const status = document.getElementById(slot === 'form' ? 'formParseStatus' : 'parseStatus');
    const setStatus = (msg) => { if (status) status.textContent = msg; };

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
      setStatus(`${prefix}${f.name} 읽는 중…`);

      let result;
      try {
        result = await extractText(f, (page, total) => {
          setStatus(`${prefix}${f.name} 읽는 중… ${page}/${total}쪽`);
        });
      } catch (e) {
        result = { name: f.name, kind: '?', text: '', error: e.message || String(e) };
      }

      // 같은 파일을 다시 올리면 덧붙이지 않고 갈아끼운다
      const dupe = p[slot].files.findIndex((x) => x.name === result.name);
      const entry = {
        name: result.name, kind: result.kind, chars: result.text.length,
        warning: result.warning || null, error: result.error || null
      };
      const header = `──────── ${result.name} (${result.kind}) ────────`;
      if (dupe >= 0) {
        p[slot].files[dupe] = entry;
        // 이전에 넣은 같은 파일의 본문을 잘라내고 새 것으로 바꾼다
        const start = p[slot].rawText.indexOf(header);
        if (start >= 0) {
          const nextIdx = p[slot].rawText.indexOf('\n────────', start + header.length);
          const end = nextIdx >= 0 ? nextIdx : p[slot].rawText.length;
          p[slot].rawText = (p[slot].rawText.slice(0, start) + p[slot].rawText.slice(end)).trim();
        }
      } else {
        p[slot].files.push(entry);
      }

      if (result.text) {
        p[slot].rawText = (p[slot].rawText ? p[slot].rawText.trimEnd() + '\n\n' : '') +
          header + '\n' + result.text;
      }
      save();
    }

    parsing = false;
    const ok = p[slot].files.filter((x) => !x.error).length;
    setStatus('');
    render();
    const failed = p[slot].files.filter((x) => x.error);
    if (failed.length && ok === 0) {
      dialog({
        title: '파일에서 텍스트를 읽지 못했습니다',
        message: failed.map((f) => `· ${f.name}: ${f.error}`).join('\n') +
          '\n\n한글이나 워드에서 파일을 열어 다른 이름으로 다시 저장한 뒤 올리거나,\n본문을 복사해 아래 원문 칸에 직접 붙여넣어 주세요.',
        okText: '알겠습니다', cancelText: '닫기'
      });
    }
  }

  function flash(el, text) {
    const orig = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = orig; }, 1200);
  }

  /* ───────── 최상위 렌더 ───────── */

  const RENDERERS = {
    setup: renderSetup, announce: renderAnnounce, idea: renderIdea, plan: renderPlan,
    poc: renderPoc, write: renderWrite, review: renderReview, deck: renderDeck, export: renderExport
  };

  function render() {
    const p = cur();
    // 사이드바
    document.getElementById('stepList').innerHTML = STEPS.map((s) => `
      <div class="step-item ${ui.step === s.id ? 'active' : ''} ${stepDone(s.id) ? 'done' : ''}" data-act="goStep" data-step="${s.id}">
        <span class="num">${stepDone(s.id) && ui.step !== s.id ? '✓' : s.num}</span><span>${s.label}</span>
      </div>`).join('');
    // 프로젝트 셀렉터
    const sel = document.getElementById('projectSelect');
    sel.innerHTML = Object.values(state.projects)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((pr) => `<option value="${pr.id}" ${pr.id === state.currentId ? 'selected' : ''}>${esc2(pr.name)}</option>`).join('');
    // 본문 (저장소가 막힌 환경에서는 모든 단계 위에 경고를 띄운다)
    const banner = storageBlocked
      ? '<div class="alert warn"><b>브라우저 저장소가 막혀 있습니다.</b> 새로고침하면 작업 내용이 사라집니다. ' +
        '<b>내보내기 → 프로젝트 백업</b>으로 수시로 파일에 저장하거나, 이 도구를 파일로 내려받아 여세요.</div>'
      : '';
    document.getElementById('main').innerHTML = banner + (RENDERERS[ui.step] || renderSetup)(p);
  }

  /* ───────── 이벤트 바인딩 ───────── */

  function init() {
    load();

    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el) handleAction(el);
    });

    document.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'projName') { cur().name = t.value; save(); }
      if (t.hasAttribute && t.hasAttribute('data-company')) {
        cur().company[t.getAttribute('data-company')] = t.value; save();
      }
      if (t.id === 'annRaw') { cur().announcement.rawText = t.value; save(); }
      if (t.id === 'formRaw') { cur().form.rawText = t.value; save(); }
      if (t.id === 'reframeBiz') { cur().reframeBiz = t.value; save(); }
    });

    document.getElementById('projectSelect').addEventListener('change', (e) => {
      state.currentId = e.target.value;
      ui.step = 'setup'; ui.prompts = {}; ui.activeSectionId = null;
      ui.run = null; ui.batch = null;
      save(); render();
    });

    document.getElementById('btnNewProject').addEventListener('click', () => {
      promptDialog('새 프로젝트 이름', '새 프로젝트', { okText: '만들기' }).then((name) => {
        if (name === null) return;
        newProject(name);
        ui.step = 'setup'; ui.prompts = {}; ui.activeSectionId = null;
      ui.run = null; ui.batch = null;
        save(); render();
        toast('새 프로젝트를 만들었습니다.', 'ok');
      });
    });

    document.getElementById('btnDeleteProject').addEventListener('click', () => {
      const p = cur();
      confirmDialog(`"${p.name}" 프로젝트를 삭제합니다. 되돌릴 수 없습니다.
백업이 필요하면 먼저 내보내기 → 프로젝트 백업을 이용하세요.`,
        { title: '프로젝트 삭제', okText: '삭제', danger: true }).then((ok) => {
        if (!ok) return;
        delete state.projects[state.currentId];
        state.currentId = Object.keys(state.projects)[0] || null;
        if (!state.currentId) newProject('내 첫 프로젝트');
        ui.step = 'setup'; ui.prompts = {}; ui.activeSectionId = null;
      ui.run = null; ui.batch = null;
        save(); render();
        toast('프로젝트를 삭제했습니다.', 'ok');
      });
    });

    // 공고문 파일: 선택 및 끌어다 놓기
    document.body.addEventListener('change', (e) => {
      if (e.target.id === 'annFiles' || e.target.id === 'formFiles') {
        handleUploadedFiles(e.target.files, e.target.id === 'formFiles' ? 'form' : 'announcement');
        e.target.value = '';
      }
    });

    document.body.addEventListener('dragover', (e) => {
      const zone = e.target.closest && e.target.closest('.drop-zone');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('over');
    });

    document.body.addEventListener('dragleave', (e) => {
      const zone = e.target.closest && e.target.closest('.drop-zone');
      if (zone) zone.classList.remove('over');
    });

    document.body.addEventListener('drop', (e) => {
      const zone = e.target.closest && e.target.closest('.drop-zone');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('over');
      handleUploadedFiles(e.dataTransfer.files, zone.getAttribute('data-target') || 'announcement');
    });

    document.body.addEventListener('change', (e) => {
      if (e.target.id === 'importFile') {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const proj = JSON.parse(reader.result);
            if (!proj || !proj.programType) throw new Error('형식이 다릅니다');
            proj.id = 'p' + Date.now().toString(36);
            proj.name = (proj.name || '가져온 프로젝트') + ' (복원)';
            state.projects[proj.id] = proj;
            state.currentId = proj.id;
            save(); render();
            toast('백업을 불러왔습니다: ' + proj.name, 'ok');
          } catch (err) { toast('백업 파일을 읽을 수 없습니다: ' + err.message, 'error'); }
        };
        reader.readAsText(file);
        e.target.value = '';
      }
    });

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
