#!/usr/bin/env python3
"""카드뉴스(캐러셀) 초안 검사기.

사람 눈으로는 반드시 새는 것들 — 글자 수, 장당 메시지 수, "하지만" 전환의
위치, 전문용어, CTA 개수 — 을 기계적으로 잡아준다.

입력은 SKILL.md의 출력 형식을 따르는 마크다운 파일이다.

    ## 1 · 훅
    첫 장에서 이미 졌습니다

    ## 2 · 문제
    ...

`###`로 시작하는 절(캡션·디자인 메모)은 검사 대상이 아니다.

고치기 요청을 받았을 때는 사용자가 붙여넣은 초안을 그대로 넣어도 된다.
다음 표기를 모두 슬라이드 구분으로 읽는다.

    ## 1 · 훅        ## 슬라이드 1 (표지)      [1장]
    **1/9**          **슬라이드 3**            3장:

사용법:
    python3 check_carousel.py 초안.md
    python3 check_carousel.py 초안.md --platform threads

경고가 나와도 기계적으로 자르지 말 것. 글자 수 초과는 대개 "문장이 길다"가
아니라 "한 장에 메시지가 두 개다"라는 신호다.
"""

import argparse
import re
import sys

# 플랫폼별 기준: (슬라이드 최소, 최대, 장당 권장 글자, 장당 최대 글자, 장당 최대 줄)
PLATFORMS = {
    "instagram": (8, 10, 70, 90, 4),
    "threads": (5, 7, 100, 130, 5),
    "linkedin": (9, 12, 90, 110, 5),
}

HOOK_MAX_CHARS = 25
HOOK_HARD_CHARS = 32
HOOK_MAX_LINES = 2

# 전문용어 → 읽는 사람의 말
JARGON = {
    "리텐션": "끝까지 보는 사람",
    "인게이지먼트": "반응",
    "도달률": "몇 명에게 보이는지",
    "임프레션": "보인 횟수",
    "노출수": "보인 횟수",
    "퍼널": "사는 데까지 오는 길",
    "전환율": "실제로 하는 사람 비율",
    "컨버전": "실제 행동",
    "온보딩": "처음 익히는 과정",
    "레버리지": "지렛대처럼 쓰는 것",
    "시너지": "같이 했을 때 더 커지는 것",
    "인사이트": "알게 된 것",
    "니즈": "원하는 것",
    "페인포인트": "불편한 지점",
    "밸류": "가치",
    "그로스": "성장",
    "바이럴": "퍼지는 것",
    "알고리즘 최적화": "더 많이 보이게 만드는 법",
    "액션 아이템": "할 일",
    "커뮤니케이션": "말이 오가는 것",
    "프로세스": "순서",
    "메커니즘": "작동 원리",
    "최적화": "다듬기",
    "고도화": "더 낫게 만들기",
    "활용도": "쓸모",
    "가능합니다": "됩니다",
}

# 실제 뒤집기만 전환으로 센다. "그런데/문제는"은 다음 장으로 넘기는 미끼로도
# 쓰이므로 여기에 넣으면 전환이 실제보다 앞에 있는 것처럼 잘못 읽힌다.
TRANSITIONS = ("하지만", "그러나", "반대로", "그런데도")
SPOILERS = ("정답은", "결론은", "방법은 간단", "핵심은", "답은")
CTA_WORDS = ("저장", "공유", "팔로우", "댓글", "프로필", "링크", "DM", "구독")


# 실제로 붙여넣는 표기를 모두 받는다. 목록 번호("1. 얼굴을 크게")나
# 라벨("STEP 1")을 슬라이드로 오인하지 않도록 구분자를 요구한다.
SLIDE_PAT = re.compile(
    r"""^\s*(?:
        \#{2,4}\s*(?:슬라이드|카드|포스트|Slide|Post)?\s*(\d{1,2})\s*(?:장|번|[·:.)\-—]|\()
      | \[\s*(?:슬라이드|카드)?\s*(\d{1,2})\s*(?:장|번)?\s*\]
      | \*{2}\s*(\d{1,2})\s*/\s*\d{1,2}\s*\*{2}
      | \*{2}\s*(?:슬라이드|카드|포스트)\s*(\d{1,2})\s*\*{2}
      | (\d{1,2})\s*장\s*[:：]
    )""",
    re.I | re.X,
)

# 편집용 라벨 줄은 카피가 아니므로 글자 수에서 뺀다
LABEL_PAT = re.compile(r"^\*{0,2}(메인 카피|서브 카피|본문|하단|라벨|제목|카피)\*{0,2}\s*[:：]?\s*$")

