// scripts/naver_draft.js
// 초안 JSON을 받아 네이버 블로그 스마트에디터에 제목·본문·사진·태그·지도·동영상·소제목 서식까지
// 자동으로 채우고 "임시저장"까지만 수행한다. 발행은 사람이 한다 — installPublishGuard()가
// 진짜 발행 버튼 클릭을 코드로 원천 차단한다 (이 가드는 어떤 경우에도 제거하지 않는다).
//
// 사용법:
//   node scripts/naver_draft.js drafts/<파일>.json [--dry-run]
//
// --dry-run: 저장(임시저장) 버튼 클릭만 생략한다. 셀렉터 디버깅 중에는 항상 이 플래그로 먼저 돌린다.
//
// ⚠️ 셀렉터 신뢰도 안내
// 아래 SELECTORS 중 "실측 확인됨"이라고 주석 붙은 것들은 CLAUDE.md에 기록된, 여러 시간 디버깅으로
// 검증된 값이다. 그 외("추정 — probe로 검증 필요")는 이번 세션에서 실제 네이버 화면에 접근해 확인할
// 수 없어 채워 넣은 잠정값이다. 첫 실행은 반드시 --dry-run으로, 실패하면 scripts/probe_selectors.js로
// 실제 DOM을 떠서 실측 후 이 파일의 SELECTORS를 고친다. 추측으로 계속 고치지 말 것.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const USER_DATA_DIR = path.join(ROOT, 'naver-profile');
const DRAFTS_DIR = path.join(ROOT, 'drafts');

const SELECTORS = {
  // --- 실측 확인됨 (CLAUDE.md 기록) ---
  titleEditable: '.se-title-text',
  bodyTextParagraph: '.se-section-text p.se-text-paragraph',
  continuePopupCancel: '.se-popup-button-cancel',
  quoteButton: '.se-insert-quotation-default-toolbar-button',
  dividerButton: '.se-insert-horizontal-line-default-toolbar-button',
  textFormatDropdownButton: '.se-text-format-toolbar-button',
  tagInput: 'input#tag-input',
  realPublishButton: 'button[data-testid="seOnePublishBtn"]', // 이 값은 가드 대상이므로 절대 변경 금지

  // --- 추정 — probe_selectors.js로 검증 필요 (네이버가 마크업을 자주 바꾼다) ---
  publishPanelOpenButton: 'button:has-text("발행")',
  saveDraftButton: 'button:has-text("저장")',
  imageToolbarButton: 'button[data-testid="seOnePhotoBtn"], .se-image-toolbar-button',
  videoToolbarButton: 'button[data-testid="seOneVideoBtn"], .se-video-toolbar-button',
  videoAddButtonInPopup: 'button:has-text("동영상 추가")',
  videoTitleInput: 'input[placeholder*="제목"]',
  videoPopupCloseButton: '.se-popup-button-close, button[aria-label="닫기"]',
  mapToolbarButton: 'button[data-testid="seOnePlaceBtn"], .se-place-toolbar-button',
  mapSearchInput: 'input[placeholder*="장소"], input[placeholder*="검색"]',
  mapResultItem: '.se-place-search-result-item, li[class*="search-item"]',
  mapAddButton: 'button:has-text("추가")',
  mapConfirmButton: 'button:has-text("확인")',
  mapPopupCloseButton: '.se-popup-button-close, button[aria-label="닫기"]',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const draftPath = args.find((a) => !a.startsWith('--'));
  if (!draftPath) {
    console.error('사용법: node scripts/naver_draft.js drafts/<파일>.json [--dry-run]');
    process.exit(1);
  }
  return { draftPath, dryRun };
}

function loadDraft(draftPath) {
  const full = path.isAbsolute(draftPath) ? draftPath : path.join(ROOT, draftPath);
  const draft = JSON.parse(fs.readFileSync(full, 'utf-8'));
  if (!draft.title || !Array.isArray(draft.blocks)) {
    throw new Error('초안 JSON에 title 또는 blocks가 없습니다.');
  }
  return draft;
}

