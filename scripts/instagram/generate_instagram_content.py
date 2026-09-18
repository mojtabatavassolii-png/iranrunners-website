#!/usr/bin/env python3
"""
Generate Instagram post + story image sets from a blog article.

This is a maintainer-only tool (not wired into Pages CMS or the live site).
Claude runs it after writing a new article: it extracts the key talking
points itself and renders a branded slide carousel (feed post, 1080x1080)
and a matching story set (1080x1920) as PNG files, ready to download and
post. The site owner reviews/edits the extracted points before generating,
and can re-run with edited text at any time.

Usage:
    python3 generate_instagram_content.py --config article.json --out-dir OUT_DIR

See sample_article.json for the expected input shape.
"""
import argparse
import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]

BRAND_RED = "#e8121a"
BRAND_RED_DIM = "#b80e14"
BRAND_BLACK = "#111111"
BRAND_MUTED = "#555555"
BRAND_FAINT = "#8a8a8a"

PERSIAN_RE = re.compile(r"[؀-ۿ]")

# Boilerplate strings the tool itself writes (not the user's own title/
# heading/body text, which stays exactly as typed). Direction/alignment
# for these follows the detected language via CSS logical properties, so
# no per-string left/right flipping is needed here.
STRINGS = {
    "fa": {
        "swipe_hint": "ورق بزنید",
        "counter": "{i} از {n}",
        "cta_text": "برای دیدن متن کامل مقاله<br>به سایت ایران رانرز برید",
    },
    "en": {
        "swipe_hint": "Swipe to see more",
        "counter": "{i} of {n}",
        "cta_text": "Read the full article<br>on the Iran Runners website",
    },
}


def detect_lang(*texts):
    """fa if any Persian/Arabic-script character appears anywhere in the
    combined text, else en. Biased toward fa so a Persian article with an
    occasional English loanword (e.g. "GPS") doesn't flip the whole set."""
    combined = " ".join(t for t in texts if t)
    return "fa" if PERSIAN_RE.search(combined) else "en"


def font_family(lang):
    return "Baloo Bhaijaan 2" if lang == "fa" else "Baloo 2"


FONT_LINK = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link href="https://fonts.googleapis.com/css2?family=Baloo+Bhaijaan+2:wght@400;700;800'
    '&family=Baloo+2:wght@400;700;800'
    '&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">'
)


def base_css(lang):
    direction = "rtl" if lang == "fa" else "ltr"
    family = font_family(lang)
    return f"""
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{
  width: 100%; height: 100%;
  font-family: "{family}", "Tahoma", sans-serif;
  direction: {direction};
  -webkit-font-smoothing: antialiased;
}}
.mono {{ font-family: "JetBrains Mono", monospace; direction: ltr; display: inline-block; letter-spacing: -0.02em; }}
.slide {{
  width: var(--w); height: var(--h);
  position: relative;
  overflow: hidden;
  background: #ffffff;
  display: flex;
  flex-direction: column;
}}
.pill {{
  display: inline-flex; align-items: center;
  background: {BRAND_RED}; color: #ffffff;
  font-weight: 700; font-size: 28px;
  padding: 10px 28px; border-radius: 999px;
  white-space: nowrap;
}}
.dots {{ display: flex; gap: 12px; align-items: center; }}
.dot {{ width: 14px; height: 14px; border-radius: 50%; background: {BRAND_FAINT}; }}
.dot.active {{ background: {BRAND_RED}; width: 34px; border-radius: 8px; }}
.accent-bar {{ width: 110px; height: 8px; border-radius: 4px; background: {BRAND_RED}; }}
.point-body-list {{ list-style: none; display: flex; flex-direction: column; gap: 20px; }}
.point-body-list li {{ position: relative; padding-inline-start: 32px; }}
.point-body-list li::before {{
  content: ""; position: absolute; inset-inline-start: 0; top: 0.55em;
  width: 12px; height: 12px; border-radius: 50%; background: {BRAND_RED};
}}
"""