# 캡션·해시태그·디자인 메모 절부터는 슬라이드가 아니다
TAIL_PAT = re.compile(r"^\s*#{2,4}\s*(캡션|해시태그|디자인|Caption|Hashtag)", re.I)


def parse_slides(text):
    """슬라이드만 뽑는다. 캡션·디자인 메모 절부터는 무시한다."""
    slides = []
    current = None
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if TAIL_PAT.match(line):
            break
        if not stripped or set(stripped) <= set("-—=*"):
            continue
        m = SLIDE_PAT.match(line)
        if m:
            num = next(g for g in m.groups() if g)
            rest = line[m.end():].strip(" ·:：—-*[]()")
            # 제목 자리의 라벨(훅, 문제 …)은 본문에서 제외하고, 카피면 살린다
            title = rest if len(rest) <= 12 else ""
            current = {"num": int(num), "title": title, "lines": []}
            if rest and not title:
                current["lines"].append(rest)
            slides.append(current)
            continue
        if current is None:
            continue
        if LABEL_PAT.match(stripped):
            continue
        current["lines"].append(re.sub(r"^[*_>\s]+|[*_]+$", "", stripped))
    return slides


def char_count(lines):
    return sum(len(re.sub(r"\s", "", ln)) for ln in lines)


def sentence_count(lines):
    body = " ".join(lines)
    parts = [p for p in re.split(r"[.!?…]+|\n", body) if p.strip()]
    return max(len(parts), len(lines))


class Report:
    def __init__(self):
        self.errors = []
        self.warns = []
        self.oks = []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warns.append(msg)

    def ok(self, msg):
        self.oks.append(msg)

    def render(self):
        for m in self.oks:
            print(f"  ✓ {m}")
        for m in self.warns:
            print(f"  ⚠ {m}")
        for m in self.errors:
            print(f"  ✗ {m}")


