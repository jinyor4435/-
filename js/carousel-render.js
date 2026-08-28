/**
 * 카드 렌더러 — 카피 한 장을 1080×1350 캔버스로 그린다.
 *
 * 레이아웃은 카드뉴스에서 실제로 통하는 형태로 고정했다.
 *   표지  : 사진 위 어두운 막 + 킥커 + 큰 훅 + 브랜드 줄
 *   본문  : 흐린 배경 + 큰 제목 + 본문 + 사진 2장 겹치기 + 페이지 표시
 *   전환  : 사진 없이 색을 뒤집고 문장만 크게
 *   마무리: 회수 문장 + 가로선 + CTA + 사진 1장
 *
 * 배경 흐림은 캔버스 filter로 직접 처리한다 — 흐린 사진을 따로 준비할 필요가 없다.
 */
(function (global) {
  'use strict';

  const W = 1080;
  const H = 1350;
  const PAD = 80;
  const FONT = "'Pretendard', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif";

  const THEMES = {
    night: { name: '어두운 밤', bg: '#12100E', ink: '#FFFFFF', sub: '#D9CFC2',
             dim: '#B9B2A8', accent: '#E8DCC8', turnBg: '#0B0B0C',
             grad: ['#241d16', '#12100e'] },
    ocean: { name: '딥 블루', bg: '#0C1522', ink: '#FFFFFF', sub: '#C6D4E4',
             dim: '#93A4B8', accent: '#7FB2F0', turnBg: '#070C14',
             grad: ['#16283f', '#0c1522'] },
    paper: { name: '따뜻한 종이', bg: '#F3EDE4', ink: '#1B1815', sub: '#4A4239',
             dim: '#7A7065', accent: '#B4542A', turnBg: '#1B1815',
             grad: ['#faf6ef', '#ece3d6'] }
  };

  /* ───────── 글자 다루기 ───────── */

  /** 폭에 맞춰 줄을 나눈다. 한국어는 어절 단위로 끊고, 한 어절이 넘치면 글자로 쪼갠다. */
  function wrap(ctx, text, maxWidth) {
    const out = [];
    String(text || '').split('\n').forEach((para) => {
      if (!para.trim()) { out.push(''); return; }
      let line = '';
      para.split(' ').forEach((word) => {
        const next = line ? line + ' ' + word : word;
        if (ctx.measureText(next).width <= maxWidth) { line = next; return; }
        if (line) out.push(line);
        if (ctx.measureText(word).width <= maxWidth) { line = word; return; }
        let piece = '';
        for (const ch of word) {
          if (ctx.measureText(piece + ch).width > maxWidth) { out.push(piece); piece = ch; }
          else piece += ch;
        }
        line = piece;
      });
      out.push(line);
    });
    return out;
  }

  /**
   * 넘치지 않는 가장 큰 글자 크기를 찾아 그린다.
   * 카드뉴스는 큰 글씨가 생명이라 줄이기 전에 최대 크기부터 시도한다.
   */
  function drawText(ctx, text, opts) {
    const o = opts || {};
    const maxWidth = o.maxWidth || (W - PAD * 2);
    const weight = o.weight || 400;
    const lh = o.lineHeight || 1.5;
    let size = o.size;
    let lines;
    for (;;) {
      ctx.font = weight + ' ' + size + 'px ' + FONT;
      lines = wrap(ctx, text, maxWidth);
      const fits = (!o.maxLines || lines.length <= o.maxLines) &&
                   (!o.maxHeight || lines.length * size * lh <= o.maxHeight);
      if (fits || size <= (o.minSize || 28)) break;
      size -= 2;
    }
    ctx.fillStyle = o.color || '#fff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let y = o.y;
    lines.forEach((line) => {
      ctx.fillText(line, o.x, y + (size * lh - size) / 2);
      y += size * lh;
    });
    return { bottom: y, size: size, lines: lines.length };
  }

  /* ───────── 배경과 사진 ───────── */

  function paintBackdrop(ctx, theme, photo, opts) {
    const o = opts || {};
    ctx.save();
    if (photo) {
      ctx.filter = 'blur(' + (o.blur == null ? 14 : o.blur) + 'px)';
      coverDraw(ctx, photo, -60, -60, W + 120, H + 120);
      ctx.filter = 'none';
    } else {
      const g = ctx.createLinearGradient(0, 0, W * 0.6, H);
      g.addColorStop(0, theme.grad[0]);
      g.addColorStop(1, theme.grad[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    if (o.veil !== 0) {
      ctx.fillStyle = hexToRgba(o.veilColor || '#0B0B0C', o.veil == null ? 0.44 : o.veil);
      ctx.fillRect(0, 0, W, H);
    }
  }

  /** 비율을 유지한 채 지정한 사각형을 가득 채운다 (CSS object-fit: cover) */
  function coverDraw(ctx, img, x, y, w, h) {
    const ir = img.width / img.height;
    const rr = w / h;
    let sw = img.width, sh = img.height, sx = 0, sy = 0;
    if (ir > rr) { sw = img.height * rr; sx = (img.width - sw) / 2; }
    else { sh = img.width / rr; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function photoTile(ctx, img, x, y, size, angle) {
    if (!img) return;
    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate((angle || 0) * Math.PI / 180);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = '#000';
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.rect(-size / 2, -size / 2, size, size);
    ctx.clip();
    coverDraw(ctx, img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ───────── 장 종류별 그리기 ───────── */

  function drawHook(ctx, card, ctx2) {
    const { theme, photo, brand } = ctx2;
    paintBackdrop(ctx, theme, photo, { blur: 0, veil: 0.5 });
    let y = H - 500;
    if (card.kicker) {
      const k = drawText(ctx, card.kicker, {
        x: PAD, y: y, size: 38, weight: 700, color: theme.dim, maxLines: 1, lineHeight: 1.3
      });
      y = k.bottom + 22;
    }
    const t = drawText(ctx, card.title, {
      x: PAD, y: y, size: 104, weight: 800, color: theme.ink,
      lineHeight: 1.16, maxLines: 3, maxHeight: 380, minSize: 62
    });
    if (brand) {
      drawText(ctx, brand, { x: PAD, y: H - 110, size: 28, weight: 400, color: theme.dim, maxLines: 1 });
    }
    return t;
  }

  function drawBody(ctx, card, ctx2) {
    const { theme, photo, tiles, index, total } = ctx2;
    paintBackdrop(ctx, theme, photo, { blur: 14, veil: 0.46, veilColor: theme.turnBg });
    pageMark(ctx, theme, index, total);

    // 사진이 없으면 글만 남으므로 시작 위치를 내려 화면 가운데로 모은다
    let y = (tiles && tiles.length) ? 170 : 330;
    if (card.step) {
      ctx.beginPath();
      ctx.arc(PAD + 38, y + 38, 38, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.font = '700 40px ' + FONT;
      ctx.fillStyle = theme.bg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(card.step), PAD + 38, y + 40);
      ctx.textAlign = 'left';
      y += 110;
    }
    const t = drawText(ctx, card.title, {
      x: PAD, y: y, size: 78, weight: 800, color: theme.ink,
      lineHeight: 1.16, maxLines: 3, maxHeight: 300, minSize: 52
    });
    let by = t.bottom + 46;
    if (card.body.length) {
      const b = drawText(ctx, card.body.join('\n'), {
        x: PAD, y: by, size: 40, weight: 400, color: theme.sub,
        lineHeight: 1.6, maxHeight: 300, minSize: 30
      });
      by = b.bottom;
    }
    if (!(tiles && tiles.length)) accentRule(ctx, theme, by + 60);
    layoutTiles(ctx, tiles, 760);
  }

  /** 글만 있는 장이 허전하지 않도록 아래에 짧은 강조선을 둔다 */
  function accentRule(ctx, theme, y) {
    ctx.fillStyle = hexToRgba(theme.accent, 0.5);
    ctx.fillRect(PAD, y, 120, 4);
  }

  function drawTurn(ctx, card, ctx2) {
    const { theme, index, total } = ctx2;
    ctx.fillStyle = theme.turnBg;
    ctx.fillRect(0, 0, W, H);
    pageMark(ctx, theme, index, total, theme.dim);
    const text = [card.title].concat(card.body || []).join('\n');
    drawText(ctx, text, {
      x: PAD, y: 400, size: 86, weight: 800, color: theme.name === '따뜻한 종이' ? '#FFFFFF' : theme.ink,
      lineHeight: 1.3, maxHeight: 560, minSize: 54
    });
  }

  function drawOutro(ctx, card, ctx2) {
    const { theme, photo, tiles, index, total } = ctx2;
    paintBackdrop(ctx, theme, photo, { blur: 14, veil: 0.5, veilColor: theme.turnBg });
    pageMark(ctx, theme, index, total);

    const top = (tiles && tiles.length) ? 230 : 330;
    const t = drawText(ctx, card.title, {
      x: PAD, y: top, size: 68, weight: 800, color: theme.ink,
      lineHeight: 1.24, maxLines: 3, maxHeight: 260, minSize: 46
    });
    let y = t.bottom + 50;
    ctx.fillStyle = hexToRgba(theme.accent, 0.35);
    ctx.fillRect(PAD, y, W - PAD * 2, 3);
    y += 50;
    if (card.body.length) {
      const b = drawText(ctx, card.body.join('\n'), {
        x: PAD, y: y, size: 40, weight: 400, color: theme.sub, lineHeight: 1.55, minSize: 30
      });
      y = b.bottom + 26;
    }
    if (card.cta) {
      drawText(ctx, card.cta, {
        x: PAD, y: y, size: 44, weight: 700, color: theme.accent, lineHeight: 1.45, minSize: 32
      });
    }
    if (tiles && tiles[0]) photoTile(ctx, tiles[0], 320, 850, 440, -1.5);
  }

  /**
   * 사진을 서로 겹치지 않게 나란히 놓는다. 폭 920(PAD 80 기준)을 사진 수만큼
   * 나누고 사이에 고정 간격을 둔다 — 살짝 기울이더라도 간격이 겹침을 막는다.
   */
  function layoutTiles(ctx, tiles, top) {
    if (!tiles || !tiles.length) return;
    const list = tiles.slice(0, 3);
    const gap = 28;
    const size = Math.floor((W - PAD * 2 - gap * (list.length - 1)) / list.length);
    const angles = [-2, 2, -1.5];
    list.forEach((img, i) => {
      const x = PAD + i * (size + gap);
      photoTile(ctx, img, x, top, size, angles[i % angles.length]);
    });
  }

  function pageMark(ctx, theme, index, total, color) {
    if (!total) return;
    ctx.font = '400 30px ' + FONT;
    ctx.fillStyle = color || theme.dim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText((index + 1) + ' / ' + total, W - PAD, 70);
    ctx.textAlign = 'left';
  }

  /* ───────── 바깥에서 쓰는 것 ───────── */

  /**
   * 카드 하나를 캔버스에 그린다.
   * opts: { theme, photo, tiles, index, total, brand }
   */
  function renderCard(canvas, card, opts) {
    const o = opts || {};
    const theme = THEMES[o.theme] || THEMES.night;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    const env = {
      theme: theme, photo: o.photo || null, tiles: o.tiles || [],
      index: o.index || 0, total: o.total || 0, brand: o.brand || ''
    };
    if (card.kind === 'hook') drawHook(ctx, card, env);
    else if (card.kind === 'turn') drawTurn(ctx, card, env);
    else if (card.kind === 'outro') drawOutro(ctx, card, env);
    else drawBody(ctx, card, env);
    return canvas;
  }

  /** 카드 순서대로 사진을 나눠 준다 — 배경 1장 + 타일 2장씩, 부족하면 돌려 쓴다 */
  function assignPhotos(cards, photos) {
    const list = photos || [];
    return cards.map((card, i) => {
      if (!list.length) return { photo: null, tiles: [] };
      const bg = list[i % list.length];
      if (card.kind === 'turn') return { photo: null, tiles: [] };
      if (card.kind === 'hook') return { photo: bg, tiles: [] };
      const tiles = [];
      const want = card.kind === 'outro' ? 1 : 2;
      for (let k = 1; k <= want; k++) tiles.push(list[(i + k) % list.length]);
      return { photo: bg, tiles: tiles };
    });
  }

  global.CarouselRender = {
    renderCard: renderCard, assignPhotos: assignPhotos,
    THEMES: THEMES, WIDTH: W, HEIGHT: H
  };
})(typeof window !== 'undefined' ? window : globalThis);
