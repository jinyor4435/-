/**
 * 프롬프트 파이프라인 — 각 단계에서 Claude에 붙여넣을 프롬프트를 생성한다.
 * 결과를 앱에 되붙이면 파싱해 저장한다. (JSON 단계는 ```json 코드블록 하나만 출력하도록 강제)
 */

/** 모든 프롬프트에 공통으로 들어가는 심사위원 페르소나 */
function evaluatorPersona() {
  return [
    '당신은 정부지원사업 심사위원 경력 15년의 전문가다. 창업진흥원 창업패키지, 중기부 TIPS/R&D 과제,',
    '지자체 공모사업을 수백 건 심사했고, 어떤 계획서가 붙고 어떤 계획서가 떨어지는지 정확히 안다.',
    '',
    '작성 원칙 (심사위원이 실제로 감점하는 지점들):',
    ...DEDUCTION_CHECKLIST.map((d) => '- ' + d),
    '',
    '심사위원이 높은 점수를 주는 서술 패턴 (적극 활용할 것):',
    ...EVALUATOR_FAVORITES.map((f) => '- ' + f),
    '',
    '문체 원칙:',
    '- 정부 제출용은 개조식이 표준이다. □(대항목) / ○(중항목) / -(세부) 계층 글머리를 쓴다.',
    '- 문장은 짧게 끊고, 수치에는 근거를 괄호 병기한다. 예: "국내 시장 6.1조 원(KB금융, 2025)"',
    '- 확인된 사실과 가정치를 구분한다. 사용자가 제공하지 않은 사실(설립일, 매출, 특허번호 등)은',
    '  지어내지 말고 【확인】 마커로 남긴다. 가정치에는 "(가정치, 실측 후 재검증)"을 명시한다.'
  ].join('\n');
}

/** 프로젝트의 회사/팀 컨텍스트를 프롬프트용 문자열로 */
function companyContext(project) {
  const c = project.company || {};
  const lines = [];
  if (c.name) lines.push('- 회사/팀명: ' + c.name);
  if (c.stage) lines.push('- 단계: ' + c.stage);
  if (c.team) lines.push('- 팀 구성: ' + c.team);
  if (c.assets) lines.push('- 보유 자산(기술/IP/실적): ' + c.assets);
  if (c.notes) lines.push('- 기타 참고사항: ' + c.notes);
  return lines.length ? '지원자 정보:\n' + lines.join('\n') : '지원자 정보: (미입력 — 팀 관련 서술은 【확인】 마커로 남길 것)';
}

function selectedIdeaContext(project) {
  const idea = (project.ideas || [])[project.selectedIdeaIndex];
  if (!idea) return '';
  return [
    '선정된 창업 아이템:',
    '- 아이템명: ' + (idea.title || ''),
    '- 한 줄 정의: ' + (idea.oneLiner || ''),
    '- 핵심 딥테크: ' + (idea.tech || ''),
    '- 해결하는 문제: ' + (idea.problem || ''),
    '- 목표 고객(지불 주체): ' + (idea.customer || ''),
    '- 차별성: ' + (idea.moat || '')
  ].join('\n');
}

function planningContext(project) {
  if (!project.planning || !project.planning.raw) return '';
  return '확정된 사업 기획(PSST):\n' + project.planning.raw;
}

function announcementContext(project) {
  const a = project.announcement;
  if (!a || !a.analysis) return '';
  const an = a.analysis;
  const lines = ['타겟 공고 분석 결과:'];
  if (an.title) lines.push('- 공고명: ' + an.title);
  if (an.agency) lines.push('- 주관기관: ' + an.agency);
  if (an.pageLimit) lines.push('- 페이지 제한: ' + an.pageLimit + '페이지 이내');
  if (an.budget) lines.push('- 지원 규모: ' + an.budget);
  if (an.evaluationCriteria) lines.push('- 심사 기준: ' + an.evaluationCriteria);
  if (an.keywords && an.keywords.length) lines.push('- 공고 핵심 키워드(본문에 반영할 것): ' + an.keywords.join(', '));
  return lines.join('\n');
}

