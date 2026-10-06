# گزارش خودکار سئو و آنالیتیکس

ابزاری که هر وقت اجرا بشه، یک گزارش تاریخ‌دار در `reports/report-YYYY-MM-DD.md` می‌سازه شامل:
- وضعیت ایندکس هر آدرس سایت‌مپ (از Search Console URL Inspection API)
- آمار کلیک/نمایش/CTR/رتبه هر صفحه در ۳۰ روز اخیر (از Search Console Search Analytics)
- جلسات/کاربران/بازدید کل، پربازدیدترین صفحات، و منبع ترافیک (از Google Analytics Data API)

## راه‌اندازی یک‌بار (Service Account موجود رو دوباره استفاده می‌کنیم)

همون Service Account که برای گوگل آنالیتیکس (بازدید مقالات) ساختیم رو استفاده می‌کنیم — نیازی به ساخت یکی جدید یا Secret جدید نیست.

1. وارد [Google Cloud Console](https://console.cloud.google.com) بشید → همون پروژه‌ای که قبلاً Service Account رو توش ساختید.
2. از منو: **APIs & Services → Library** → دنبال **Google Search Console API** بگردید → **Enable**.
3. ایمیل Service Account رو پیدا کنید: **IAM & Admin → Service Accounts** → ایمیلش شبیه `pageviews-reader@your-project.iam.gserviceaccount.com` هست (یا هر اسمی که قبلاً گذاشتید).
4. وارد [Google Search Console](https://search.google.com/search-console) بشید → property مربوط به iranrunners.com رو انتخاب کنید → **Settings → Users and permissions → Add user**.
5. همون ایمیل Service Account رو وارد کنید، نقش **Full** (نیازی به Owner نیست).

همین. هیچ Secret جدیدی توی گیت‌هاب لازم نیست — از همون `GA4_SERVICE_ACCOUNT_JSON` و `GA4_PROPERTY_ID` موجود استفاده می‌شه.

## اجرای گزارش

### از طریق گیت‌هاب (دستی)
مخزن → تب **Actions** → روی workflow «**Generate SEO report**» کلیک کنید → **Run workflow**.

### با درخواست از Claude
کافیه بگید «یک گزارش سئو بگیر» — خودم workflow رو اجرا می‌کنم و خلاصه نتیجه رو برات می‌فرستم.

گزارش خودکار commit می‌شه توی `reports/` و همچنین به‌عنوان یک فایل قابل‌دانلود (artifact) زیر همون اجرای Action در دسترسه.

## نکات

- بازه Search Analytics همیشه تا ۳ روز قبل از امروزه — گوگل داده چند روز اخیر رو هنوز کامل پردازش نکرده.
- اگه بخشی از گزارش («Search Console» یا «گوگل آنالیتیکس») با پیام خطا ظاهر شد، یعنی هنوز مرحله راه‌اندازی بالا کامل نشده — پیام خطا دقیقاً می‌گه مشکل کجاست.
- این ابزار جایگزین Search Console نیست — فقط یه خلاصه سریع می‌ده. برای بررسی عمیق‌تر، مستقیم به search.google.com/search-console مراجعه کنید.
