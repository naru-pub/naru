"""Writes README.md's diagrams, as SVG, beside this file.

    python3 docs/images/diagrams.py

The boxes and lines are placed by hand; edit them here, not in the SVGs.
"""

import sys
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent

STYLE = """
  <style>
    svg { font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Segoe UI", sans-serif; }
    .bg { fill: #ffffff; }
    .band { fill: #f6f8fa; stroke: #d0d7de; stroke-width: 1; }
    .band-cf { fill: #fff7ed; stroke: #fdba74; }
    .band-mini { fill: #f0f9ff; stroke: #7dd3fc; }
    .band-title { font-size: 14px; font-weight: 700; fill: #1f2328; }
    .band-sub { font-size: 12px; fill: #59636e; }
    .box { fill: #ffffff; stroke: #8c959f; stroke-width: 1.2; }
    .box-ext { fill: #ffffff; stroke: #8c959f; stroke-width: 1.2; stroke-dasharray: 5 4; }
    .box-user { fill: #1f2328; stroke: none; }
    .title { font-size: 14px; font-weight: 600; fill: #1f2328; }
    .sub { font-size: 11.5px; fill: #59636e; }
    .user-title { font-size: 14px; font-weight: 600; fill: #ffffff; }
    .user-sub { font-size: 11.5px; fill: #d1d9e0; }
    .line { fill: none; stroke: #57606a; stroke-width: 1.4; }
    .line-direct { fill: none; stroke: #0969da; stroke-width: 2; }
    .dash { stroke-dasharray: 5 4; }
    .label { font-size: 11px; fill: #59636e; }
    .label-direct { font-size: 11px; font-weight: 600; fill: #0969da; }
    .head { fill: #57606a; }
    .head-direct { fill: #0969da; }
    .life { stroke: #d0d7de; stroke-width: 1.2; stroke-dasharray: 4 4; }
    .msg { font-size: 12px; fill: #1f2328; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .band { fill: #161b22; stroke: #30363d; }
      .band-cf { fill: #241a10; stroke: #9a5b1f; }
      .band-mini { fill: #0f1d2b; stroke: #1f6f9f; }
      .band-title, .title, .msg { fill: #e6edf3; }
      .band-sub, .sub, .label { fill: #9198a1; }
      .box, .box-ext { fill: #0d1117; stroke: #6e7681; }
      .box-user { fill: #e6edf3; }
      .user-title { fill: #0d1117; }
      .user-sub { fill: #3d444d; }
      .line { stroke: #9198a1; }
      .head { fill: #9198a1; }
      .line-direct { stroke: #4493f8; }
      .head-direct, .label-direct { fill: #4493f8; }
      .life { stroke: #30363d; }
    }
  </style>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="head"/>
    </marker>
    <marker id="d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="head-direct"/>
    </marker>
  </defs>
"""


def t(x, y, text, cls, anchor="start"):
    return f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{escape(text)}</text>'


def box(x, y, w, h, title, sub=None, cls="box"):
    cx = x + w / 2
    title_cls, sub_cls = ("user-title", "user-sub") if cls == "box-user" else ("title", "sub")
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" class="{cls}"/>']
    if sub:
        parts.append(t(cx, y + h / 2 - 3, title, title_cls, "middle"))
        parts.append(t(cx, y + h / 2 + 14, sub, sub_cls, "middle"))
    else:
        parts.append(t(cx, y + h / 2 + 5, title, title_cls, "middle"))
    return "\n  ".join(parts)


def path(points, direct=False, both=False, dashed=False, head=True):
    d = "M" + " L".join(f"{x},{y}" for x, y in points)
    cls = "line-direct" if direct else "line"
    if dashed:
        cls += " dash"
    marker = "d" if direct else "a"
    start = f' marker-start="url(#{marker})"' if both else ""
    end = f' marker-end="url(#{marker})"' if head else ""
    return f'<path d="{d}" class="{cls}"{start}{end}/>'


def svg(width, height, body, title, desc):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
  <title id="title">{escape(title)}</title>
  <desc id="desc">{escape(desc)}</desc>
{STYLE}
  <rect width="{width}" height="{height}" class="bg"/>
  {body}
