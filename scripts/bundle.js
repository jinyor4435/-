#!/usr/bin/env node
/**
 * 앱 전체를 단일 HTML 파일로 번들한다 (CSS·JS·내장 라이브러리 인라인).
 * 사용법:
 *   node scripts/bundle.js dist/app-single.html          # 완전한 독립 HTML (더블클릭 실행용)
 *   node scripts/bundle.js out.html --fragment           # doctype/html/head/body 없는 조각 (호스팅 래퍼용)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const css = read('css/style.css');
/**
 * 일부 호스팅은 U+FFFD(대체 문자)를 깨진 인코딩으로 보고 업로드를 거부한다.
 * docx 라이브러리는 문자열 리터럴 "\uFFFD"를 실제 문자로 담고 있으므로,
 * 의미가 같은 이스케이프 표기로 바꿔 ASCII 안전하게 만든다.
 */
function sanitize(js) {
  return js.replace(/"\uFFFD"/g, '"\\uFFFD"').replace(/'\uFFFD'/g, "'\\uFFFD'");
}

const scripts = [
  'js/vendor/docx.iife.js',
  'js/vendor/pptxgen.bundle.js',
  // pdf.js: 워커 스크립트를 함께 넣으면 blob·eval 없이 메인 스레드에서 동작한다 (CSP 안전)
  'js/vendor/pdf.worker.min.js',
  'js/vendor/pdf.min.js',
  'js/vendor/cmaps-ko.js',
  'js/fileparse.js',
  'js/programs.js',
  'js/prompts.js',
  'js/hwpx.js',
  'js/llm.js',
  'js/export.js',
  'js/app.js'
].map((f) => `<script>\n/* ── ${f} ── */\n${sanitize(read(f))}\n</script>`).join('\n');

const bodyMarkup = `
<header id="topbar">
  <div class="brand">🏛️ 딥테크 정부지원사업 계획서 생성기</div>
  <div class="proj-controls">
    <select id="projectSelect" title="프로젝트 선택"></select>
    <button id="btnNewProject" class="btn small">＋ 새 프로젝트</button>
    <button id="btnDeleteProject" class="btn small danger">삭제</button>
    <span id="saveStatus" class="save-status"></span>
  </div>
</header>
<div id="layout">
  <nav id="sidebar">
    <div class="step-list" id="stepList"></div>
    <div class="sidebar-footer">
      <p>데이터는 이 브라우저에만 저장 · API 키를 넣으면 자동 생성</p>
    </div>
  </nav>
  <main id="main"></main>
</div>`;

const core = `<title>딥테크 정부지원사업 계획서 생성기</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${css}
</style>
${bodyMarkup}
${scripts}`;

const outArg = process.argv[2];
const fragment = process.argv.includes('--fragment');
if (!outArg) { console.error('사용법: node scripts/bundle.js <출력파일> [--fragment]'); process.exit(1); }

const html = fragment ? core : `<!doctype html>\n<html lang="ko">\n${core}\n</html>`;

// 번들 무결성 검사: 남은 대체 문자나 짝 없는 서로게이트가 있으면 배포가 거부된다.
let lone = 0;
for (let i = 0; i < html.length; i++) {
  const c = html.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF) {
    const n = html.charCodeAt(i + 1);
    if (n >= 0xDC00 && n <= 0xDFFF) i++; else lone++;
  } else if (c >= 0xDC00 && c <= 0xDFFF) lone++;
}
const bad = (html.match(/�/g) || []).length;
if (lone || bad) {
  console.error(`번들 검사 실패: 짝 없는 서로게이트 ${lone}개, 대체 문자 ${bad}개`);
  process.exit(1);
}

const out = path.resolve(outArg);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`번들 완료: ${out} (${(html.length / 1024).toFixed(0)} KB, fragment=${fragment})`);
