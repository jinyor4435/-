"""앱별 게시 어댑터. 새 앱은 Poster를 상속해 post()만 구현하면 된다."""
import os
from pathlib import Path

class Poster:
    def post(self, photo: Path, text: str) -> None:
        raise NotImplementedError

class DummyPoster(Poster):
    """실제 게시 없이 결과만 출력 (테스트용)."""
    def post(self, photo, text):
        print(f"[DRY-RUN] 사진: {photo.name}\n---\n{text}\n---")

class PlaywrightPoster(Poster):
    """웹 앱용 브라우저 자동화 템플릿. 선택자(TODO)를 대상 앱에 맞게 채운다.
    로그인 세션은 state.json에 저장해 매번 로그인하지 않는다."""
    STATE = Path("state.json")
    LOGIN_URL = "TODO: https://example.com/login"
    WRITE_URL = "TODO: https://example.com/write"

    def post(self, photo, text):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(self.STATE) if self.STATE.exists() else None)
            page = ctx.new_page()
            if not self.STATE.exists():
                page.goto(self.LOGIN_URL)
                page.fill("TODO: 아이디 선택자", os.environ["APP_USERNAME"])
                page.fill("TODO: 비밀번호 선택자", os.environ["APP_PASSWORD"])
                page.click("TODO: 로그인 버튼 선택자")
                page.wait_for_load_state("networkidle")
                ctx.storage_state(path=str(self.STATE))
            page.goto(self.WRITE_URL)
            page.set_input_files("TODO: input[type=file] 선택자", str(photo))
            page.fill("TODO: 글 입력 선택자", text)
            page.click("TODO: 게시 버튼 선택자")
            page.wait_for_load_state("networkidle")
            browser.close()

def make_poster(cfg):
    if cfg["adapter"] == "appium":
        from appium_poster import AppiumPoster
        return AppiumPoster(cfg["appium"])
    return {"dummy": DummyPoster, "playwright": PlaywrightPoster}[cfg["adapter"]]()
