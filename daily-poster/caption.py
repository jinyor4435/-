"""사진을 보고 Claude로 일상 글을 생성한다."""
import base64, mimetypes, os
from pathlib import Path
import anthropic

def generate_caption(photo: Path, cfg: dict) -> str:
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 환경변수 사용
    media_type = mimetypes.guess_type(photo)[0] or "image/jpeg"
    data = base64.standard_b64encode(photo.read_bytes()).decode()
    prompt = (
        f"이 사진에 어울리는 SNS 일상 게시글을 {cfg['language']}로 써줘.\n"
        f"문체: {cfg['tone']}\n"
        "사진에 보이는 것만 근거로 쓰고, 없는 사실을 지어내지 마. 본문만 출력해."
    )
    msg = client.messages.create(
        model=os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5"),
        max_tokens=400,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
            {"type": "text", "text": prompt},
        ]}],
    )
    text = msg.content[0].text.strip()
    return f"{text}\n\n{' '.join(cfg.get('hashtags', []))}".strip()
