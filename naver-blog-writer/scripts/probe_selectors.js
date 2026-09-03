// scripts/probe_selectors.js
// 셀렉터가 깨졌을 때 "추측으로 고치지 말고" 실제 DOM을 떠서 확인하기 위한 읽기 전용 진단 스크립트.
// 클릭/입력 등 상태를 바꾸는 동작은 하지 않는다 (드롭다운처럼 열어야 보이는 요소는 옵션 --click-first 로만 예외 허용).
//
// 사용법:
//   node scripts/probe_selectors.js <URL> [selector1] [selector2] ...
//   node scripts/probe_selectors.js <URL> --click-first "<열기용 selector>" <selector1> ...
//
// 인자 없이 selector만 없으면 에디터 툴바 전반(class에 'toolbar' 또는 'se-' 포함)을 덤프한다.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, '..', 'naver-profile');
const OUT_DIR = path.join(__dirname, '..', 'drafts');

async function main() {
  const args = process.argv.slice(2);
  const url = args[0];
  if (!url) {
    console.error('사용법: node scripts/probe_selectors.js <URL> [selector...]');
    process.exit(1);
  }

  let clickFirst = null;
  let rest = args.slice(1);
  if (rest[0] === '--click-first') {
    clickFirst = rest[1];
    rest = rest.slice(2);
  }
  const selectors = rest;

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 },
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  if (clickFirst) {
    console.log(`[probe] --click-first: ${clickFirst} 클릭 (드롭다운 등을 열기 위한 예외 동작)`);
    await page.locator(clickFirst).first().click();
    await page.waitForTimeout(500);
  }

  const report = [];

  if (selectors.length === 0) {
    console.log('[probe] selector 미지정 — 툴바 전반(class에 toolbar 또는 se- 포함)을 덤프합니다.');
    const html = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[class*="toolbar"], [class*="se-"]'));
      return nodes.slice(0, 200).map((n) => ({
        tag: n.tagName,
        class: n.className,
        text: (n.textContent || '').trim().slice(0, 40),
        outerHTML: n.outerHTML.slice(0, 300),
      }));
    });
    report.push({ selector: '[class*="toolbar"], [class*="se-"]', matches: html.length, elements: html });
  } else {
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      const elements = [];
      const max = Math.min(count, 20);
      for (let i = 0; i < max; i++) {
        const el = page.locator(sel).nth(i);
        const isVisible = await el.isVisible().catch(() => false);
        const outerHTML = await el.evaluate((n) => n.outerHTML.slice(0, 500)).catch(() => '(evaluate 실패)');
        elements.push({ index: i, visible: isVisible, outerHTML });
      }
      report.push({ selector: sel, matches: count, elements });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `probe_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[probe] 결과 저장: ${outFile}`);
  console.log('[probe] 브라우저는 열어둔 채로 둡니다 — 직접 확인 후 터미널에서 Ctrl+C로 종료하세요.');
}

main().catch((err) => {
  console.error('probe 중 오류:', err);
  process.exit(1);
});
