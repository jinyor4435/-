# daily-poster
매일 정해진 시간에 `photos/` 폴더의 사진 1장을 골라 Claude가 일상 글을 쓰고, 앱에 게시합니다.

```bash
pip install -r requirements.txt && playwright install chromium
cp .env.example .env   # API 키 입력
python main.py once --dry   # 게시 없이 글 생성만 테스트
python main.py daemon       # config.json의 post_time에 매일 실행
```
- 게시된 사진은 `photos/used/`로 이동해 중복 게시를 막습니다.
- 앱 연동은 `adapters.py`의 `PlaywrightPoster` 선택자(TODO)를 채우거나 공식 API 어댑터를 추가하세요.
- 자동 게시는 앱의 이용약관을 확인하고, 본인 계정·본인 사진에만 사용하세요.

## 모바일(Android) 앱 연동 — Appium
1. 준비: Android 에뮬레이터/실기기(USB 디버깅), `npm i -g appium && appium driver install uiautomator2`, `appium` 실행
2. 콜펫에 미리 로그인해 두기 (`noReset`으로 로그인 유지)
3. 패키지명 확인: `adb shell pm list packages | grep -i <이름>` → `config.json`의 `appium.app_package`
4. 글쓰기 화면까지 손으로 이동한 뒤 `python main.py inspect` → 출력된 id/text/desc로 `appium.steps`의 TODO 채우기 (화면마다 반복)
5. `python main.py once` 로 1회 실제 게시 테스트 → 문제 없으면 `daemon`
