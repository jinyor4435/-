"""안드로이드 앱을 Appium으로 조작해 게시한다. 터치 순서는 config.json의 appium.steps로 정의."""
import subprocess, time
from pathlib import Path
from adapters import Poster

def _locator(by):
    from appium.webdriver.common.appiumby import AppiumBy
    return {"id": AppiumBy.ID, "xpath": AppiumBy.XPATH, "text": AppiumBy.ANDROID_UIAUTOMATOR,
            "desc": AppiumBy.ACCESSIBILITY_ID, "class": AppiumBy.CLASS_NAME}[by]

def _value(by, value):
    # text 로케이터는 UiAutomator 문법으로 변환
    return f'new UiSelector().textContains("{value}")' if by == "text" else value

def connect(acfg):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    opts = UiAutomator2Options().load_capabilities({
        "platformName": "Android",
        "appium:deviceName": acfg.get("device", "Android"),
        "appium:appPackage": acfg["app_package"],
        "appium:appActivity": acfg.get("app_activity", ""),
        "appium:noReset": True,   # 로그인 상태 유지
        "appium:newCommandTimeout": 300,
    })
    return webdriver.Remote(acfg.get("server", "http://127.0.0.1:4723"), options=opts)

class AppiumPoster(Poster):
    def __init__(self, acfg):
        self.cfg = acfg

    def _push_photo(self, driver, photo: Path):
        remote = f"/sdcard/Pictures/dailyposter/{photo.name}"
        driver.push_file(remote, source_path=str(photo))
        driver.execute_script("mobile: shell", {"command": "am", "args": [
            "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
            "-d", f"file://{remote}"]})  # 갤러리에 즉시 노출

    def post(self, photo, text):
        driver = connect(self.cfg)
        try:
            self._push_photo(driver, photo)
            time.sleep(2)
            for i, s in enumerate(self.cfg["steps"]):
                act = s["action"]
                if act == "wait":
                    time.sleep(s.get("seconds", 1)); continue
                if act == "back":
                    driver.back(); continue
                el = driver.find_element(_locator(s["by"]), _value(s["by"], s["value"]))
                if act == "tap":
                    el.click()
                elif act == "type":
                    el.click(); el.send_keys(s["text"].replace("{caption}", text))
                else:
                    raise ValueError(f"알 수 없는 action: {act}")
                time.sleep(s.get("after", 1))
        finally:
            driver.quit()

def inspect(acfg):
    """현재 화면의 UI 요소(id/text/desc)를 출력 → steps 작성용."""
    import xml.etree.ElementTree as ET
    driver = connect(acfg)
    try:
        root = ET.fromstring(driver.page_source)
        for n in root.iter():
            a = n.attrib
            if a.get("clickable") == "true" or a.get("text"):
                print(f"{a.get('class','').split('.')[-1]:18} id={a.get('resource-id','')!s:45} "
                      f"text={a.get('text','')!r} desc={a.get('content-desc','')!r}")
    finally:
        driver.quit()
