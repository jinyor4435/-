#!/usr/bin/env node
/**
 * 카드뉴스 생성기를 단일 HTML로 묶는다 — 더블클릭으로 바로 열리게.
 * 사용법: node scripts/bundle-carousel.js [출력경로]
 *         (기본값 dist/carousel-single.html)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = process.argv[2] || 'dist/carousel-single.html';

let html = fs.readFileSync(path.join(root, 'carousel.html'), 'utf8');

// <script src="js/…"></script> 를 파일 내용으로 바꾼다
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_m, src) => {
  const code = fs.readFileSync(path.join(root, src), 'utf8');
  return `<script>\n/* ── ${src} ── */\n${code}\n</script>`;
});

if (/<script src=/.test(html)) {
  console.error('인라인하지 못한 script 태그가 남았습니다.');
  process.exit(1);
}

fs.mkdirSync(path.join(root, path.dirname(out)), { recursive: true });
fs.writeFileSync(path.join(root, out), html, 'utf8');
console.log('완료:', out, '(' + Math.round(Buffer.byteLength(html) / 1024) + ' KB)');