// 절대 규칙 2: 발행 금지. 캡처 단계 리스너로 진짜 발행 버튼 클릭을 코드 차원에서 원천 차단한다.
async function installPublishGuard(page) {
  await page.addInitScript((selector) => {
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (target && target.closest && target.closest(selector)) {
          e.stopPropagation();
          e.preventDefault();
          console.warn('[publish-guard] 발행 버튼 클릭이 차단되었습니다. 이 툴은 임시저장까지만 합니다.');
        }
      },
      true // capture phase — 버블링 전에 가로챈다
    );
  }, SELECTORS.realPublishButton);
}

async function dismissContinuePopup(page) {
  const cancelBtn = page.locator(SELECTORS.continuePopupCancel);
  if (await cancelBtn.count() > 0 && (await cancelBtn.first().isVisible().catch(() => false))) {
    await cancelBtn.first().click();
    await page.waitForTimeout(300);
  }
}

async function insertKoreanText(page, text) {
  // 한글은 keyboard.type() 대신 insertText()를 쓴다 (IME 조합 꼬임으로 오탈자 발생 방지).
  // 이모지는 텍스트와 분리해 별도 호출로 넣는다 (함께 넣으면 이모지 뒤 텍스트가 유실된다).
  const emojiRegex = /(\p{Extended_Pictographic})/gu;
  const parts = text.split(emojiRegex).filter((p) => p.length > 0);
  for (const part of parts) {
    await page.keyboard.insertText(part);
  }
}

async function setParagraphFormat(page, label) {
  // 소제목 서식은 볼드 토글이 아니라 문단 서식 드롭다운으로 적용한다 (스마트에디터에서 선택영역이
  // 안 잡혀 볼드 토글은 실패한다). 캐럿만 놓여도 문단 전체에 적용된다.
  await page.locator(SELECTORS.textFormatDropdownButton).first().click();
  await page.waitForTimeout(200);
  await page.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(200);

  // 적용 검증: 드롭다운 라벨을 다시 읽어 확인
  const currentLabel = await page.locator(SELECTORS.textFormatDropdownButton).first().innerText().catch(() => '');
  if (!currentLabel.includes(label)) {
    console.warn(`⚠️ 문단 서식이 "${label}"로 적용됐는지 확인 불가 (현재 라벨: "${currentLabel}")`);
    return false;
  }
  return true;
}

async function setFontSize(page, sizeLabel) {
  // 순서가 핵심: 서식 → 크기 → 텍스트 입력. 입력 후 바꾸면 이미 쓴 글자에는 적용되지 않는다.
  const sizeDropdown = page.locator('.se-font-size-toolbar-button, [class*="font-size"]').first();
  if (await sizeDropdown.count() === 0) {
    console.warn('⚠️ 글자 크기 드롭다운을 찾지 못했습니다 (probe로 확인 필요) — 기본 크기로 진행합니다.');
    return false;
  }
  await sizeDropdown.click();
  await page.waitForTimeout(200);
  await page.getByText(sizeLabel, { exact: false }).first().click();
  await page.waitForTimeout(200);
  return true;
}

async function insertBodyBlocks(page, blocks, autoResult) {
  const bodyArea = page.locator(SELECTORS.bodyTextParagraph).first();
  await bodyArea.click();

  let subtitleOk = true;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const next = blocks[i + 1];

    if (block.type === 'text') {
      await insertKoreanText(page, block.text);
      if (next && next.type === 'text') {
        await page.keyboard.press('Enter'); // 연속 text 블록은 빈 줄 없이 붙으므로 Enter 한 번 더
      } else {
        await page.keyboard.press('Enter');
      }
    } else if (block.type === 'subtitle') {
      const formatOk = await setParagraphFormat(page, '소제목');
      const sizeOk = await setFontSize(page, '19');
      subtitleOk = subtitleOk && formatOk && sizeOk;
      await insertKoreanText(page, block.text);
      await page.keyboard.press('Enter');
      await setParagraphFormat(page, '본문'); // 다음 문단은 본문으로 복귀
    } else if (block.type === 'quote') {
      await page.locator(SELECTORS.quoteButton).first().click();
      await page.waitForTimeout(300);
      await insertKoreanText(page, block.text);
      await page.keyboard.press('Enter');
    } else if (block.type === 'divider') {
      await page.locator(SELECTORS.dividerButton).first().click();
      await page.waitForTimeout(300);
    } else if (block.type === 'image') {
      await insertImageBlock(page, block, autoResult);
    } else {
      console.warn(`⚠️ 알 수 없는 블록 타입: ${block.type} — 건너뜁니다.`);
    }
  }

  autoResult.subtitle = subtitleOk ? '✅ 성공' : '❗수동 필요 (소제목 서식 적용 확인 안 됨)';
}

