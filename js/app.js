/**
 * 앱 본체 — 단계별 위저드, 프로젝트 상태(localStorage), 프롬프트 복사/응답 파싱.
 */
(function () {
  'use strict';

  const LS_KEY = 'gfp_projects_v1';

  const STEPS = [
    { id: 'setup', label: '설정 · 사업 유형', num: '⚙' },
    { id: 'announce', label: '공고문 분석', num: '0' },
    { id: 'idea', label: '딥테크 아이템 발굴', num: '1' },
    { id: 'plan', label: '사업 기획 (PSST)', num: '2' },
    { id: 'write', label: '사업계획서 작성', num: '3' },
    { id: 'review', label: '모의심사', num: '4' },
    { id: 'deck', label: 'IR Deck', num: '5' },
    { id: 'export', label: '내보내기', num: '📦' }
  ];

  let state = { projects: {}, currentId: null };
  const ui = { step: 'setup', activeSectionId: null, ideaFields: ['ai'], prompts: {} };

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
  function save() {
    const p = cur();
    if (p) p.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      flashSave();
    }, 250);
  }

  function flashSave() {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    el.textContent = '저장됨 ✓';
    setTimeout(() => { el.textContent = ''; }, 1500);
  }

  function cur() { return state.projects[state.currentId]; }

  function newProject(name) {
    const id = 'p' + Date.now().toString(36);
    state.projects[id] = {
      id, name: name || '새 프로젝트', createdAt: Date.now(), updatedAt: Date.now(),
      programType: 'package',
      company: {}, announcement: { rawText: '', analysis: null },
      ideas: [], selectedIdeaIndex: -1,
      planning: { raw: '' }, sections: {}, review: { content: '' }, deck: null
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
      case 'announce': return !!(p.announcement && p.announcement.analysis);
      case 'idea': return p.selectedIdeaIndex >= 0 && !!(p.ideas || [])[p.selectedIdeaIndex];
      case 'plan': return !!(p.planning && p.planning.raw);
      case 'write': {
        const secs = getSections(p);
        return secs.length > 0 && secs.every((s) => p.sections[s.id] && p.sections[s.id].content);
      }
      case 'review': return !!(p.review && p.review.content);
      case 'deck': return !!(p.deck && p.deck.slides && p.deck.slides.length);
      default: return false;
    }
  }

  /* ───────── 공용 렌더 헬퍼 ───────── */

  function esc2(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function promptBlock(key, generateFn, buttonLabel) {
    const val = ui.prompts[key] || '';
    return `
      <div class="btn-row">
        <button class="btn" data-act="genPrompt" data-key="${key}">🪄 ${buttonLabel || '프롬프트 생성'}</button>
        ${val ? `<button class="btn secondary" data-act="copyPrompt" data-key="${key}">📋 복사</button>` : ''}
      </div>
      ${val ? `<textarea class="prompt-out" id="prompt_${key}" readonly>${esc2(val)}</textarea>
      <p class="hint">위 프롬프트를 복사해 Claude(claude.ai 등)에 붙여넣고, 응답 전체를 아래에 붙여넣으세요.</p>` : ''}`;
  }

  function pasteBlock(key, placeholder) {
    return `
      <textarea id="paste_${key}" placeholder="${esc2(placeholder || 'Claude 응답을 여기에 붙여넣기')}"></textarea>
      <div class="btn-row"><button class="btn" data-act="savePaste" data-key="${key}">💾 응답 저장 · 파싱</button></div>`;
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
      <div class="alert info">이 도구는 API 키 없이 동작합니다. 각 단계에서 <b>프롬프트 생성 → Claude에 붙여넣기 → 응답을 앱에 되붙이기</b> 흐름으로 진행되며, 모든 데이터는 이 브라우저의 localStorage에만 저장됩니다.</div>
      <div class="btn-row"><button class="btn big" data-act="goStep" data-step="announce">다음: 공고문 분석 →</button></div>`;
  }

  function renderAnnounce(p) {
    const a = p.announcement || {};
    const an = a.analysis;
    let result = '';
    if (an) {
      const secRows = (an.sections || []).map((s) => `<tr><td>${esc2(s.title)}</td><td>${esc2(s.score == null ? '-' : s.score)}</td><td>${esc2(s.pages == null ? '-' : s.pages)}</td><td>${esc2(s.guide || '')}</td></tr>`).join('');
      result = `
        <div class="card"><h3>분석 결과</h3>
          <div class="preview">
            <p><b>${esc2(an.title || '(공고명 미확인)')}</b> — ${esc2(an.agency || '')}</p>
            <p>마감: ${esc2(an.deadline || '-')} · 페이지 제한: ${esc2(an.pageLimit || '-')} · 지원 규모: ${esc2(an.budget || '-')}</p>
            <p>심사 기준: ${esc2(an.evaluationCriteria || '-')}</p>
            ${(an.keywords || []).map((k) => `<span class="pill">${esc2(k)}</span>`).join('')}
            ${secRows ? `<table><tr><th>목차 (공고 원문 그대로)</th><th>배점</th><th>권장 p</th><th>심사위원 확인 포인트</th></tr>${secRows}</table>` : ''}
            ${(an.redFlags || []).length ? `<p><b>⚠ 실격/감점 조건:</b> ${an.redFlags.map(esc2).join(' · ')}</p>` : ''}
            ${an.fitAdvice ? `<p><b>프레이밍 조언:</b> ${esc2(an.fitAdvice)}</p>` : ''}
          </div>
          ${(an.sections || []).length ? '<div class="alert ok">이 목차가 3단계 사업계획서 작성의 목차로 자동 적용됩니다 (공고 양식 우선 원칙).</div>' : ''}
        </div>`;
    }
    return `
      <h1 class="step-title">0. 공고문 분석 <span class="hint" style="display:inline">(선택 단계 — 타겟 공고가 있으면 강력 추천)</span></h1>
      <p class="step-desc">공고문의 실제 양식 목차를 추출합니다. 양식을 추측해서 쓰는 것이 가장 흔한 탈락 사유입니다. 공고문(HWP/PDF)의 텍스트를 전체 복사해 붙여넣으세요.</p>
      <div class="card"><h3>공고문 원문 붙여넣기</h3>
        <textarea id="annRaw" placeholder="공고문 텍스트 전체를 붙여넣으세요 (요약표만 말고, 제출 양식 목차가 포함된 본문까지)">${esc2(a.rawText || '')}</textarea>
        <div class="btn-row"><button class="btn secondary" data-act="saveAnnRaw">원문 저장</button></div>
        ${promptBlock('announce', null, '공고 분석 프롬프트 생성')}
      </div>
      <div class="card"><h3>Claude 응답 (JSON)</h3>${pasteBlock('announce')}</div>
      ${result}
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
        <div class="row"><dt>기술 장벽</dt><dd>${esc2(idea.tech)}</dd></div>
        <div class="row"><dt>문제</dt><dd>${esc2(idea.problem)}</dd></div>
        <div class="row"><dt>지불 주체</dt><dd>${esc2(idea.customer)}</dd></div>
        <div class="row"><dt>차별성</dt><dd>${esc2(idea.moat)}</dd></div>
        <div class="row"><dt>정책 연계</dt><dd>${esc2(idea.policyFit)} · TRL ${esc2(idea.trl)}</dd></div>
        <div class="row"><dt>리스크</dt><dd>${esc2(idea.risk)}</dd></div>
      </div>`).join('');
    return `
      <h1 class="step-title">1. 딥테크 아이템 발굴</h1>
      <p class="step-desc">심사위원이 "이건 붙는다"고 판단하는 조건(기술 장벽 실재, 지불 주체 명확, 정책 연계, 소규모 팀 검증 가능)으로 아이템 5개를 생성합니다.</p>
      <div class="card"><h3>탐색 분야 선택 (복수 가능)</h3><div class="field-grid">${chips}</div>
        <div style="margin-top:12px"><label class="hint">추가 방향성 (선택)</label>
        <input type="text" id="ideaDirection" placeholder="예: 제조업 현장 적용 가능한 것, 하드웨어 없이 소프트웨어만으로 가능한 것"></div>
        ${promptBlock('idea', null, '아이템 발굴 프롬프트 생성')}
      </div>
      <div class="card"><h3>Claude 응답 (JSON 배열)</h3>${pasteBlock('idea')}</div>
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
      <div class="card"><h3>기획 프롬프트</h3>${promptBlock('plan', null, 'PSST 기획 프롬프트 생성')}</div>
      <div class="card"><h3>Claude 응답 ([P1]~[P10] 태그 포함 개조식)</h3>${pasteBlock('plan')}</div>
      ${view ? `<div class="card"><h3>확정된 기획</h3>${view}</div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="idea">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="write">다음: 사업계획서 작성 →</button>
      </div>`;
  }

  function renderWrite(p) {
    const secs = getSections(p);
    if (!ui.activeSectionId || !secs.find((s) => s.id === ui.activeSectionId)) ui.activeSectionId = secs[0] && secs[0].id;
    const doneCount = secs.filter((s) => p.sections[s.id] && p.sections[s.id].content).length;
    const list = secs.map((s) => {
      const done = p.sections[s.id] && p.sections[s.id].content;
      return `<div class="section-item ${ui.activeSectionId === s.id ? 'active' : ''}" data-act="pickSection" data-sec="${s.id}">
        <span class="status ${done ? 'done' : 'todo'}">${done ? '완료' : '미작성'}</span>
        <span>${esc2(s.title)}</span>
        <span class="meta">${s.score ? '배점 ' + s.score : ''} · ${s.pages}p</span>
      </div>`;
    }).join('');
    const active = secs.find((s) => s.id === ui.activeSectionId);
    const cont = active && p.sections[active.id] && p.sections[active.id].content;
    const activePanel = active ? `
      <div class="card"><h3>✍ ${esc2(active.title)}</h3>
        <p class="hint">${esc2(active.guide)} (권장 약 ${active.pages}p)</p>
        ${promptBlock('sec_' + active.id, null, '이 섹션 작성 프롬프트 생성')}
        <h3 style="margin-top:16px">Claude 응답 (개조식 본문)</h3>
        ${pasteBlock('sec_' + active.id, '섹션 본문을 붙여넣으세요 (□/○/- 개조식, 표는 마크다운)')}
        ${cont ? `<h3>미리보기</h3><div class="preview">${blocksToHtml(parseContent(cont))}</div>` : ''}
      </div>` : '';
    return `
      <h1 class="step-title">3. 사업계획서 작성</h1>
      <p class="step-desc">배점에 비례해 지면을 배분한 목차입니다. 섹션을 하나씩 작성하세요 — 각 프롬프트에는 확정 기획과 이미 쓴 섹션의 요지가 함께 들어가 문서 전체 일관성을 유지합니다.</p>
      <div class="card">
        <h3>진행 상황 ${doneCount}/${secs.length}</h3>
        <div class="progress-track"><div class="progress-fill" style="width:${secs.length ? Math.round(doneCount / secs.length * 100) : 0}%"></div></div>
        ${list}
      </div>
      ${activePanel}
      ${doneCount === secs.length && secs.length ? '<div class="alert ok">전 섹션 작성 완료. 4단계 모의심사로 검증하세요.</div>' : ''}
      <div class="btn-row">
        <button class="btn secondary" data-act="goStep" data-step="plan">← 이전</button>
        <button class="btn big" data-act="goStep" data-step="review">다음: 모의심사 →</button>
      </div>`;
  }

  function renderReview(p) {
    return `
      <h1 class="step-title">4. 모의심사</h1>
      <p class="step-desc">제출 전, 심사위원 페르소나가 실제 심사처럼 채점합니다 — 섹션별 점수, 감점 요인 전수 점검, 문서 간 수치 불일치, 【확인】 마커 목록, 점수를 가장 올릴 수정 3가지.</p>
      <div class="card"><h3>모의심사 프롬프트</h3>${promptBlock('review', null, '모의심사 프롬프트 생성')}</div>
      <div class="card"><h3>심사 결과 붙여넣기</h3>${pasteBlock('review')}</div>
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
      <h1 class="step-title">5. IR Deck (대면평가 발표자료)</h1>
      <p class="step-desc">확정 사업계획서와 수치가 일치하는 발표자료를 설계합니다. 슬라이드당 메시지 1개, 발표 대본 포함.</p>
      <div class="card"><h3>Deck 설계 프롬프트</h3>${promptBlock('deck', null, 'IR Deck 프롬프트 생성')}</div>
      <div class="card"><h3>Claude 응답 (JSON)</h3>${pasteBlock('deck')}</div>
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
      <p class="step-desc">사업계획서 ${doneCount}/${secs.length} 섹션 작성됨${p.deck ? ' · IR Deck ' + (p.deck.slides || []).length + '장 준비됨' : ''}</p>
      <div class="export-grid">
        <div class="export-card"><h4>📄 DOCX (Word)</h4><p>맑은 고딕 · 개조식 · 표 포함. 제출 전 마지막 수정에 가장 편한 형식.</p>
          <button class="btn" data-act="exportDocx">DOCX 다운로드</button></div>
        <div class="export-card"><h4>📑 PDF</h4><p>인쇄 대화상자가 열립니다. "PDF로 저장"을 선택하세요. 여기서 실제 페이지 수도 확인하세요.</p>
          <button class="btn" data-act="exportPdf">PDF 만들기</button></div>
        <div class="export-card"><h4>📊 PPTX (IR Deck)</h4><p>표지 + 슬라이드 + 발표 대본(발표자 노트). 16:9 와이드.</p>
          <button class="btn" data-act="exportPptx">PPTX 다운로드</button></div>
        <div class="export-card"><h4>🇰🇷 HWP 호환</h4><p>HWP는 비공개 포맷이라 직접 생성이 불가합니다. 두 가지 경로를 제공합니다.</p>
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
        <div class="export-card"><h4>👀 전체 미리보기</h4><p>제출본 형태로 전체 문서를 확인합니다.</p>
          <button class="btn secondary" data-act="togglePreview">미리보기 열기/닫기</button></div>
      </div>
      <div id="fullPreview" style="display:none; margin-top:16px" class="preview"></div>
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
    if (key === 'announce') {
      const raw = document.getElementById('annRaw');
      if (raw) { p.announcement.rawText = raw.value; save(); }
      if (!p.announcement.rawText.trim()) { alert('공고문 원문을 먼저 붙여넣으세요.'); return null; }
      return buildAnnouncementPrompt(p);
    }
    if (key === 'idea') {
      const dir = document.getElementById('ideaDirection');
      return buildIdeaPrompt(p, ui.ideaFields, dir ? dir.value.trim() : '');
    }
    if (key === 'plan') {
      if (!(p.selectedIdeaIndex >= 0 && p.ideas[p.selectedIdeaIndex])) { alert('1단계에서 아이템을 먼저 선정하세요.'); return null; }
      return buildPlanningPrompt(p);
    }
    if (key.startsWith('sec_')) {
      const sec = getSections(p).find((s) => s.id === key.slice(4));
      if (!sec) return null;
      if (!p.planning.raw) {
        if (!confirm('2단계 기획이 아직 없습니다. 기획 없이 작성하면 문서 간 수치 일관성이 깨지기 쉽습니다. 계속할까요?')) return null;
      }
      return buildSectionPrompt(p, sec);
    }
    if (key === 'review') {
      const secs = getSections(p);
      if (!secs.some((s) => p.sections[s.id] && p.sections[s.id].content)) { alert('3단계에서 섹션을 먼저 작성하세요.'); return null; }
      return buildReviewPrompt(p);
    }
    if (key === 'deck') {
      if (!Object.values(p.sections || {}).some((s) => s && s.content)) { alert('3단계 사업계획서를 먼저 작성하세요.'); return null; }
      return buildDeckPrompt(p);
    }
    return null;
  }

  function savePaste(key, text) {
    const p = cur();
    if (!text.trim()) { alert('붙여넣은 내용이 없습니다.'); return; }

    if (key === 'announce') {
      const json = extractJson(text);
      if (!json || typeof json !== 'object' || Array.isArray(json)) { alert('JSON을 찾지 못했습니다. Claude 응답의 ```json 블록 전체를 붙여넣어 주세요.'); return; }
      p.announcement.analysis = json;
      if (json.pageLimit && Number(json.pageLimit)) p.pageLimitOverride = Number(json.pageLimit);
    } else if (key === 'idea') {
      const json = extractJson(text);
      const arr = Array.isArray(json) ? json : (json && Array.isArray(json.ideas) ? json.ideas : null);
      if (!arr || !arr.length) { alert('아이템 JSON 배열을 찾지 못했습니다.'); return; }
      p.ideas = arr;
      p.selectedIdeaIndex = -1;
    } else if (key === 'plan') {
      p.planning = { raw: text.trim() };
      if (!/\[P\d/.test(text)) alert('경고: [P1]~[P10] 태그가 보이지 않습니다. 저장은 되었지만, 태그가 있어야 항목별로 정리됩니다.');
    } else if (key.startsWith('sec_')) {
      p.sections[key.slice(4)] = { content: text.trim(), updatedAt: Date.now() };
    } else if (key === 'review') {
      p.review = { content: text.trim(), at: Date.now() };
    } else if (key === 'deck') {
      const json = extractJson(text);
      if (!json || !Array.isArray(json.slides)) { alert('Deck JSON({title, slides:[...]})을 찾지 못했습니다.'); return; }
      p.deck = json;
    }
    save();
    render();
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
      case 'pickSection': ui.activeSectionId = el.getAttribute('data-sec'); render(); break;
      case 'genPrompt': {
        const key = el.getAttribute('data-key');
        const prompt = buildPrompt(key);
        if (prompt) { ui.prompts[key] = prompt; render(); }
        break;
      }
      case 'copyPrompt': {
        const key = el.getAttribute('data-key');
        navigator.clipboard.writeText(ui.prompts[key] || '').then(
          () => { el.textContent = '✓ 복사됨'; setTimeout(render, 1200); },
          () => alert('클립보드 복사 실패 — 텍스트 영역에서 직접 복사해 주세요.')
        );
        break;
      }
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
      case 'exportDocx': exportDocx(p).catch((e) => alert('DOCX 생성 실패: ' + e.message)); break;
      case 'exportPdf': exportPdf(p); break;
      case 'exportPptx': exportPptx(p); break;
      case 'exportJson': exportProjectJson(p); break;
      case 'importJson': document.getElementById('importFile').click(); break;
      case 'copyHwp':
        copyHwpHtml(p).then((ok) => {
          if (ok) alert('서식 있는 본문이 복사되었습니다.\n한글(HWP)을 열고 붙여넣기(Ctrl+V) 하세요.');
          else alert('복사에 실패했습니다. DOCX→HWP 변환 안내를 이용해 주세요.');
        });
        break;
      case 'hwpGuide':
        alert('HWP 변환 방법:\n\n1) 여기서 DOCX를 다운로드\n2) 한컴오피스 한글(2014 이상)에서 그 DOCX 파일을 직접 열기\n3) 메뉴 → 다른 이름으로 저장 → 파일 형식 "한글 문서(*.hwp)" 선택\n\n서식(개조식 계층, 표)이 유지됩니다.');
        break;
      case 'togglePreview': {
        const box = document.getElementById('fullPreview');
        if (box.style.display === 'none') { box.innerHTML = buildPlanHtml(p); box.style.display = 'block'; }
        else box.style.display = 'none';
        break;
      }
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
    write: renderWrite, review: renderReview, deck: renderDeck, export: renderExport
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
    // 본문
    document.getElementById('main').innerHTML = (RENDERERS[ui.step] || renderSetup)(p);
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
    });

    document.getElementById('projectSelect').addEventListener('change', (e) => {
      state.currentId = e.target.value;
      ui.step = 'setup'; ui.prompts = {}; ui.activeSectionId = null;
      save(); render();
    });

    document.getElementById('btnNewProject').addEventListener('click', () => {
      const name = prompt('새 프로젝트 이름:', '새 프로젝트');
      if (name === null) return;
      newProject(name || '새 프로젝트');
      ui.step = 'setup'; ui.prompts = {};
      save(); render();
    });

    document.getElementById('btnDeleteProject').addEventListener('click', () => {
      const p = cur();
      if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? 되돌릴 수 없습니다. (백업을 원하면 내보내기 → 프로젝트 백업)`)) return;
      delete state.projects[state.currentId];
      state.currentId = Object.keys(state.projects)[0] || null;
      if (!state.currentId) newProject('내 첫 프로젝트');
      ui.step = 'setup'; ui.prompts = {};
      save(); render();
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
          } catch (err) { alert('백업 파일을 읽을 수 없습니다: ' + err.message); }
        };
        reader.readAsText(file);
        e.target.value = '';
      }
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
