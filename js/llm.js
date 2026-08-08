/**
 * 자동 생성 엔진 — 앱이 만든 프롬프트를 Claude API로 직접 보내고, 결과만 화면에 흘려준다.
 *
 * 붙여넣기 없이 동작하려면 브라우저가 api.anthropic.com에 직접 요청할 수 있어야 한다.
 * (게시된 아티팩트 링크 안에서는 외부 호출이 차단되므로 자동 모드가 동작하지 않는다.
 *  이때는 앱이 그 사실을 감지해 수동 모드로 안내한다.)
 *
 * API 키는 이 브라우저의 localStorage에만 저장되고, 요청은 앱 → Anthropic으로만 나간다.
 */
(function (global) {
  'use strict';

  const LS_KEY = 'gfp_llm_v1';
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';

  const MODELS = [
    { id: 'claude-opus-5', name: 'Claude Opus 5', hint: '가장 품질이 높음 (권장)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', hint: '빠르고 저렴' }
  ];

  const DEFAULTS = { apiKey: '', model: 'claude-opus-5', thinking: true };

  let settings = null;

  function get() {
    if (settings) return settings;
    settings = Object.assign({}, DEFAULTS);
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw) || {});
    } catch (e) { /* 저장소가 막힌 환경 — 기본값으로 진행 */ }
    if (!MODELS.some((m) => m.id === settings.model)) settings.model = DEFAULTS.model;
    return settings;
  }

  function set(patch) {
    const s = Object.assign(get(), patch || {});
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch (e) { /* 세션 동안만 유지 */ }
    return s;
  }

  function clear() {
    settings = Object.assign({}, DEFAULTS);
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* 무시 */ }
  }

  /** 키가 있고 형식이 그럴듯한가 — 자동 모드 노출 여부 판단에만 쓴다 */
  function ready() {
    const k = (get().apiKey || '').trim();
    return k.length > 20;
  }

  function maskKey(k) {
    const s = (k || '').trim();
    if (s.length < 12) return s ? '••••' : '';
    return s.slice(0, 11) + '…' + s.slice(-4);
  }

  function headers(key) {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }

  /** 네트워크 자체가 막힌 경우(아티팩트 CSP 등)와 API 오류를 구분해서 알려준다 */
  function netError(e) {
    const err = new Error(
      '이 환경에서는 앱이 Claude API에 직접 연결할 수 없습니다.\n' +
      '게시된 아티팩트 링크 안에서는 외부 통신이 차단됩니다. ' +
      '단일 실행 파일(app-single.html)을 내려받아 브라우저에서 열면 자동 생성이 동작합니다. ' +
      '지금은 아래 수동 모드(프롬프트 복사 → 붙여넣기)를 이용하세요.'
    );
    err.code = 'blocked';
    err.cause = e;
    return err;
  }

  async function apiError(res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || '';
    } catch (e) { /* 본문 없음 */ }
    const map = {
      401: 'API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.',
      403: 'API 키에 이 모델을 사용할 권한이 없습니다.',
      404: '요청한 모델을 찾을 수 없습니다. 설정에서 다른 모델을 선택해 보세요.',
      429: '요청 한도(rate limit)에 걸렸습니다. 잠시 후 다시 시도해 주세요.',
      529: 'Claude 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.'
    };
    const head = map[res.status] || ('요청이 실패했습니다 (HTTP ' + res.status + ').');
    const err = new Error(detail ? head + '\n' + detail : head);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'api';
    err.status = res.status;
    return err;
  }

  /**
   * 스트리밍 호출. onToken(chunk, full)으로 본문이 조각조각 올라오고,
   * onThinking(isThinking)으로 "생각 중" 상태를 알려준다.
   * 반환값은 누적된 본문 텍스트.
   */
  async function stream(opts) {
    const o = opts || {};
    const s = get();
    const key = (o.apiKey || s.apiKey || '').trim();
    if (!key) throw Object.assign(new Error('API 키가 없습니다.'), { code: 'nokey' });

    const body = {
      model: o.model || s.model || DEFAULTS.model,
      max_tokens: o.maxTokens || 16000,
      stream: true,
      messages: [{ role: 'user', content: String(o.prompt || '') }]
    };
    if (o.system) body.system = o.system;
    // 4.6 이후 모델은 budget_tokens 없이 adaptive만 받는다
    if (o.thinking !== false && s.thinking !== false) body.thinking = { type: 'adaptive' };

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body),
        signal: o.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw netError(e);
    }
    if (!res.ok) throw await apiError(res);
    if (!res.body) throw new Error('스트리밍 응답을 읽을 수 없는 브라우저입니다.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let thinking = false;

    const setThinking = (v) => {
      if (v === thinking) return;
      thinking = v;
      if (o.onThinking) o.onThinking(v);
    };

    const handle = (payload) => {
      let ev;
      try { ev = JSON.parse(payload); } catch (e) { return; }
      if (!ev || !ev.type) return;
      if (ev.type === 'content_block_start') {
        setThinking(ev.content_block && ev.content_block.type === 'thinking');
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
          setThinking(false);
          full += d.text;
          if (o.onToken) o.onToken(d.text, full);
        } else if (d.type === 'thinking_delta') {
          setThinking(true);
        }
      } else if (ev.type === 'content_block_stop') {
        setThinking(false);
      } else if (ev.type === 'error') {
        const msg = (ev.error && ev.error.message) || '스트리밍 중 오류가 발생했습니다.';
        throw Object.assign(new Error(msg), { code: 'api' });
      }
    };

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw netError(e);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        raw.split('\n').forEach((line) => {
          const t = line.trim();
          if (t.slice(0, 5) === 'data:') handle(t.slice(5).trim());
        });
      }
    }
    setThinking(false);
    if (!full.trim()) throw new Error('응답이 비어 있습니다. 잠시 후 다시 시도해 주세요.');
    return full;
  }

  /** 설정 화면의 "연결 테스트" — 짧은 호출 한 번으로 키·모델·네트워크를 모두 확인한다 */
  async function test(apiKey, model) {
    const key = (apiKey || get().apiKey || '').trim();
    if (!key) throw Object.assign(new Error('API 키를 입력해 주세요.'), { code: 'nokey' });
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({
          model: model || get().model || DEFAULTS.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }]
        })
      });
    } catch (e) {
      throw netError(e);
    }
    if (!res.ok) throw await apiError(res);
    return true;
  }

  global.LLM = { get, set, clear, ready, maskKey, stream, test, MODELS, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
