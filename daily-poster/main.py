"""사용법: python main.py once [--dry] | daemon | inspect(현재 화면 요소 출력)"""
import json, shutil, sys, time
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from caption import generate_caption
from adapters import make_poster, DummyPoster

EXT = {".jpg", ".jpeg", ".png", ".webp"}

def next_photo(cfg):
    files = sorted(p for p in Path(cfg["photos_dir"]).iterdir()
                   if p.is_file() and p.suffix.lower() in EXT)
    return files[0] if files else None

def run_once(cfg, dry=False):
    photo = next_photo(cfg)
    if not photo:
        print("올릴 사진이 없습니다. photos/ 폴더를 채워주세요."); return
    text = generate_caption(photo, cfg)
    poster = DummyPoster() if dry else make_poster(cfg)
    poster.post(photo, text)
    if not dry:
        used = Path(cfg["used_dir"]); used.mkdir(parents=True, exist_ok=True)
        shutil.move(str(photo), used / photo.name)  # 중복 게시 방지

def daemon(cfg):
    last = None
    while True:
        now = datetime.now()
        if now.strftime("%H:%M") == cfg["post_time"] and last != now.date():
            try: run_once(cfg); last = now.date()
            except Exception as e: print("실패:", e)
        time.sleep(20)

if __name__ == "__main__":
    load_dotenv()
    cfg = json.load(open("config.json", encoding="utf-8"))
    cmd = sys.argv[1] if len(sys.argv) > 1 else "once"
    if cmd == "inspect":
        from appium_poster import inspect; inspect(cfg["appium"]); sys.exit()
    daemon(cfg) if cmd == "daemon" else run_once(cfg, dry="--dry" in sys.argv)