def check(slides, platform):
    lo, hi, soft_chars, hard_chars, max_lines = PLATFORMS[platform]
    r = Report()
    n = len(slides)

    if n == 0:
        r.error("슬라이드를 찾지 못했다. `## 1 · 훅` 형식의 제목이 있는지 확인한다.")
        return r

    # 슬라이드 수
    if n < lo:
        r.warn(f"슬라이드 {n}장 — {platform} 권장은 {lo}~{hi}장. 꽉 찬 장을 쪼갤 곳이 있다는 뜻이다.")
    elif n > hi:
        r.warn(f"슬라이드 {n}장 — {platform} 권장은 {lo}~{hi}장. 중복되는 장이 없는지 본다.")
    else:
        r.ok(f"슬라이드 {n}장 (권장 {lo}~{hi}장)")

    # Rule 1 — 훅
    hook = slides[0]
    hchars = char_count(hook["lines"])
    hlines = len(hook["lines"])
    hsent = len([p for p in re.split(r"[.!?…]+", " ".join(hook["lines"])) if p.strip()])
    if hchars > HOOK_HARD_CHARS:
        r.error(f"[Rule 1] 훅 {hchars}자 — {HOOK_MAX_CHARS}자 내외로. 설명이 붙어 있다는 뜻이다.")
    elif hchars > HOOK_MAX_CHARS:
        r.warn(f"[Rule 1] 훅 {hchars}자 — {HOOK_MAX_CHARS}자를 넘겼다. 잘라낼 곳이 있다.")
    else:
        r.ok(f"[Rule 1] 훅 {hchars}자, {hlines}줄")
    if hlines > HOOK_MAX_LINES:
        r.error(f"[Rule 1] 훅이 {hlines}줄 — 두 줄을 넘으면 0.5초 안에 안 읽힌다.")
    if hsent > 1:
        r.error(f"[Rule 1] 훅에 문장이 {hsent}개 — 한 문장으로 줄인다.")
    if re.search(r"[.]$", " ".join(hook["lines"]).strip()):
        r.warn("[Rule 1] 훅이 마침표로 닫혔다. 문장이 닫히면 궁금증도 닫힌다.")

    # Rule 2 — 답을 언제 주는가
    if n >= 2:
        second = " ".join(slides[1]["lines"]) + " " + slides[1]["title"]
        if any(s in second for s in SPOILERS):
            r.error("[Rule 2] 2장에 결론 신호어(정답은/핵심은/결론은)가 있다. 답을 절반 뒤로 민다.")

    half = max(1, n // 2)
    trans_at = [i for i, s in enumerate(slides)
                if any(t in (" ".join(s["lines"]) + " " + s["title"]) for t in TRANSITIONS)]
    if not trans_at:
        r.error('[Rule 2] "하지만" 전환이 없다. 기존 방식을 세운 뒤 뒤집는 장을 만든다.')
    else:
        first = trans_at[0] + 1
        if first > int(n * 0.75):
            r.warn(f"[Rule 2] 전환이 {first}장에 처음 나온다 — 너무 늦다. 절반 근처가 좋다.")
        elif first < 3:
            r.warn(f"[Rule 2] 전환이 {first}장 — 긴장을 쌓기 전에 뒤집으면 힘이 없다.")
        else:
            r.ok(f"[Rule 2] 전환이 {first}장 (전체 {n}장 중 절반 근처)")

    # Rule 3 + 장당 분량
    for i, s in enumerate(slides, start=1):
        body = s["lines"]
        c = char_count(body)
        if c > hard_chars:
            r.error(f"[Rule 3] {i}장 {c}자 — 한 장에 메시지가 두 개인지 먼저 의심한다 (최대 {hard_chars}자).")
        elif c > soft_chars:
            r.warn(f"[Rule 3] {i}장 {c}자 — 권장 {soft_chars}자.")
        if len(body) > max_lines:
            r.warn(f"[Rule 3] {i}장이 {len(body)}줄 — {max_lines}줄 이내로 쪼갠다.")
        if i > 1 and sentence_count(body) > 3:
            r.warn(f"[Rule 2] {i}장에 문장이 {sentence_count(body)}개 — 한 장에 메시지 하나인지 확인한다.")
        for ln in body:
            plain = re.sub(r"\s", "", ln)
            if len(plain) > 30:
                r.warn(f"[Rule 3] {i}장 한 줄이 {len(plain)}자 — 25자 내외로 끊는다: \"{ln[:20]}…\"")

    # 전문용어
    joined = "\n".join(" ".join(s["lines"]) + " " + s["title"] for s in slides)
    found = sorted({w for w in JARGON if w in joined})
    if found:
        for w in found:
            r.warn(f'[Rule 3] 전문용어 "{w}" → "{JARGON[w]}"로 바꾼다.')
    else:
        r.ok("[Rule 3] 걸린 전문용어 없음")

    # CTA
    last = " ".join(slides[-1]["lines"]) + " " + slides[-1]["title"]
    ctas = [w for w in CTA_WORDS if w in last]
    if not ctas:
        r.warn("마지막 장에 행동 요청(CTA)이 없다. 하나는 있어야 한다.")
    elif len(ctas) > 1:
        r.error(f"마지막 장 CTA가 {len(ctas)}개({', '.join(ctas)}) — 하나만 남긴다. 여러 개면 아무것도 안 한다.")
    else:
        r.ok(f"CTA 1개 ({ctas[0]})")

    # 회수
    hook_words = {w for w in re.findall(r"[가-힣A-Za-z]{2,}", " ".join(hook["lines"]))}
    tail = " ".join(" ".join(s["lines"]) for s in slides[-2:])
    if hook_words and not (hook_words & set(re.findall(r"[가-힣A-Za-z]{2,}", tail))):
        r.warn("마지막 두 장에서 훅의 단어가 회수되지 않는다. 훅 문장을 다시 꺼내 닫으면 완성도가 올라간다.")

    return r


def main():
    ap = argparse.ArgumentParser(description="카드뉴스 초안을 세 가지 룰로 검사한다.")
    ap.add_argument("file", help="검사할 마크다운 초안")
    ap.add_argument("--platform", default="instagram", choices=sorted(PLATFORMS),
                    help="기본값 instagram")
    args = ap.parse_args()

    try:
        with open(args.file, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"파일을 열 수 없다: {e}", file=sys.stderr)
        return 2

    slides = parse_slides(text)
    print(f"\n{args.file} · {args.platform} · 슬라이드 {len(slides)}장\n")
    report = check(slides, args.platform)
    report.render()

    print()
    if report.errors:
        print(f"고쳐야 할 것 {len(report.errors)}개, 확인할 것 {len(report.warns)}개.")
        print("글자 수를 기계적으로 자르지 말고 문장을 다시 쓴다.")
        return 1
    if report.warns:
        print(f"치명적인 문제는 없다. 확인할 것 {len(report.warns)}개.")
        return 0
    print("세 룰 통과. 남은 것은 사람이 볼 부분이다 — 훅이 정말 궁금한지, 전환에 힘이 있는지.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