/* ─────────────────────────── 0단계: 공고문 분석 ─────────────────────────── */

function buildAnnouncementPrompt(project) {
  const raw = (project.announcement && project.announcement.rawText) || '';
  return [
    evaluatorPersona(),
    '',
    '아래 정부지원사업 공고문을 심사위원의 눈으로 분석하라.',
    '주의: 공고문 요약표의 목차와 실제 제출 양식의 목차가 다른 경우가 많다. 본문에 양식 목차가 있으면 그것을 우선하라.',
    '항목명은 절대 임의로 재구성하지 말고 공고문의 표현 그대로 추출하라.',
    '',
    '반드시 아래 스키마의 JSON 하나만 ```json 코드블록으로 출력하라. 다른 텍스트는 쓰지 마라.',
    '공고문에 없는 정보는 null로 두어라 (지어내지 마라).',
    '',
    '```json',
    JSON.stringify({
      title: '공고명',
      agency: '주관기관',
      deadline: '접수 마감일 (YYYY-MM-DD 또는 null)',
      pageLimit: '사업계획서 페이지 제한 (숫자 또는 null)',
      budget: '지원 금액/규모',
      eligibility: '신청 자격 요건 요약',
      evaluationCriteria: '심사 기준과 배점 요약 (예: 기술성 40, 사업성 30, ...)',
      keywords: ['공고가 반복 강조하는 키워드 (본문에 반드시 반영해야 할 표현들)'],
      sections: [{ title: '제출 양식의 실제 목차 항목명 (그대로)', score: '해당 항목 배점(숫자, 모르면 null)', pages: '권장 페이지 수(숫자, 배점 비례 배분)', guide: '이 항목에서 심사위원이 확인하려는 것 1~2문장' }],
      redFlags: ['이 공고에서 탈락/실격 사유가 되는 조건들 (페이지 초과, 자격 미달, 중복 수혜 등)'],
      fitAdvice: '이 공고에 붙기 위해 아이템을 어떻게 프레이밍해야 하는지 3문장 이내 조언'
    }, null, 2),
    '```',
    '',
    '── 공고문 원문 ──',
    raw
  ].join('\n');
}

/* ─────────────────────────── 1단계: 딥테크 아이템 발굴 ─────────────────────────── */

function buildIdeaPrompt(project, fieldIds, userDirection) {
  const fields = DEEPTECH_FIELDS.filter((f) => fieldIds.includes(f.id));
  const fieldDesc = fields.length
    ? fields.map((f) => `- ${f.name}: ${f.hint}`).join('\n')
    : DEEPTECH_FIELDS.map((f) => `- ${f.name}: ${f.hint}`).join('\n');
  const program = PROGRAMS[project.programType] || PROGRAMS.package;

  return [
    evaluatorPersona(),
    '',
    `당신은 지금 "${program.name}" 유형의 지원사업에 낼 딥테크 창업 아이템을 발굴해야 한다.`,
    '심사위원 입장에서 "이건 붙는다"고 판단할 아이템의 조건:',
    '- 기술 장벽이 실재한다 (누구나 3개월이면 따라 만드는 것은 딥테크가 아니다)',
    '- 지불 주체가 명확하다 (누가, 왜, 얼마를 내는지 한 문장으로 설명된다)',
    '- 정부 정책 방향(국가전략기술, 초격차, 탄소중립 등)과 연결된다',
    '- 소규모 팀이 2~3년 내 검증 가능한 범위다 (대기업급 자본이 필요한 아이템은 감점)',
    '- 규제가 있다면 리스크가 아니라 수혜 요인으로 프레이밍 가능한 것',
    '',
    '탐색 분야:',
    fieldDesc,
    '',
    announcementContext(project),
    companyContext(project),
    userDirection ? '사용자 추가 방향성: ' + userDirection : '',
    '',
    '위 조건을 만족하는 딥테크 창업 아이템 5개를 제안하라.',
    '반드시 아래 스키마의 JSON 배열 하나만 ```json 코드블록으로 출력하라.',
    '',
    '```json',
    JSON.stringify([{
      title: '아이템명 (제품/서비스명 느낌으로)',
      oneLiner: '한 줄 정의 (심사위원이 3초에 이해할 문장)',
      field: '딥테크 분야',
      tech: '핵심 기술과 기술 장벽이 무엇인지 2문장',
      problem: '해결하는 문제와 그 크기 (수치 포함)',
      customer: '지불 주체 — 누가 왜 얼마를 내는가',
      moat: '경쟁사/대체재 대비 차별성과 방어 논리',
      policyFit: '연결되는 정부 정책/국가전략기술',
      trl: '현실적으로 시작 가능한 TRL 단계 (1~9)',
      risk: '가장 큰 리스크 1개와 검증 방법',
      evaluatorScore: '심사위원 관점 매력도 1~10과 그 이유 1문장'
    }], null, 2),
    '```'
  ].filter(Boolean).join('\n');
}

