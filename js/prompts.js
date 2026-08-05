/**
 * 프롬프트 파이프라인 — 각 단계에서 Claude에 붙여넣을 프롬프트를 생성한다.
 * 결과를 앱에 되붙이면 파싱해 저장한다. (JSON 단계는 ```json 코드블록 하나만 출력하도록 강제)
 */

/**
 * 심사위원 페르소나.
 * 단계마다 같은 목록을 통째로 반복하면 붙여넣을 분량만 늘어난다.
 * 채점 기준이 실제로 필요한 단계(섹션 작성·모의심사)에서만 전체 목록을 넣고,
 * 나머지는 핵심만 간추린 짧은 버전을 쓴다.
 */
function evaluatorPersona(full) {
  if (!full) return briefPersona();
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

/** 간결 페르소나 — 감점 요인은 가장 자주 걸리는 것만 추린다 */
function briefPersona() {
  return [
    '당신은 정부지원사업 심사위원 경력 15년의 전문가다. 어떤 계획서가 붙고 떨어지는지 정확히 안다.',
    '',
    '반드시 지킬 것:',
    '- 지불 주체 기반 bottom-up 추정만 쓴다 (인구 × 침투율 같은 top-down 금지). 전환율은 보수적으로.',
    '- 비용 절감(As-Is → To-Be 수치 대비)을 먼저, 매출 증대를 그 위에 얹는다.',
    '- 성능 지표에는 측정 방법과 숫자 임계값을 반드시 붙인다.',
    '- 사용자가 주지 않은 사실(설립일·매출·특허번호)은 지어내지 말고 【확인】 마커로 남기고,',
    '  추정치에는 "(가정치)"를 명시한다.',
    '- 개조식(□ / ○ / -)으로 쓰고, 수치에는 출처를 괄호 병기한다.'
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

/* ─────────────────── 1단계-B: 기존 사업 딥테크 재정의 ─────────────────── */

function buildReframePrompt(project, bizDesc, userDirection) {
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  return [
    evaluatorPersona(),
    '',
    `당신은 "${program.name}" 제출을 앞둔 기존 사업자의 사업을 딥테크 과제로 재정의(리프레이밍)해야 한다.`,
    '원칙: 지원금의 단위를 바꾸는 것은 기술력이 아니라 사업을 정의하는 프레임이다.',
    '- "개인의 장사"가 아니라 "산업 전체의 고질적 손실(폐기율·불량률·인건비·시간)을 제거하는 기술 과제"로 재정의하라.',
    '- 문제를 기술적 병목으로 다시 써라: 어떤 기술적 한계·데이터 부재 때문에 이 비효율이 여태 해결되지 않았는가.',
    '- 사업자가 이미 보유한 현장 데이터(장부, POS 기록, 리뷰, 상담 로그, 불량 샘플, 이미지)를 대기업이 가질 수 없는 학습 데이터 해자로 격상하라.',
    '- 마이너스 제거(비용·시간·자원 절감) 논리를 우선하고, As-Is → To-Be 수치 대비로 서술하라.',
    '- 재정의는 과장이 아니라 실행 가능해야 한다: 협약기간 내 PoC로 검증 가능한 범위로 설계하고, 근거 없는 수치는 (가정치)로 표기하라.',
    '',
    '── 현재 사업 설명 ──',
    bizDesc,
    '',
    announcementContext(project),
    companyContext(project),
    userDirection ? '사용자 추가 방향성: ' + userDirection : '',
    '',
    '이 사업을 딥테크 과제로 재정의하는 방안 3~5개를 제안하라.',
    '반드시 아래 스키마의 JSON 배열 하나만 ```json 코드블록으로 출력하라.',
    '',
    '```json',
    JSON.stringify([{
      title: '재정의된 기술 과제명',
      oneLiner: '"본 과제는 [기술명]을 활용하여 [기존의 기술적 한계]를 극복하고 [최종 목표]를 달성하는 [서비스명]입니다" 형식의 한 줄 정의',
      before: '기존 프레임 — 지금 심사위원이 이 사업을 보는 방식 1문장',
      after: '딥테크 프레임 — 재정의 후 1문장',
      field: '딥테크 분야',
      tech: '핵심 기술과 기술적 병목이 무엇인지 2문장',
      problem: '산업 전체의 고질적 손실 (As-Is 수치 포함)',
      customer: '지불 주체 — 누가 왜 얼마를 내는가',
      moat: '보유 현장 데이터의 독점성과 축적 선순환(Lock-in) 구조',
      minusPlus: '마이너스 제거 효과(As-Is → To-Be 수치) + 플러스 극대화 여지',
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

/* ─────────────────────────── 3단계: PoC 검증 설계 ─────────────────────────── */

function buildPocPrompt(project) {
  return [
    evaluatorPersona(),
    '',
    '선정 아이템과 확정 기획을 바탕으로 심사위원을 설득할 PoC(검증계획)를 설계한다.',
    '',
    'PoC 설계 3요소와 심사에서의 역할:',
    '- 실험 설계(가설·변수·방법·대상 구체화) → 재현성·현실성 판단 기준',
    '- 지표(KPI, 성과를 숫자로 측정하는 기준) → 객관성·성과 기대치 판단 기준',
    '- 성공 기준(임계값과 Go/No-Go 판단 규칙) → 실행력·리스크 관리 판단 기준',
    '',
    '철칙:',
    '- 1 PoC = 1 핵심 가설. 가설이 많으면 설계가 흐려진다.',
    '- 지표는 이름만 쓰면 점수가 없다. 정의·단위·측정 방법·산출식까지 한 줄로 완성하라.',
    '- 성공 기준은 "좋아지면 성공"이 아니라 숫자 임계값 + 판단 규칙(Go/No-Go)으로.',
    '- 심사위원이 가장 싫어하는 문장: "검증하겠습니다/테스트하겠습니다" (숫자와 방법 없음).',
    '- 비교군(Baseline) 대비 개선치를 목표로, 반복 횟수와 평균/분산 보고를 명시하라.',
    '- 샘플 수/반복 횟수, 실패 시 Plan B, 로그·측정 원본 보관 방식을 포함하라.',
    '',
    selectedIdeaContext(project),
    planningContext(project),
    '',
    '반드시 아래 스키마의 JSON 하나만 ```json 코드블록으로 출력하라.',
    '',
    '```json',
    JSON.stringify({
      purpose: 'PoC 목적 (한 문장)',
      hypothesis: '핵심 가설 1개 (숫자 포함. 예: 제안 모델은 기존 대비 정확도 +5%p 이상 개선, 지연 200ms 이하 유지)',
      target: '검증 대상 (데이터/시제품/알고리즘/모듈/공정 등)',
      environment: '검증 환경 (장소/장비/클라우드/데이터 수/부하 조건 등 구체적으로)',
      method: '검증 방법 (실험 설계 요약: 샘플 수, 비교군, 반복 횟수, 테스트 시나리오)',
      baseline: '비교군(Baseline) — 기존 모델/기존 공정/시장 표준/경쟁 제품',
      repeat: '반복 횟수와 결과 보고 방식 (예: 3회 반복 후 평균·표준편차 보고)',
      metrics: [{
        name: '지표명', definition: '무엇을 측정하는가', unit: '단위',
        method: '측정 방법/도구', formula: '산출식 또는 기준',
        asIs: '현재 수준(As-Is)', toBe: '목표(To-Be)', threshold: '성공 임계값'
      }],
      goRule: 'Go/No-Go 판단 규칙 (예: 지표1 ≥ X & 지표2 ≤ Y → Go)',
      planB: '성공 기준 미달 시 대응 (원인 가설 검증 → Plan B 전환 2차 PoC)',
      deliverables: '산출물 (결과 리포트/테스트 로그/재현 스크립트/시험 성적서 등)',
      schedule: [{ week: 'W1', task: '주요 작업', owner: '담당(역할)', resource: '필요 자원(장비/클라우드/외주)', output: '산출물' }],
      sentence: '"본 PoC는 [환경/조건]에서 [방법/도구]로 [지표]를 측정하며, [임계값] 이상 달성 시 성공으로 판단한다" 형식의 완성 문장'
    }, null, 2),
    '```'
  ].join('\n');
}

/** PoC JSON → 개조식+마크다운 표 텍스트 (문서 삽입·클립보드·프롬프트 컨텍스트 공용) */
function pocToMarkdown(poc) {
  if (!poc) return '';
  const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = [];
  lines.push('□ PoC 목적: ' + cell(poc.purpose));
  lines.push('□ 핵심 가설: ' + cell(poc.hypothesis));
  if (poc.sentence) lines.push('□ 검증 문장: ' + cell(poc.sentence));
  lines.push('');
  lines.push('| 항목 | 내용 |');
  lines.push('|---|---|');
  lines.push('| 검증 대상 | ' + cell(poc.target) + ' |');
  lines.push('| 검증 환경 | ' + cell(poc.environment) + ' |');
  lines.push('| 검증 방법 | ' + cell(poc.method) + ' |');
  lines.push('| 비교군(Baseline) | ' + cell(poc.baseline) + ' |');
  lines.push('| 반복/보고 | ' + cell(poc.repeat) + ' |');
  lines.push('| 산출물 | ' + cell(poc.deliverables) + ' |');
  lines.push('');
  if (Array.isArray(poc.metrics) && poc.metrics.length) {
    lines.push('| 지표 | 정의 | 단위 | 측정 방법 | 산출식 | As-Is | To-Be | 임계값 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const m of poc.metrics) {
      lines.push('| ' + [m.name, m.definition, m.unit, m.method, m.formula, m.asIs, m.toBe, m.threshold].map(cell).join(' | ') + ' |');
    }
    lines.push('');
  }
  lines.push('□ Go/No-Go 판단 규칙: ' + cell(poc.goRule));
  lines.push('□ 실패 시 Plan B: ' + cell(poc.planB));
  if (Array.isArray(poc.schedule) && poc.schedule.length) {
    lines.push('');
    lines.push('| 주차 | 주요 작업 | 담당 | 필요 자원 | 산출물 |');
    lines.push('|---|---|---|---|---|');
    for (const w of poc.schedule) {
      lines.push('| ' + [w.week, w.task, w.owner, w.resource, w.output].map(cell).join(' | ') + ' |');
    }
  }
  return lines.join('\n');
}

function pocContext(project) {
  if (!project.poc) return '';
  return '확정된 PoC 검증 계획 (검증/실현가능성 관련 서술은 이 계획과 일치시킬 것):\n' + pocToMarkdown(project.poc);
}

/* ─────────────────────────── 4단계: 섹션별 사업계획서 작성 ─────────────────────────── */

function buildSectionPrompt(project, section) {
  const program = PROGRAMS[project.programType] || PROGRAMS.package;
  // 이미 쓴 섹션은 수치 일관성 확인용이므로, 전문 대신 앞부분만 짧게 넣는다
  const done = Object.entries(project.sections || {})
    .filter(([id, s]) => s && s.content && id !== section.id)
    .slice(-4)
    .map(([id, s]) => {
      const sec = getSections(project).find((x) => x.id === id);
      const gist = s.content.split('\n').filter((l) => l.trim()).slice(0, 6).join('\n');
      return sec ? `※ 이미 작성된 "${sec.title}" 요지:\n${gist}` : '';
    })
    .filter(Boolean);

  return [
    evaluatorPersona(true),
    '',
    `"${program.name}" 사업계획서의 다음 섹션을 작성한다.`,
    `- 섹션: ${section.title}`,
    `- 배점: ${section.score || '명시 없음'}점 / 권장 분량: 약 ${section.pages}페이지 (A4, 11pt 기준 1페이지 ≈ 공백 포함 1,400자)`,
    `- 이 섹션에서 심사위원이 확인하려는 것: ${section.guide}`,
    '',
    selectedIdeaContext(project),
    planningContext(project),
    pocContext(project),
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
    evaluatorPersona(true),
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
    body,
    project.poc ? '\n── 붙임: PoC 검증 계획 ──\n' + pocToMarkdown(project.poc) : ''
  ].filter(Boolean).join('\n');
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
        const gist = s.content.split('\n').filter((l) => l.trim()).slice(0, 8).join('\n');
        return (sec ? '## ' + sec.title + '\n' : '') + gist;
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

/** 흔한 LLM 출력 오류를 고쳐 다시 파싱을 시도한다 (마지막 수단) */
function repairJson(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 블록 주석
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')  // 줄 주석 (URL 은 건드리지 않는다)
    .replace(/,(\s*[}\]])/g, '$1');            // 닫기 직전의 쉼표
}

/** 문자열·이스케이프를 인식하며 균형 잡힌 JSON 덩어리들을 찾아낸다 */
function findJsonChunks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) { chunks.push(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return chunks;
}

/**
 * 붙여넣은 텍스트에서 JSON을 뽑아낸다.
 * 코드블록·앞뒤 설명·여러 덩어리가 섞여 있어도 찾아내며, validate 를 주면 조건에 맞는 것을 고른다.
 */
function extractJson(text, validate) {
  if (!text) return null;

  // 코드블록 안을 먼저 보고, 그다음 전체 텍스트를 훑는다
  const sources = [];
  const fenceRe = /```[a-zA-Z]*\s*\n([\s\S]*?)```/g;
  let f;
  while ((f = fenceRe.exec(text))) sources.push(f[1]);
  sources.push(text);

  const parsed = [];
  for (const src of sources) {
    for (const chunk of findJsonChunks(src)) {
      let value = null;
      try { value = JSON.parse(chunk); }
      catch (e) {
        try { value = JSON.parse(repairJson(chunk)); } catch (e2) { continue; }
      }
      if (value && typeof value === 'object') {
        if (validate && validate(value)) return value;
        parsed.push(value);
      }
    }
    if (!validate && parsed.length) return parsed[0];
  }
  // 조건에 맞는 게 없으면, 찾은 것 중 가장 큰 덩어리를 돌려준다 (호출 측에서 사유를 설명한다)
  if (!parsed.length) return null;
  return parsed.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
}

/** 붙여넣은 내용이 응답이 아니라 프롬프트 자체인지 알아본다 */
function looksLikePrompt(text) {
  const marks = [
    '당신은 정부지원사업 심사위원',
    '반드시 아래 스키마',
    '```json 코드블록으로 출력하라',
    '작성 원칙 (심사위원이 실제로 감점하는 지점들)'
  ];
  return marks.some((m) => text.includes(m));
}

if (typeof module !== 'undefined') {
  module.exports = {
    evaluatorPersona, buildAnnouncementPrompt, buildIdeaPrompt, buildReframePrompt, buildPlanningPrompt,
    buildPocPrompt, pocToMarkdown, buildSectionPrompt, buildReviewPrompt, buildDeckPrompt, getSections,
    extractJson, findJsonChunks, repairJson, looksLikePrompt
  };
}