def _render(html: str, width: int, height: int, out_path: Path, page, tmp_dir: Path):
    # Navigate to a real file:// URL (not set_content) so the document's
    # own origin is file://, which lets it load other file:// resources
    # like local images — Chromium blocks that for non-file:// documents.
    tmp_html = tmp_dir / f"_{out_path.stem}.html"
    tmp_html.write_text(html, encoding="utf-8")
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"file://{tmp_html}", wait_until="networkidle")
    page.screenshot(path=str(out_path))
    tmp_html.unlink()


def cover_slide(w, h, title, category, is_story, lang):
    img_h_ratio = "78%" if is_story else "100%"
    title_size = "76px" if is_story else "64px"
    top_pad = "150px" if is_story else "56px"
    bottom_pad = "210px" if is_story else "64px"
    swipe_hint = STRINGS[lang]["swipe_hint"]
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">{FONT_LINK}
    <style>{base_css(lang)}
    .cover-photo {{ position:absolute; inset:0; width:100%; height:{img_h_ratio};
      background-size: cover; background-position: center; }}
    .cover-overlay {{ position:absolute; inset:0; height:{img_h_ratio};
      background: linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.05) 75%); }}
    .cover-base {{ position:absolute; left:0; right:0; bottom:0; top:{img_h_ratio};
      background:{BRAND_BLACK}; display:{'flex' if is_story else 'none'}; }}
    .cover-top {{ position:relative; padding: {top_pad} 56px 0; display:flex; justify-content:space-between; align-items:flex-start; z-index:2; }}
    .cover-bottom {{ position:absolute; bottom: 0; right:0; left:0; padding: 0 56px {bottom_pad}; z-index:2; }}
    .cover-title {{ color:#ffffff; font-weight:800; font-size:{title_size}; line-height:1.35; margin-top:26px; }}
    .swipe-hint {{ color:rgba(255,255,255,0.75); font-size:26px; font-weight:600; margin-top:28px; display:flex; align-items:center; gap:10px; }}
    </style></head>
    <body><div class="slide" style="--w:{w}px;--h:{h}px;background:{BRAND_BLACK};">
      <div class="cover-photo" style="background-image:url('file://{{IMG}}');"></div>
      <div class="cover-overlay"></div>
      <div class="cover-base"></div>
      <div class="cover-top">
        <img src="file://{{LOGO_WHITE}}" style="height:46px;width:auto;">
        <span class="pill">{category}</span>
      </div>
      <div class="cover-bottom">
        <div class="accent-bar"></div>
        <div class="cover-title">{title}</div>
        <div class="swipe-hint">{swipe_hint} &#8592;</div>
      </div>
    </div></body></html>"""


def point_slide(w, h, index, total, heading, body, logo_path, is_story, lang):
    heading_size = "62px" if is_story else "54px"
    body_size = "34px" if is_story else "31px"
    pad_top = "170px" if is_story else "72px"
    pad_bottom = "230px" if is_story else "160px"
    footer_bottom = "110px" if is_story else "44px"
    body_lines = [line.strip() for line in body.split("\n") if line.strip()]
    body_html = "".join(f"<li>{line}</li>" for line in body_lines)
    counter = STRINGS[lang]["counter"].format(i=index, n=total)
    header_html = f'<div class="point-header"><span class="pill" style="align-self:flex-start;">{counter}</span></div>' if total > 1 else ""
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">{FONT_LINK}
    <style>{base_css(lang)}
    .point-wrap {{ padding: {pad_top} 72px {pad_bottom}; display:flex; flex-direction:column; flex: 1; }}
    .point-header {{ flex-shrink: 0; }}
    .point-content {{ flex: 1; display:flex; flex-direction:column; justify-content:center; gap: 32px; }}
    .point-heading {{ font-weight:800; font-size:{heading_size}; line-height:1.4; color:{BRAND_BLACK}; }}
    .point-body-list {{ font-weight:400; font-size:{body_size}; line-height:1.7; color:{BRAND_MUTED}; }}
    .point-footer {{ position:absolute; bottom:{footer_bottom}; right:56px; left:56px; display:flex; justify-content:space-between; align-items:center; }}
    </style></head>
    <body><div class="slide" style="--w:{w}px;--h:{h}px;">
      <div class="point-wrap">
        {header_html}
        <div class="point-content">
          <div class="accent-bar"></div>
          <div class="point-heading">{heading}</div>
          <ul class="point-body-list">{body_html}</ul>
        </div>
      </div>
      <div class="point-footer">
        <img src="file://{logo_path}" style="height:76px;width:auto;">
        <div class="dots">
          {''.join('<span class="dot' + (' active' if i == index else '') + '"></span>' for i in range(1, total + 1))}
        </div>
      </div>
    </div></body></html>"""


def cta_slide(w, h, cta_text, article_title, is_story, lang):
    cta_size = "56px" if is_story else "48px"
    cta_main_text = STRINGS[lang]["cta_text"]
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">{FONT_LINK}
    <style>{base_css(lang)}
    .cta-slide {{ background:{BRAND_RED}; align-items:center; justify-content:center; text-align:center; padding: 80px; gap: 44px; }}
    .cta-text {{ color:#ffffff; font-weight:800; font-size:{cta_size}; line-height:1.5; }}
    .cta-sub {{ color:rgba(255,255,255,0.85); font-weight:400; font-size:28px; line-height:1.8; max-width: 80%; }}
    .cta-url {{ background:#ffffff; color:{BRAND_RED}; font-weight:700; font-size:30px; padding:18px 44px; border-radius:999px; }}
    </style></head>
    <body><div class="slide cta-slide" style="--w:{w}px;--h:{h}px;">
      <img src="file://{{LOGO}}" style="height:90px;width:auto;">
      <div class="cta-text">{cta_main_text}</div>
      <div class="cta-sub">{article_title}</div>
      <div class="cta-url mono">iranrunners.com</div>
    </div></body></html>"""


def build_slides(article, fmt):
    w, h = (1080, 1080) if fmt == "post" else (1080, 1920)
    is_story = fmt == "story"
    logo_mark_path = str(REPO_ROOT / "assets" / "logo-mark.png")
    logo_mark_white_path = str(REPO_ROOT / "assets" / "logo-mark-white.png")
    img_path = str(REPO_ROOT / article["image"].lstrip("/"))

    lang = detect_lang(
        article["title"], article["category"], article.get("cta_text", ""),
        *[p["heading"] for p in article["points"]],
        *[p["body"] for p in article["points"]],
    )

    slides = []
    slides.append(("00-cover", cover_slide(w, h, article["title"], article["category"], is_story, lang)
                   .replace("{IMG}", img_path).replace("{LOGO_WHITE}", logo_mark_white_path)))
    total = len(article["points"])
    for i, p in enumerate(article["points"], start=1):
        slides.append((f"{i:02d}-point", point_slide(w, h, i, total, p["heading"], p["body"], logo_mark_path, is_story, lang)))
    slides.append((f"{total+1:02d}-cta", cta_slide(w, h, article.get("cta_text", ""), article["title"], is_story, lang).replace("{LOGO}", logo_mark_white_path)))
    return w, h, slides


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    article = json.loads(Path(args.config).read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
            headless=True,
            # --ignore-certificate-errors: this dev sandbox routes HTTPS through a
            # proxy with its own CA that Chromium doesn't trust by default, which
            # silently breaks Google Fonts loading (falls back to a system font)
            # without this flag. Not needed outside this sandboxed environment.
            args=["--no-sandbox", "--ignore-certificate-errors"],
        )
        page = browser.new_page()
        for fmt in ("post", "story"):
            fmt_dir = out_dir / fmt
            fmt_dir.mkdir(parents=True, exist_ok=True)
            w, h, slides = build_slides(article, fmt)
            for name, html in slides:
                out_path = fmt_dir / f"{name}.png"
                _render(html, w, h, out_path, page, fmt_dir)
                print(f"wrote {out_path}")
        browser.close()


if __name__ == "__main__":
    main()