/* ─────────────────────────── 2단계: PSST 기획 ─────────────────────────── */

function buildPlanningPrompt(project) {
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  return [
    evaluatorPersona(),
    '',
    `"${program.name}" 제출을 전제로, 아래 아이템의 사업 기획을 확정한다.`,
    '이 기획은 이후 사업계획서 전 섹션과 IR Deck의 단일 진실 공급원(single source of truth)이 된다.',
    '여기서 정한 수치(시장 규모, 목표 KPI, 매출 추정, BEP 시점)는 모든 문서에서 동일하게 쓰인다.',
    '',
    selectedIdeaContext(project),
    announcementContext(project),
    companyContext(project),
    '',
    '아래 항목을 개조식으로 작성하라. 각 항목 제목은 [P1]처럼 대괄호 태그를 정확히 유지하라 (앱이 파싱한다).',
    '',
    '[P1] 문제 정의 — 누구의 어떤 문제인가, 문제의 크기(수치+출처), 왜 지금인가(Why now)',
    '[P2] 솔루션 — 제품/서비스 정의, 핵심 기술 구조, 작동 방식 (심사위원이 이해할 수준으로)',
    '[P3] 기술 차별성 — 경쟁사/대체재 비교표(텍스트 표), 기술 장벽, IP 전략(출원 계획 포함)',
    '[P4] 시장 — TAM/SAM/SOM (bottom-up 산식 명시), 목표 고객 세그먼트, 진입 순서',
    '[P5] 수익모델 — 지불 주체별 과금 구조, 가격, 단위 경제성(unit economics)',
    '[P6] 매출 추정 — 3개년 bottom-up 산식 (고객 수 × 단가, 전환율은 보수적으로), BEP 시점',
    '[P7] 로드맵 — 협약기간 내 분기별 마일스톤과 정량 KPI, TRL 이행 계획',
    '[P8] 자금 계획 — 정부지원금 비목별 사용 계획, 자부담, 후속 조달',
    '[P9] 팀 — 필요 역량 정의, 현재 보유/부족, 부족분의 채용·자문 보완 계획',
    '[P10] 리스크 — 기술/시장/규제 리스크 각 1개와 대응 방안 (규제는 수혜 프레이밍 가능 여부 검토)',
    '[P11] PoC 검증 계획 — 핵심 가설 1개만. 다음을 표로: 검증 환경(장비/데이터 수/부하 조건), 검증 방법(비교군 Baseline, 샘플 수, 반복 횟수),',
    '       핵심 지표 3개(각각 정의·단위·측정법·산출식), 성공 기준(지표별 숫자 임계값 + Go/No-Go 판단 규칙), 실패 시 Plan B.',
    '       "본 PoC는 [환경]에서 [방법]으로 [지표]를 측정하며 [임계값] 이상 달성 시 성공으로 판단한다" 문장 형식을 반드시 포함.',
    '',
    '수치는 반드시 근거를 괄호 병기하고, 추정치에는 "(가정치)"를 붙여라.',
    '사용자가 제공하지 않은 사실은 【확인】으로 남겨라.'
  ].join('\n');
}

