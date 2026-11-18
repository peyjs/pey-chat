# pey.chat

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.0.2-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## هدف

افزونه‌ی ویژگی (feature) از زیست‌بوم پی برای منطق یک گفت‌وگوی حافظه‌ای با مدل زبانی: تاریخچه، دستور سیستم، زمینهٔ هر پیام، ارسال تدریجی پاسخ، توقف و تلاش دوباره، و سقف تاریخچهٔ ارسال. کلید و تنظیمات اتصال را ندارد؛ این‌ها با `pey.llm` است و نمایش پاسخ با رابط کاربری.

## ساختار

- `docs/` — سندهای پروژه.
- `lib/` — منطق سرویس.
- `tests/` — آزمون‌های واحد.
- `index.js` — نقطه‌ی ورود.
- `manifest.json` — قرارداد افزونه.

## وابستگی‌ها

- **الزامی:** `pey.llm.service` — تمام ارتباط با مدل از این سرویس می‌گذرد.
- **اختیاری:** ندارد.

## نصب و استفاده

افزونه با `manifest.json` و بستهٔ npm به برنامه‌ی میزبان افزوده می‌شود و پس از دو فاز آماده‌سازی و فعال‌سازی، سرویس `pey.chat.service` را عرضه می‌کند. پیکربندی گفت‌وگو (`systemInstruction`، `maxTurns`، `maxChars`) از مانیفست خوانده می‌شود. چگونگی فراخوانی متدها در [مرجع](docs/reference.md) آمده است.

## مجوز

این پروژه با مجوز MIT منتشر شده است؛ متن کامل در [LICENSE](LICENSE).

## سندهای مرتبط

- [معرفی](docs/introduction.md) — شناخت افزونه به زبان ساده.
- [مرجع](docs/reference.md) — API، رویدادها، خطاها و پیکربندی.
- [نیازمندی‌ها](docs/requirements.md) — سند ساخت افزونه، مکتوب پیش از پیاده‌سازی.