async function insertImageBlock(page, block, autoResult) {
  const imagePath = path.isAbsolute(block.path) ? block.path : path.join(ROOT, block.path);
  if (!fs.existsSync(imagePath)) {
    console.warn(`⚠️ 이미지 파일 없음: ${imagePath} — 건너뜁니다.`);
    autoResult.images = autoResult.images || [];
    autoResult.images.push(`❗수동 필요 (${path.basename(imagePath)} 없음)`);
    return;
  }
  await page.locator(SELECTORS.imageToolbarButton).first().click();
  await page.waitForTimeout(300);

  const fileChooserPromise = page.waitForEvent('filechooser');
  const [fileChooser] = await Promise.all([fileChooserPromise]);
  await fileChooser.setFiles(imagePath);
  await page.waitForTimeout(1500);

  if (block.caption) {
    await page.keyboard.press('Enter');
    await insertKoreanText(page, block.caption);
    await page.keyboard.press('Enter');
  }

  autoResult.images = autoResult.images || [];
  autoResult.images.push(`✅ ${path.basename(imagePath)}`);
}

async function insertVideoAfterFirstText(page, video, autoResult) {
  if (!video || !video.path) return;
  const videoPath = path.isAbsolute(video.path) ? video.path : path.join(ROOT, video.path);
  if (!fs.existsSync(videoPath)) {
    autoResult.video = `❗수동 필요 (${video.path} 없음)`;
    return;
  }
  const title = (video.title || '').slice(0, 40);

  try {
    await page.locator(SELECTORS.videoToolbarButton).first().click();
    await page.waitForTimeout(300);

    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.locator(SELECTORS.videoAddButtonInPopup).first().click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(videoPath);

    console.log('[video] 업로드 중 — 수 분 걸릴 수 있습니다. 대기합니다...');
    await page.waitForTimeout(5000);

    if (title) {
      const titleInput = page.locator(SELECTORS.videoTitleInput).first();
      if (await titleInput.count() > 0) {
        await titleInput.fill(title);
      }
    }

    // 팝업을 확실히 닫는다 — 안 닫으면 dim 레이어가 남아 이후 클릭이 전부 실패한다.
    const closeBtn = page.locator(SELECTORS.videoPopupCloseButton).first();
    if (await closeBtn.count() > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click();
    } else {
      // 폴백: DOM에서 dim 레이어를 강제 제거
      await page.evaluate(() => {
        document.querySelectorAll('[class*="dimmed"], [class*="dim-layer"]').forEach((el) => el.remove());
      });
    }

    autoResult.video = `✅ 업로드 및 제목(${title || '기본값'}) 설정`;
  } catch (err) {
    console.warn('⚠️ 동영상 첨부 실패:', err.message);
    autoResult.video = `❗수동 필요 (오류: ${err.message})`;
  }
}

async function attachMap(page, place, autoResult) {
  if (!place || !place.query) return;
  try {
    await page.locator(SELECTORS.mapToolbarButton).first().click();
    await page.waitForTimeout(300);

    const searchInput = page.locator(SELECTORS.mapSearchInput).first();
    await searchInput.fill(place.query);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const results = page.locator(SELECTORS.mapResultItem);
    const count = await results.count();

    if (count === 0) {
      autoResult.map = `❗수동 필요 (검색 결과 0건: "${place.query}")`;
      const closeBtn = page.locator(SELECTORS.mapPopupCloseButton).first();
      if (await closeBtn.count() > 0) await closeBtn.click();
      return;
    }

    const normalize = (s) => (s || '').replace(/\s+/g, '');
    let targetIndex = 0;
    if (place.name) {
      let found = -1;
      for (let i = 0; i < count; i++) {
        const text = await results.nth(i).innerText().catch(() => '');
        if (normalize(text) === normalize(place.name)) { found = i; break; }
      }
      if (found === -1) {
        for (let i = 0; i < count; i++) {
          const text = await results.nth(i).innerText().catch(() => '');
          if (normalize(text).includes(normalize(place.name))) { found = i; break; }
        }
      }
      targetIndex = found === -1 ? 0 : found;
    }

    const targetItem = results.nth(targetIndex);
    await targetItem.hover(); // "추가" 버튼은 hover 전에는 not visible
    const addBtn = targetItem.locator(SELECTORS.mapAddButton).first();
    try {
      await addBtn.click({ timeout: 3000 });
    } catch {
      await addBtn.evaluate((el) => el.click()); // 폴백: DOM 직접 click
    }
    await page.waitForTimeout(500);

    const confirmBtn = page.locator(SELECTORS.mapConfirmButton).first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(500);

    // 장소 팝업은 Escape로 안 닫힌다 — 반드시 닫기 버튼을 눌러야 dim 레이어가 안 남는다.
    const closeBtn = page.locator(SELECTORS.mapPopupCloseButton).first();
    if (await closeBtn.count() > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click();
    } else {
      await page.evaluate(() => {
        document.querySelectorAll('[class*="dimmed"], [class*="dim-layer"]').forEach((el) => el.remove());
      });
    }

    autoResult.map = `✅ "${place.name || place.query}" 첨부`;
  } catch (err) {
    console.warn('⚠️ 지도 첨부 실패:', err.message);
    autoResult.map = `❗수동 필요 (오류: ${err.message})`;
  }
}