</svg>
"""


# The architecture. Four columns; the first is left empty in Cloudflare's
# band, for the browser's direct line to the mini.
W, H = 190, 60
C = [190, 420, 650, 880]
CX = [x + W / 2 for x in C]
CF = [140, 240, 340]  # Cloudflare's rows

# On the mini, Caddy hands sdk.naru.pub to a router, which sends each site
# to one of four workerd shards (2026-10-18).
MINI2 = [510, 620, 730]
EXT2 = 850
SW = 92  # a shard's width: two to a column
parts = [
    '<rect x="170" y="100" width="920" height="330" rx="12" class="band band-cf"/>',
    t(190, 124, "Cloudflare", "band-title"),
    t(282, 124, "한국에서는 LA를 거칩니다", "band-sub"),
    '<rect x="170" y="470" width="920" height="340" rx="12" class="band band-mini"/>',
    t(190, 494, "맥 미니", "band-title"),
    t(244, 494, "서울 · 사이트를 workerd 넷에 나눠 둡니다", "band-sub"),
    box(130, 20, C[2] + W - 130, 50, "한국의 브라우저", "방문자, 회원, 사이트 주인", "box-user"),
    box(C[3], 20, W, 50, "Toss, GitHub", "결제 웹훅, 사이트 배포", "box-ext"),
    box(C[1], CF[0], W, H, "엣지 Worker", "<site>.naru.pub"),
    box(C[2], CF[0], W, H, "R2", "사이트 파일, 미디어, 코드"),
    box(C[1], CF[1], W, H, "Durable Objects", "페이지뷰 기록"),
    box(C[1], CF[2], W, H, "Standby 객체", "상태 확인 cron, 알림"),
    t(C[0], 254, "naru.pub과", "label-direct"),
    t(C[0], 270, "sdk.naru.pub은", "label-direct"),
    t(C[0], 286, "Cloudflare를 거치지 않고", "label-direct"),
    t(C[0], 302, "맥 미니로 바로 연결", "label-direct"),
    # The mini.
    box(C[0], MINI2[0], W, H, "Caddy :443", "naru.pub · sdk.naru.pub"),
    box(C[1], MINI2[0], W, H, "workerd 라우터 :40100", "샤드 선택, SDK 파일"),
    box(C[0], MINI2[1], W, H, "nginx 게이트웨이", "naru.pub"),
    box(C[1], MINI2[1], W, H, "Control plane", "Next.js, blue/green"),
    box(C[0], MINI2[2], W, H, "백업 (launchd)", "사이트 DB 5분마다, 전체 매일"),
    box(C[1], MINI2[2], W, H, "PostgreSQL", "계정, 결제, 토큰"),
    box(C[2], MINI2[2], W, H, "작업 워커", "결제, 페이지뷰, 스크린샷"),
    box(C[3], MINI2[2], W, H, "워치독 (launchd)", "멈추거나 커진 프로세스만 재시작"),
    # Outside.
    box(C[0], EXT2, W, H, "Backblaze B2", "백업", "box-ext"),
    box(C[2], EXT2, W, H, "SES, Sentry, Discord", "메일, 오류, 알림", "box-ext"),
    # Into Cloudflare, and past it.
    path([(CX[1], 70), (CX[1], CF[0])]),
    path([(150, 70), (150, MINI2[0] + 30), (C[0], MINI2[0] + 30)], direct=True),
    path([(CX[3], 70), (CX[3], 85), (150, 85)], direct=True, head=False),
    # Within Cloudflare.
    path([(C[1] + W, CF[0] + 30), (C[2], CF[0] + 30)]),
    path([(CX[1], CF[0] + H), (CX[1], CF[1])]),
    path([(C[1], CF[0] + 40), (C[1] - 15, CF[0] + 40), (C[1] - 15, CF[2] + 30), (C[1], CF[2] + 30)]),
    # The standby object probes the mini and sends it route renders.
    path([(CX[1] - 45, CF[2] + H), (CX[1] - 45, 445), (C[0] + W - 20, 445), (C[0] + W - 20, MINI2[0])]),
    t(C[0] + W - 12, 439, "상태 확인, 라우트 렌더", "label"),
    # Caddy: sdk.naru.pub to the router, naru.pub to the gateway.
    path([(C[0] + W, MINI2[0] + 30), (C[1], MINI2[0] + 30)]),
    path([(CX[0], MINI2[0] + H), (CX[0], MINI2[1])]),
    path([(C[0] + W, MINI2[1] + 30), (C[1], MINI2[1] + 30)]),
    # The control plane and the router call each other (signed-in requests,
    # owners' operations).
    path([(CX[1], MINI2[1]), (CX[1], MINI2[0] + H)], both=True),
    path([(CX[1], MINI2[1] + H), (CX[1], MINI2[2])]),
    path([(C[2], MINI2[2] + 30), (C[1] + W, MINI2[2] + 30)]),
    # Out.
    path([(CX[0], MINI2[2] + H), (CX[0], EXT2)]),
    path([(CX[2], MINI2[2] + H), (CX[2], EXT2)]),
]
# Four shards, two rows of two, fed from one line under the router, and
# drawn as one group: the router picks one of them by the site's name.
BUS = MINI2[0] + H + 25
GROUP = (C[2] - 14, MINI2[0] - 30, C[3] + W + 14, MINI2[1] + H + 12)
parts.append(
    f'<rect x="{GROUP[0]}" y="{GROUP[1]}" width="{GROUP[2] - GROUP[0]}" '
    f'height="{GROUP[3] - GROUP[1]}" rx="12" class="box-ext"/>'
)
parts.append(t(GROUP[0] + 14, GROUP[1] + 19, "workerd 샤드 넷", "title"))
parts.append(t(GROUP[0] + 132, GROUP[1] + 19, "사이트 이름으로 나눔, 한 샤드가 멈춰도 나머지는 그대로", "sub"))
SHARDS = []
for i, (x, y) in enumerate(
    [(C[2], MINI2[0]), (C[3], MINI2[0]), (C[2], MINI2[1]), (C[3], MINI2[1])]
):
    SHARDS.append((x, y))
    parts.append(box(x, y, W, H, f"샤드 {i}", "사이트 ¼, SQLite 하나씩"))
parts.append(
    path([(C[1] + W - 20, MINI2[0] + H), (C[1] + W - 20, BUS), (CX[3], BUS)], head=False)
)
for x, y in SHARDS:
    cx = x + W / 2
    parts.append(path([(cx, BUS), (cx, y + H if y == MINI2[0] else y)]))
# The shards read and write R2: site code, restore points.
parts.append(path([(CX[2] - 50, MINI2[0]), (CX[2] - 50, CF[0] + H)]))
parts.append(t(CX[2] - 42, 300, "코드, 복원 지점", "label"))
# The watchdog restarts a stuck or oversized shard, only that one.
parts.append(path([(CX[3], MINI2[2]), (CX[3], GROUP[3])], dashed=True))
(OUT / "architecture.svg").write_text(
    svg(
        1110,
        930,
        "\n  ".join(parts),
        "나루의 구조",
        "한국의 브라우저는 사이트 페이지를 Cloudflare의 엣지 Worker에서 받고, 관리 화면(naru.pub)과 "
        "Data SDK(sdk.naru.pub)는 Cloudflare를 거치지 않고 맥 미니의 Caddy에 바로 연결합니다. "
        "Caddy는 naru.pub을 nginx 게이트웨이와 control plane으로, sdk.naru.pub을 workerd 라우터로 보내고, 라우터는 사이트 이름으로 네 개의 "
        "workerd 샤드 중 하나를 골라 보냅니다. 각 샤드는 사이트의 4분의 1을 맡아, 한 사이트가 느려도 "
        "다른 샤드의 사이트는 기다리지 않습니다. 워치독은 멈추거나 메모리를 넘은 샤드만 다시 시작합니다. "
        "사이트 데이터베이스는 맥 미니에만 있고, Backblaze B2에 5분마다 백업됩니다.",
    )
)


# A Data SDK request.
COLS = [
    ("브라우저", None),
    ("Caddy + workerd", "맥 미니"),
    ("Control plane", "맥 미니"),
    ("PostgreSQL", "맥 미니"),
]
X = [110, 450, 700, 935]
TOP, STEP = 20, 48
MESSAGES = [
    (0, 1, "GET sdk.naru.pub/sdk/1.1.0/naru.js", False),
    (1, 0, "SDK 파일 (5분 캐시, 하루 동안 백그라운드 갱신)", True),
    (0, 1, "GET sdk.naru.pub/api/data/v1/{site}/{collection}", False),
    (1, 0, "사이트 SQLite에서 바로 응답 (수십 ms)", True),
    (0, 1, "로그인 토큰과 함께 요청", False),
    (1, 2, "토큰이 있는 요청은 control plane으로", False),
    (2, 3, "사이트, 결제 상태, 회원 확인", False),
    (2, 1, "확인된 작업을 사이트 객체에 실행", False),
    (1, 0, "결과", True),
]
BOX_W, BOX_H = 170, 50
first = TOP + BOX_H + 40
height = first + STEP * (len(MESSAGES) - 1) + 50
parts = []
for x, (name, where) in zip(X, COLS):
    parts.append(f'<line x1="{x}" y1="{TOP + BOX_H}" x2="{x}" y2="{height - 15}" class="life"/>')
    parts.append(box(x - BOX_W / 2, TOP, BOX_W, BOX_H, name, where, "box-user" if where is None else "box"))
for i, (a, b, text, back) in enumerate(MESSAGES):
    y = first + STEP * i
    start, end = X[a], X[b]
    step = 6 if end > start else -6
    parts.append(path([(start, y), (end - step, y)], dashed=back))
    parts.append(t((start + end) / 2, y - 8, text, "msg", "middle"))
(OUT / "sdk-request.svg").write_text(
    svg(
        1080,
        height,
        "\n  ".join(parts),
        "Data SDK 요청이 지나는 길",
        "SDK 파일도 데이터도 sdk.naru.pub, 맥 미니의 workerd에서 받습니다. 방문자의 읽기는 사이트 SQLite에서 바로 답하고, "
        "로그인한 요청은 control plane이 PostgreSQL로 확인한 뒤 사이트 객체에서 처리합니다.",
    )
)