/* ─────────────────────────── 3단계: 섹션별 사업계획서 작성 ─────────────────────────── */

function buildSectionPrompt(project, section) {
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  const done = Object.entries(project.sections || {})
    .filter(([id, s]) => s && s.content && id !== section.id)
    .map(([id, s]) => {
      const sec = getSections(project).find((x) => x.id === id);
      return sec ? `※ 이미 작성된 "${sec.title}" 요지:\n${s.content.slice(0, 600)}` : '';
    })
    .filter(Boolean);

  return [
    evaluatorPersona(),
    '',
    `"${program.name}" 사업계획서의 다음 섹션을 작성한다.`,
    `- 섹션: ${section.title}`,
    `- 배점: ${section.score || '명시 없음'}점 / 권장 분량: 약 ${section.pages}페이지 (A4, 11pt 기준 1페이지 ≈ 공백 포함 1,400자)`,
    `- 이 섹션에서 심사위원이 확인하려는 것: ${section.guide}`,
    '',
    selectedIdeaContext(project),
    planningContext(project),
    announcementContext(project),
    companyContext(project),
    done.length ? '\n' + done.join('\n\n') : '',
    '',
    '작성 규칙:',
    '- 개조식(□/○/-)으로 작성. 서술형 문단 금지.',
    '- 표가 효과적인 내용(경쟁 비교, 예산, 일정, KPI)은 마크다운 표로 작성 (문서 변환 시 표로 렌더링됨).',
    '- 기획(PSST)에서 확정한 수치를 그대로 사용하라. 임의로 바꾸면 문서 간 불일치로 감점된다.',
    '- 권장 분량의 ±20% 이내로 작성하라. 분량 미달은 성의 부족, 초과는 다른 섹션 잠식이다.',
    '- 섹션 제목은 다시 쓰지 말고 본문만 출력하라.',
    '- 공고 키워드가 있으면 자연스럽게 본문에 녹여라.'
  ].filter(Boolean).join('\n');
}

/* ─────────────────────────── 4단계: 모의심사 ─────────────────────────── */

function buildReviewPrompt(project) {
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  const sections = getSections(project);
  const body = sections
    .map((sec) => {
      const s = (project.sections || {})[sec.id];
      return `### ${sec.title} (배점 ${sec.score || '-'}점)\n${s && s.content ? s.content : '(미작성)'}`;
    })
    .join('\n\n');

  return [
    evaluatorPersona(),
    '',
    `당신은 지금 "${program.name}" 심사장에 앉아 있다. 아래 사업계획서를 실제 심사하듯 평가하라.`,
    '수십 부를 훑는 심사위원의 속도로 읽고, 동정 없이 냉정하게 채점하라. 후한 점수는 지원자를 돕는 게 아니다.',
    '',
    '평가 순서:',
    '1. 섹션별 채점: 배점 대비 취득 점수와 근거 2문장',
    '2. 감점 요인 전수 점검: 위 작성 원칙의 감점 목록 각각에 대해 위반 여부와 위치를 지적',
    '3. 일관성 검사: 요약-본문-섹션 간 수치 불일치(매출, BEP, 고객 수, KPI)를 전부 찾아라',
    '4. 【확인】 마커와 근거 없는 수치 목록화: 제출 전 반드시 채워야 할 항목',
    '5. 압박 질문 시뮬레이션: 대면평가 단골 질문 4개에 이 계획서가 방어되는지 판정하고, 방어 답변 스크립트를 작성하라.',
    '   ① "데이터 확보는 어떻게 할 것인가?" ② "성능 지표를 어떻게 신뢰할 수 있는가?(측정 환경/방법)"',
    '   ③ "경쟁 기술 대비 비용 효율성이 낮은 것 아닌가?" ④ "대기업/경쟁사가 따라 하면 어떻게 이길 것인가?(해자)"',
    '6. 종합: 합격선 통과 여부 판정과, 점수를 가장 많이 올릴 수정 3가지 (수정 지시는 복사해서 바로 쓸 수 있게 구체적으로)',
    '',
    '── 사업계획서 본문 ──',
    body
  ].join('\n');
}