async function setTitle(page, title, draftForVerify) {
  // 입력 순서 원칙: 본문 전체 먼저 → 제목은 맨 마지막 (레이스 컨디션으로 섞임 방지)
  const titleEl = page.locator(SELECTORS.titleEditable).first();
  await titleEl.click();
  await insertKoreanText(page, title);

  const actual = await titleEl.innerText().catch(() => '');
  if (actual.trim() !== title.trim()) {
    console.warn(`⚠️ 제목 불일치 감지 — 재입력합니다. (기대: "${title}" / 실제: "${actual}")`);
    await titleEl.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await insertKoreanText(page, title);
  }
}

async function attachTags(page, tags, autoResult) {
  if (!tags || tags.length === 0) return;
  const limited = tags.slice(0, 30);

  await page.locator(SELECTORS.publishPanelOpenButton).first().click();
  await page.waitForTimeout(500);

  const tagInput = page.locator(SELECTORS.tagInput);
  if (await tagInput.count() === 0) {
    autoResult.tags = '❗수동 필요 (태그 입력창을 찾지 못함 — probe로 확인 필요)';
    return;
  }

  for (const rawTag of limited) {
    const tag = rawTag.replace(/^#/, '').trim();
    if (!tag) continue;
    await tagInput.fill(tag);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }

  // 태그 검증: 칩 클래스는 해시가 바뀌므로 의존하지 않고, 태그 영역 텍스트를 #로 쪼개 센다.
  const tagAreaText = await page.locator('[class*="tag"]').first().innerText().catch(() => '');
  const confirmedCount = (tagAreaText.match(/#/g) || []).length;
  autoResult.tags = confirmedCount >= limited.length
    ? `✅ ${confirmedCount}개 확정`
    : `❗수동 필요 (기대 ${limited.length}개 중 ${confirmedCount}개만 확인됨)`;

  // 패널 안에 진짜 발행 버튼이 있다 — installPublishGuard()가 이미 클릭을 차단하고 있으므로
  // 여기서는 패널만 닫는다 (Escape). 발행 버튼을 직접 클릭하는 코드는 절대 추가하지 않는다.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function saveDraft(page, dryRun, autoResult) {
  if (dryRun) {
    console.log('[dry-run] 저장(임시저장) 버튼 클릭을 생략합니다.');
    autoResult.save = '⏭️ dry-run (저장 생략)';
    return;
  }
  const saveBtn = page.locator(SELECTORS.saveDraftButton).first();
  await saveBtn.click();
  await page.waitForTimeout(1500);
  autoResult.save = '✅ 임시저장 클릭';
}

async function verifyDraft(page, draft, dryRun) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const stamp = Date.now();

  const screenshotPath = path.join(DRAFTS_DIR, `verify_${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const titleText = await page.locator(SELECTORS.titleEditable).first().innerText().catch(() => '(제목 추출 실패)');
  const bodyTexts = await page.locator(SELECTORS.bodyTextParagraph).allInnerTexts().catch(() => []);
  const bodyFull = bodyTexts.join('\n');

  const dumpPath = path.join(DRAFTS_DIR, `verify_${stamp}.txt`);
  fs.writeFileSync(dumpPath, `=== 제목 ===\n${titleText}\n\n=== 본문 ===\n${bodyFull}\n`, 'utf-8');

  const expectedBody = draft.blocks.filter((b) => b.text).map((b) => b.text).join('\n');
  const titleMatch = titleText.trim() === draft.title.trim();
  const bodyFirstLineOk = bodyFull.trim().startsWith(expectedBody.trim().slice(0, 10));

  console.log('\n=== 이중 검증 ===');
  console.log(`스크린샷: ${screenshotPath}`);
  console.log(`텍스트 덤프: ${dumpPath}`);
  console.log(`제목 일치: ${titleMatch ? '✅' : '❌ 불일치 — 원인 확인 필요'}`);
  console.log(`본문 첫 줄 포함 여부: ${bodyFirstLineOk ? '✅' : '❌ 누락 가능성 — 원인 확인 필요'}`);

  return { titleMatch, bodyFirstLineOk, screenshotPath, dumpPath };
}

function dumpManualFallback(draft, reason) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const outPath = path.join(DRAFTS_DIR, `manual_fallback_${Date.now()}.md`);
  const lines = [
    `# 수동 붙여넣기용 원고`,
    `\n실패 사유: ${reason}\n`,
    `## 제목\n${draft.title}\n`,
    `## 본문`,
  ];
  for (const b of draft.blocks) {
    if (b.type === 'image') lines.push(`\n[사진: ${b.path}]${b.caption ? ` — ${b.caption}` : ''}`);
    else if (b.type === 'divider') lines.push('\n---');
    else lines.push(`\n${b.text || ''}`);
  }
  if (draft.tags) lines.push(`\n## 태그\n${draft.tags.join(', ')}`);
  if (draft.place) lines.push(`\n## 지도\n${draft.place.name || draft.place.query}`);
  if (draft.video) lines.push(`\n## 동영상\n${draft.video.path} (제목: ${draft.video.title || ''})`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`\n📄 수동 붙여넣기용 원고를 저장했습니다: ${outPath}`);
}

async function main() {
  const { draftPath, dryRun } = parseArgs();
  const draft = loadDraft(draftPath);

  const blogId = process.env.NAVER_BLOG_ID || 'jinyor2';
  const writeUrl = `https://blog.naver.com/${blogId}?Redirect=Write`;

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 }, // 1400 이하는 속성 툴바가 잘려 서식 버튼이 불안정해진다
  });
  const page = context.pages()[0] || (await context.newPage());

  await installPublishGuard(page); // 절대 규칙 2 — 어떤 경우에도 제거하지 않는다

  const autoResult = {};
  let failureCount = 0;

  try {
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissContinuePopup(page);

    // 본문 전체 먼저
    await insertBodyBlocks(page, draft.blocks, autoResult);
    await insertVideoAfterFirstText(page, draft.video, autoResult);
    await attachMap(page, draft.place, autoResult);

    // 제목은 맨 마지막
    await setTitle(page, draft.title, draft);

    await attachTags(page, draft.tags, autoResult);
    await saveDraft(page, dryRun, autoResult);

    const verification = await verifyDraft(page, draft, dryRun);
    if (!verification.titleMatch || !verification.bodyFirstLineOk) {
      failureCount++;
    }
  } catch (err) {
    console.error('❌ 초안 작성 중 오류:', err);
    failureCount++;
  }

  console.log('\n=== 자동 처리 결과 ===');
  console.log(`태그: ${autoResult.tags || '❗수동 필요 (미실행)'}`);
  console.log(`지도: ${autoResult.map || '(place 미지정)'}`);
  console.log(`동영상: ${autoResult.video || '(video 미지정)'}`);
  console.log(`소제목 서식: ${autoResult.subtitle || '❗수동 필요 (미실행)'}`);
  console.log(`저장: ${autoResult.save || '❗수동 필요 (미실행)'}`);
  if (autoResult.images) {
    console.log(`사진: ${autoResult.images.join(', ')}`);
  }

  if (failureCount >= 3) {
    dumpManualFallback(draft, '이중 검증 3회 이상 실패 — 수동 붙여넣기 권장');
  }

  console.log('\n브라우저는 열어둔 채로 둡니다 — 직접 확인 후 닫아주세요.');
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
