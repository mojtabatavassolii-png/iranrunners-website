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

Every point slide and the cover end with "برای دیدن متن کامل مقاله به سایت
ایران رانرز برید" — the CTA slide repeats it full-size with the site URL.

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

Each slide is plain HTML/CSS (the site's own Vazirmatn font + brand colors)
screenshotted with Playwright/Chromium at the exact target pixel size — the
same approach used throughout this repo's local testing, chosen because
Chromium's native RTL/Persian text shaping is far more reliable than
hand-rolling it with a raster library. Local images must be loaded via a
real `file://` page (not `page.set_content`), since Chromium blocks
`file://` resource loads from non-file:// documents.

Requires: `pip install playwright` and the Chromium binary at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (already present in
this project's dev environment).
