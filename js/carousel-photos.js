/**
 * 사진 채우기 — 카피가 만들어 준 영문 검색어로 무료 스톡 사진을 찾아 장마다 배치한다.
 *
 * Pexels를 기본으로 쓴다. 무료 키를 https://www.pexels.com/api/ 에서 발급받아
 * 넣으면 되고, 키는 이 브라우저의 localStorage에만 남는다.
 *
 * 캔버스 오염(tainted canvas) 주의:
 *   다른 도메인 이미지를 crossOrigin 없이 그리면 PNG로 내보낼 때 브라우저가 막는다.
 *   그래서 항상 crossOrigin='anonymous'로 불러오고, 실패하면 그 사진은 버린다.
 *   버리는 편이 "화면에는 보이는데 저장이 안 되는" 상태보다 낫다.
 */
(function (global) {
  'use strict';

  const LS_KEY = 'carousel_photos_v1';
  const ENDPOINT = 'https://api.pexels.com/v1/search';

  let settings = null;

  function get() {
    if (settings) return settings;
    settings = { apiKey: '' };
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw) || {});
    } catch (e) { /* 저장소가 막힌 환경 */ }
    return settings;
  }

  function set(patch) {
    const s = Object.assign(get(), patch || {});
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 무시 */ }
    return s;
  }

  function ready() { return (get().apiKey || '').trim().length > 10; }

  /** 검색어 하나로 후보 사진 목록을 받아온다 */
  async function search(query, opts) {
    const o = opts || {};
    const key = (o.apiKey || get().apiKey || '').trim();
    if (!key) throw Object.assign(new Error('Pexels API 키가 없습니다.'), { code: 'nokey' });

    const url = ENDPOINT +
      '?query=' + encodeURIComponent(query) +
      '&per_page=' + (o.perPage || 6) +
      '&orientation=' + (o.orientation || 'portrait');

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: key }, signal: o.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw Object.assign(
        new Error('사진 서버에 연결하지 못했습니다. 네트워크나 방화벽을 확인해 주세요.'),
        { code: 'blocked', cause: e }
      );
    }
    if (res.status === 401) throw Object.assign(new Error('Pexels 키가 올바르지 않습니다.'), { code: 'auth' });
    if (res.status === 429) throw Object.assign(new Error('Pexels 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.'), { code: 'rate' });
    if (!res.ok) throw new Error('사진 검색이 실패했습니다 (HTTP ' + res.status + ').');

    const body = await res.json();
    return (body.photos || []).map((p) => ({
      id: p.id,
      // large는 폭 940 안팎 — 1080 카드에 쓰기 충분하고 내려받기도 빠르다
      url: (p.src && (p.src.large || p.src.medium)) || '',
      full: (p.src && p.src.large2x) || '',
      author: p.photographer || '',
      link: p.url || ''
    })).filter((p) => p.url);
  }

  /** CORS를 허용하는 방식으로만 불러온다 — 그래야 나중에 PNG로 저장할 수 있다 */
  function load(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다: ' + url));
      img.src = url;
    });
  }

  /**
   * 카드 배열을 받아 장마다 사진을 채운다.
   * 같은 검색어는 한 번만 부르고, 전환 장은 건너뛴다(사진 없이 색만 뒤집는 장이라서).
   * 반환: { images: [카드순 이미지 배열], credits: [출처], misses: [못 찾은 검색어] }
   */
  async function fill(cards, opts) {
    const o = opts || {};
    const cache = {};
    const images = [];
    const credits = [];
    const misses = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.kind === 'turn') { images.push(null); continue; }
      const q = (card.photoQuery || o.fallbackQuery || '').trim();
      if (!q) { images.push(null); misses.push('(검색어 없음) ' + (i + 1) + '장'); continue; }

      if (o.onProgress) o.onProgress(i, cards.length, q);
      try {
        if (!cache[q]) cache[q] = await search(q, o);
        const hit = cache[q][i % Math.max(cache[q].length, 1)] || cache[q][0];
        if (!hit) { images.push(null); misses.push(q); continue; }
        const img = await load(hit.url);
        images.push(img);
        credits.push({ author: hit.author, link: hit.link, query: q });
      } catch (e) {
        if (e && (e.code === 'nokey' || e.code === 'auth' || e.name === 'AbortError')) throw e;
        images.push(null);
        misses.push(q);
      }
    }
    return { images: images, credits: credits, misses: misses };
  }

  /** 카피 전체에서 이미지 생성 프롬프트만 뽑아 붙여쓰기 좋게 만든다 */
  function promptSheet(data) {
    const lines = [];
    (data.cards || []).forEach((c, i) => {
      if (!c.photoPrompt) return;
      lines.push((i + 1) + '. ' + c.photoPrompt);
    });
    if (!lines.length) return '';
    return [
      '# 카드별 사진 생성 프롬프트 (' + (data.topic || '') + ')',
      '4:5 세로, 사진 안에 글자가 들어가지 않게 생성하세요.',
      ''
    ].concat(lines).join('\n');
  }

  /**
   * 캔버스가 오염됐는지 확인한다 — 오염되면 PNG 저장이 막힌다.
   * 저장을 시도하기 전에 이걸로 먼저 알려주는 편이 낫다.
   */
  function exportable(canvas) {
    try { canvas.toDataURL('image/png'); return true; }
    catch (e) { return false; }
  }

  global.CarouselPhotos = {
    get: get, set: set, ready: ready,
    search: search, load: load, fill: fill,
    promptSheet: promptSheet, exportable: exportable
  };
})(typeof window !== 'undefined' ? window : globalThis);
