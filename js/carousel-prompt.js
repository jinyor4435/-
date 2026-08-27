/**
 * 카드뉴스 프롬프트 — 세 가지 룰(한 문장 훅 / 핵심 지연 / 쉬운 단어)을
 * 그대로 모델에게 넘기고, 화면이 바로 그릴 수 있는 JSON만 받아온다.
 *
 * 룰의 출처는 .claude/skills/carousel 이며, 문구가 바뀌면 양쪽을 같이 고친다.
 */
(function (global) {
  'use strict';

  const PLATFORMS = {
    instagram: { label: '인스타 캐러셀', cards: 9, ratio: '4:5', bodyLines: '3~4줄' },
    threads:   { label: '스레드 체인',   cards: 6, ratio: '4:5', bodyLines: '2~3줄' },
    linkedin:  { label: '링크드인',      cards: 10, ratio: '4:5', bodyLines: '3~4줄' }
  };

  const JARGON = {
    '리텐션': '끝까지 보는 사람', '인게이지먼트': '반응', '도달률': '몇 명에게 보이는지',
    '임프레션': '보인 횟수', '퍼널': '사는 데까지 오는 길', '컨버전': '실제 행동',
    '온보딩': '처음 익히는 과정', '레버리지': '지렛대처럼 쓰는 것', '시너지': '같이 커지는 것',
    '페인포인트': '불편한 지점', '니즈': '원하는 것', '인사이트': '알게 된 것',
    '최적화': '다듬기', '고도화': '더 낫게 만들기', '프로세스': '순서', '메커니즘': '작동 원리'
  };

  /** 사용자 입력 → 모델에게 보낼 프롬프트 한 덩어리 */
  function build(input) {
    const p = PLATFORMS[input.platform] || PLATFORMS.instagram;
    const n = input.cards || p.cards;
    const density = input.density === 'short' ? '1~2줄' : p.bodyLines;

    return [
      '너는 한국어 카드뉴스(캐러셀) 카피라이터다. 아래 세 가지 룰을 지켜 ' + n + '장을 쓴다.',
      '',
      '# 룰 1 — 첫 장은 한 문장',
      '첫 장(훅)의 역할은 정보 전달이 아니라 안 넘기고는 못 배기게 만드는 것이다.',
      '- 한 문장, 20자 내외, 두 줄 이내. 25자를 넘으면 잘라낼 곳이 있다는 뜻이다.',
      '- 배경 설명·인사·자기소개는 전부 뺀다. 마침표는 대개 빼는 게 낫다.',
      '- 공감("이거 내 얘기네") 또는 반전("어? 왜?") 중 하나로만 건다. 둘 다 노리면 둘 다 놓친다.',
      '',
      '# 룰 2 — 핵심을 바로 주지 마라',
      '2장에서 정답부터 주면 머무를 이유가 사라진다. 답은 절반 지점 이후로 민다.',
      '구성: 훅 → 문제 제시 → 고통 증폭 → 기존 방식 확인 → "하지만" 전환 → 해법(한 장에 하나씩) → 회수 → CTA',
      '- "하지만" 전환은 전체의 절반쯤에 둔다. 기존 방식을 세운 뒤 뒤집어야 힘이 생긴다.',
      '- 한 장에 메시지는 하나. 모든 장은 다음 장으로 넘어갈 이유를 남긴다.',
      '- 마지막 장 회수: 훅의 단어를 다시 꺼내 닫는다.',
      '',
      '# 룰 3 — 단순함이 이긴다',
      '어려운 단어는 감탄이 아니라 혼란을 만든다. 중학생이 한 번에 이해할 수 있어야 한다.',
      '- 전문용어는 읽는 사람의 말로 바꾼다. 예: ' +
        Object.keys(JARGON).slice(0, 5).map((k) => k + ' → ' + JARGON[k]).join(', '),
      '- 한 문장 25자 이내, 수식어보다 동사. 짧은 문장·짧은 문장·조금 긴 문장으로 리듬을 만든다.',
      '',
      '# 이번 건',
      '- 주제: ' + (input.topic || '').trim(),
      (input.audience ? '- 읽는 사람: ' + input.audience.trim() : '- 읽는 사람: 주제에 맞춰 네가 정한다'),
      (input.message ? '- 남길 메시지 하나: ' + input.message.trim() : '- 남길 메시지 하나: 네가 정한다 (반드시 한 개)'),
      '- 플랫폼: ' + p.label + ' ' + n + '장 (' + p.ratio + ')',
      '- 본문 분량: 장당 ' + density + ', 한 줄 24자 이내',
      (input.tone ? '- 톤: ' + input.tone.trim() : ''),
      '',
      '# 절대 하지 말 것',
      '- 근거 없는 수치·후기·사례를 지어내지 않는다. 숫자가 필요한 자리에는 【확인】 표시만 남긴다.',
      '- 의학·법률·금융에서 단정적인 효과를 약속하지 않는다.',
      '- 슬라이드 텍스트에 설명이나 지시문을 섞지 않는다.',
      '',
      '# 출력 형식',
      '아래 JSON만 출력한다. 코드펜스도 설명도 붙이지 않는다.',
      '{',
      '  "topic": "주제 한 줄",',
      '  "audience": "읽는 사람",',
      '  "message": "남길 메시지 하나",',
      '  "cards": [',
      '    {"kind":"hook","title":"훅 한 문장","kicker":"표지 위 작은 말머리 (12자 내외)",',
      '     "photoQuery":"영문 검색어 2~4단어","photoPrompt":"영문 사진 생성 프롬프트 한 문장"},',
      '    {"kind":"body","title":"제목 (12자 내외, 두 줄까지)","body":["본문 줄1","본문 줄2"],',
      '     "photoQuery":"...","photoPrompt":"..."},',
      '    {"kind":"turn","title":"하지만으로 시작하는 전환 문장 (줄바꿈은 배열로)"},',
      '    {"kind":"step","step":1,"title":"해법 제목","body":["본문 줄1","본문 줄2"],',
      '     "photoQuery":"...","photoPrompt":"..."},',
      '    {"kind":"outro","title":"회수 문장","body":["보조 문장"],"cta":"저장 유도 한 줄",',
      '     "photoQuery":"...","photoPrompt":"..."}',
      '  ],',
      '  "caption": "인스타 캡션. 요약이 아니라 못 다한 이야기 한 조각.",',
      '  "hashtags": ["#해시태그", "10개 내외"]',
      '}',
      '',
      '규칙: cards는 정확히 ' + n + '개. 첫 장은 kind:"hook", 마지막 장은 kind:"outro".',
      'kind:"turn"은 정확히 한 장이며 ' + Math.max(3, Math.round(n / 2)) + '번째 부근에 둔다.',
      'kind:"step"은 해법 장에만 쓰고 step에 1,2,3을 순서대로 넣는다.',
      'title은 문자열, body는 문자열 배열이다. title 안에서 줄을 나누려면 \\n을 쓴다.',
      '',
      '# 사진 지시 (photoQuery / photoPrompt)',
      'kind:"turn"을 뺀 모든 장에 넣는다. 둘 다 영어로 쓴다.',
      '- photoQuery: 무료 스톡 사이트에서 찾을 검색어. 2~4단어의 일반명사로. 예: "dark bedroom night", "healthy meal table"',
      '- photoPrompt: 그 장의 분위기를 담은 사진 생성 프롬프트 한 문장.',
      '  사람 얼굴이 크게 나오지 않게 하고, 마지막에 반드시 ", no text, no letters, no watermark"를 붙인다.',
      '- 카드 문구를 그대로 옮기지 말고, 그 장이 말하는 장면을 묘사한다.'
    ].filter(Boolean).join('\n');
  }

  /** 모델 응답에서 JSON만 건져낸다 — 코드펜스나 앞뒤 설명이 붙어도 살린다 */
  function parse(text) {
    const raw = String(text || '');
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    if (s[0] !== '{') {
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a < 0 || b <= a) throw new Error('응답에서 JSON을 찾지 못했습니다.');
      s = s.slice(a, b + 1);
    }
    let data;
    try {
      data = JSON.parse(s);
    } catch (e) {
      throw new Error('JSON 형식이 어긋났습니다. 다시 생성해 보세요.');
    }
    if (!data || !Array.isArray(data.cards) || !data.cards.length) {
      throw new Error('cards가 비어 있습니다. 다시 생성해 보세요.');
    }
    data.cards = data.cards.map(normalizeCard);
    data.hashtags = Array.isArray(data.hashtags) ? data.hashtags : [];
    return data;
  }

  function normalizeCard(c, i) {
    const card = c && typeof c === 'object' ? c : {};
    const kind = card.kind || (i === 0 ? 'hook' : 'body');
    const body = Array.isArray(card.body) ? card.body
      : (typeof card.body === 'string' && card.body ? card.body.split('\n') : []);
    return {
      kind: kind,
      step: card.step || null,
      kicker: card.kicker || '',
      title: String(card.title || '').replace(/\r/g, ''),
      body: body.map((l) => String(l || '').trim()).filter(Boolean),
      cta: card.cta || '',
      photoQuery: String(card.photoQuery || '').trim(),
      photoPrompt: String(card.photoPrompt || '').trim()
    };
  }

  /**
   * 스킬의 검사 스크립트와 같은 항목을 화면에서 확인한다.
   * 경고는 막지 않는다 — 사람이 보고 판단할 몫이다.
   */
  function check(data) {
    const out = [];
    const cards = data.cards || [];
    const n = cards.length;
    const chars = (s) => String(s || '').replace(/\s/g, '').length;

    const hook = cards[0] || {};
    const hookText = [hook.title].concat(hook.body || []).join(' ');
    const hookLines = String(hook.title || '').split('\n').length + (hook.body || []).length;
    const sentences = hookText.split(/[.!?…]+/).filter((t) => t.trim()).length;
    if (chars(hookText) > 25) out.push({ level: 'warn', text: '[룰 1] 훅이 ' + chars(hookText) + '자 — 25자 내외로 줄이면 좋습니다.' });
    if (hookLines > 2) out.push({ level: 'error', text: '[룰 1] 훅이 ' + hookLines + '줄 — 두 줄을 넘으면 0.5초 안에 안 읽힙니다.' });
    if (sentences > 1) out.push({ level: 'error', text: '[룰 1] 훅에 문장이 ' + sentences + '개 — 한 문장으로 줄입니다.' });

    const turnAt = cards.findIndex((c) => c.kind === 'turn' || /하지만|그러나|반대로/.test(c.title || ''));
    if (turnAt < 0) out.push({ level: 'error', text: '[룰 2] "하지만" 전환 장이 없습니다.' });
    else if (turnAt + 1 < 3) out.push({ level: 'warn', text: '[룰 2] 전환이 ' + (turnAt + 1) + '장 — 긴장을 쌓기 전에 뒤집으면 힘이 없습니다.' });

    const firstStep = cards.findIndex((c) => c.kind === 'step');
    if (firstStep >= 0 && firstStep + 1 <= Math.floor(n / 2)) {
      out.push({ level: 'warn', text: '[룰 2] 해법이 ' + (firstStep + 1) + '장에서 시작합니다 — 절반 이후로 미는 쪽이 낫습니다.' });
    }

    const all = cards.map((c) => [c.title].concat(c.body || []).join(' ')).join('\n');
    Object.keys(JARGON).forEach((w) => {
      if (all.indexOf(w) >= 0) out.push({ level: 'warn', text: '[룰 3] 전문용어 "' + w + '" → "' + JARGON[w] + '"로 바꿔보세요.' });
    });

    cards.forEach((c, i) => {
      (c.body || []).concat(String(c.title || '').split('\n')).forEach((line) => {
        if (chars(line) > 28) out.push({ level: 'warn', text: '[룰 3] ' + (i + 1) + '장에 ' + chars(line) + '자짜리 줄이 있습니다 — 24자 내외로 끊습니다.' });
      });
    });

    const last = cards[n - 1] || {};
    const ctaText = (last.cta || '') + ' ' + (last.body || []).join(' ');
    const ctas = ['저장', '공유', '팔로우', '댓글', '프로필', '링크'].filter((w) => ctaText.indexOf(w) >= 0);
    if (!ctas.length) out.push({ level: 'warn', text: '마지막 장에 행동 요청(CTA)이 없습니다.' });
    else if (ctas.length > 1) out.push({ level: 'error', text: '마지막 장 CTA가 ' + ctas.length + '개(' + ctas.join(', ') + ') — 하나만 남깁니다.' });

    if (/\d+\s*(%|퍼센트|배 이상|명|건|만원)/.test(all) && all.indexOf('【확인') < 0) {
      out.push({ level: 'warn', text: '수치가 들어 있습니다 — 실제 근거가 있는 숫자인지 확인하세요.' });
    }
    return out;
  }

  global.CarouselPrompt = { build: build, parse: parse, check: check, PLATFORMS: PLATFORMS, JARGON: JARGON };
})(typeof window !== 'undefined' ? window : globalThis);
