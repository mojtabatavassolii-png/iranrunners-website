# Instagram content generator

Maintainer-only tool — not wired into Pages CMS or the live site. Claude runs
this after writing a new blog article: it extracts the key talking points
itself, fills in `article.json`, and renders a branded slide set as PNGs.
The site owner reviews the extracted points and can ask for text edits before
(or after) generating, then downloads the images to post manually.

## What it produces

For one article, two image sets:
- `post/00-cover.png` … `post/NN-cta.png` — square 1080×1080 slides for an
  Instagram feed carousel (cover, one slide per key point, closing CTA)
- `story/00-cover.png` … `story/NN-cta.png` — the same slides at 1080×1920
  for Instagram Stories, with extra top/bottom margin so text clears
  Instagram's own UI (profile bar, reply bar)

Every point slide and the cover end with a "swipe to continue" hint, and the
CTA slide closes with a full-size call to action back to the site.

## Language

The tool auto-detects Persian vs. English from the article's own text (title,
category, headings, bodies, CTA line) — if any Persian/Arabic-script
character appears anywhere, the whole set renders RTL in Persian; otherwise
it renders LTR in English. This flips per-slide alignment (logo/category
pill positions, bullet side, text alignment), switches the boilerplate
strings the tool itself writes (swipe hint, "X of Y" counter, CTA heading)
to match, and swaps the display font (Baloo Bhaijaan 2 for Persian, its
Latin sibling Baloo 2 for English) — the user's own title/heading/body text
is never translated, only used exactly as typed.

## Usage

```
python3 generate_instagram_content.py --config article.json --out-dir OUT_DIR
```

`article.json` shape (see `sample_article.json`):

```json
{
  "title": "عنوان مقاله",
  "category": "دسته‌بندی مقاله",
  "image": "/assets/gallery/hero.jpg",
  "cta_text": "یک جمله کوتاه، مثلا معرفی کلاس مرتبط",
  "points": [
    { "heading": "تیتر نکته (کوتاه)", "body": "خط اول بولت\nخط دوم بولت" }
  ]
}
```

`body` is rendered as a bulleted list — each `\n`-separated line becomes its
own bullet. A single line still works fine (renders as one bullet).

3–5 points works best — each becomes one slide. When there's only one
point, the "X از Y" counter pill is omitted entirely since it's meaningless
for a single slide. Claude writes this file by hand per article (pulling
from the post's `lead` and `##` sections), so there's no automated
extraction step to review separately — the owner reviews the rendered
slides themselves and asks for wording changes.

## How it renders

Each slide is plain HTML/CSS (brand colors + the Baloo font pair) screenshotted
with Playwright/Chromium at the exact target pixel size — the
same approach used throughout this repo's local testing, chosen because
Chromium's native RTL/Persian text shaping is far more reliable than
hand-rolling it with a raster library. Local images must be loaded via a
real `file://` page (not `page.set_content`), since Chromium blocks
`file://` resource loads from non-file:// documents.

Requires: `pip install playwright` and the Chromium binary at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (already present in
this project's dev environment).