/* ─────────────────────────── 5단계: IR Deck ─────────────────────────── */

function buildDeckPrompt(project) {
  return [
    evaluatorPersona(),
    '',
    '확정된 사업계획서를 기반으로 IR Deck(발표자료)을 설계한다.',
    '용도: 정부지원사업 대면평가 발표 (7~10분 발표 + 질의응답).',
    '대면평가 발표자료의 원칙:',
    '- 슬라이드당 메시지 1개. 심사위원은 슬라이드를 읽지 않고 듣는다 — 슬라이드는 근거 제시용.',
    '- 사업계획서와 수치가 1원 단위까지 일치해야 한다. 불일치는 질의응답에서 반드시 잡힌다.',
    '- 발표 순서는 결론 먼저: 무엇을 만들고, 왜 되는지부터.',
    '',
    selectedIdeaContext(project),
    planningContext(project),
    '',
    '── 확정 사업계획서 요지 ──',
    Object.entries(project.sections || {})
      .filter(([, s]) => s && s.content)
      .map(([id, s]) => {
        const sec = getSections(project).find((x) => x.id === id);
        return (sec ? '## ' + sec.title + '\n' : '') + s.content.slice(0, 800);
      })
      .join('\n\n'),
    '',
    '12장 이내의 슬라이드를 설계하라. 반드시 아래 스키마의 JSON 하나만 ```json 코드블록으로 출력하라.',
    '',
    '```json',
    JSON.stringify({
      title: '덱 제목 (아이템명)',
      subtitle: '한 줄 정의',
      slides: [{
        title: '슬라이드 제목 (메시지형 — 예: "검사 비용을 1/10로 줄입니다")',
        bullets: ['핵심 포인트 3~5개 (각 1줄, 수치+근거 포함)'],
        visual: '이 슬라이드에 들어갈 도표/이미지 제안 1문장 (예: TAM-SAM-SOM 동심원, 경쟁 비교 2x2)',
        script: '발표자가 이 슬라이드에서 말할 30초 분량 대본 (서술형)'
      }]
    }, null, 2),
    '```'
  ].join('\n');
}

/* ─────────────────────────── 공통 유틸 ─────────────────────────── */

/** 현재 프로젝트의 유효 섹션 목록 (공고문 분석이 목차를 덮어썼으면 그것을 사용) */
function getSections(project) {
  const a = project.announcement;
  if (a && a.analysis && Array.isArray(a.analysis.sections) && a.analysis.sections.length) {
    return a.analysis.sections.map((s, i) => ({
      id: 'a' + i,
      title: s.title || '항목 ' + (i + 1),
      score: Number(s.score) || 0,
      pages: Number(s.pages) || 1,
      guide: s.guide || ''
    }));
  }
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  return program.sections;
}

/** 붙여넣은 텍스트에서 첫 JSON 블록 추출 (```json 펜스 우선, 없으면 중괄호/대괄호 스캔) */
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const firstBrace = Math.min(...['{', '['].map((c) => {
    const i = text.indexOf(c);
    return i === -1 ? Infinity : i;
  }));
  if (firstBrace !== Infinity) candidates.push(text.slice(firstBrace));
  for (const cand of candidates) {
    // 끝에서부터 잘라가며 파싱 시도 (뒤에 딸린 설명 텍스트 허용)
    for (let end = cand.length; end > 0; end--) {
      const ch = cand[end - 1];
      if (ch !== '}' && ch !== ']') continue;
      try {
        return JSON.parse(cand.slice(0, end));
      } catch (e) { /* keep shrinking */ }
    }
  }
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    evaluatorPersona, buildAnnouncementPrompt, buildIdeaPrompt, buildPlanningPrompt,
    buildSectionPrompt, buildReviewPrompt, buildDeckPrompt, getSections, extractJson
  };
}
