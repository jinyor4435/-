// scripts/naver_login.js
// 네이버 로그인 세션을 1회 생성한다. 비밀번호는 저장하지 않는다 — 브라우저 창에서
// 사용자가 직접 로그인하면, 그 세션 쿠키만 naver-profile/ (persistentContext 유저 데이터 디렉토리)에 남는다.
// naver-profile/ 폴더는 로그인 세션이므로 외부 공유 금지.

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const USER_DATA_DIR = path.join(__dirname, '..', 'naver-profile');

function waitForEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('브라우저를 엽니다. 네이버 계정으로 직접 로그인해주세요 (아이디: jinyor2).');
  console.log('이 스크립트는 비밀번호를 저장하지 않습니다 — 로그인 세션 쿠키만 naver-profile/ 에 저장됩니다.');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 },
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' });

  await waitForEnter('\n로그인을 완료하셨으면 이 터미널에서 Enter를 눌러주세요...\n');

  // 로그인 확인: 네이버 메인에서 로그인 상태 쿠키(NID_AUT) 존재 여부로 판단
  const cookies = await context.cookies('https://www.naver.com');
  const hasAuth = cookies.some((c) => c.name === 'NID_AUT');

  if (!hasAuth) {
    console.log('⚠️ 로그인 세션을 확인하지 못했습니다. 로그인이 실제로 완료됐는지 다시 확인해주세요.');
    console.log('   (2단계 인증 등으로 시간이 걸렸다면 이 스크립트를 다시 실행해 이어서 로그인해도 됩니다.)');
  } else {
    console.log('✅ 로그인 세션이 저장되었습니다. 이제 /write 로 초안 작성을 진행할 수 있습니다.');
  }

  await context.close();
}

main().catch((err) => {
  console.error('로그인 세션 생성 중 오류:', err);
  process.exit(1);
});
