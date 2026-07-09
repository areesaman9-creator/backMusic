# 🎵 Music Player Backend

بک‌اند کامل اپ موزیک‌پلیر با Node.js + TypeScript + MongoDB + Telegram Integration

---

## 📁 ساختار پروژه

```
src/
├── config/
│   └── database.ts          # اتصال MongoDB
├── controllers/
│   ├── authController.ts    # ثبت‌نام / ورود / JWT
│   ├── channelsController.ts # کانال‌های تلگرام
│   ├── songsController.ts   # لیست آهنگ‌ها
│   ├── favoritesController.ts # علاقه‌مندی‌ها
│   ├── playlistsController.ts # پلی‌لیست‌ها
│   ├── streamController.ts  # پخش موزیک
│   ├── downloadsController.ts # دانلودها
│   └── proxyController.ts   # تنظیمات پروکسی
├── middleware/
│   ├── auth.ts              # JWT middleware
│   ├── errorHandler.ts      # مدیریت خطا
│   └── validators.ts        # اعتبارسنجی
├── models/
│   └── User.ts              # مدل کاربر
├── routes/
│   └── index.ts             # تمام route‌ها
├── services/
│   └── telegram.ts          # سرویس تلگرام
├── utils/
│   └── jwt.ts               # توکن JWT
└── server.ts                # نقطه ورود
```

---

## 🚀 راه‌اندازی

### ۱. نصب وابستگی‌ها
```bash
npm install
```

### ۲. تنظیم محیط
```bash
cp .env.example .env
# فایل .env را ویرایش کنید
```

### ۳. اجرا

**توسعه (با hot-reload):**
```bash
npm run dev
```

**Build و اجرای production:**
```bash
npm run build
npm start
```

---

## ⚙️ متغیرهای محیطی (.env)

```env
PORT=3000
NODE_ENV=development
MONGODB_URI=mongodb://...
JWT_SECRET=your-secret-key
JWT_EXPIRE=7d
```

---

## 📡 API Endpoints

### 🔐 Auth
| Method | Path | توضیح |
|--------|------|-------|
| POST | `/api/auth/register` | ثبت‌نام |
| POST | `/api/auth/login` | ورود |
| POST | `/api/auth/refresh` | تجدید توکن |
| GET | `/api/auth/me` | اطلاعات کاربر |
| PUT | `/api/auth/profile` | ویرایش پروفایل |
| PUT | `/api/auth/password` | تغییر رمز |
| POST | `/api/auth/logout` | خروج |

### 📺 Channels
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/channels` | لیست کانال‌ها |
| POST | `/api/channels` | افزودن کانال |
| DELETE | `/api/channels/:id` | حذف کانال |
| POST | `/api/channels/:id/sync` | سینک آهنگ‌ها |

**POST /api/channels body:**
```json
{
  "channelUsername": "mymusic",
  "channelName": "My Music Channel"
}
```

**POST /api/channels/:id/sync body:**
```json
{
  "channelUsername": "mymusic",
  "forceFullSync": false
}
```

### 🎵 Songs
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/songs` | لیست آهنگ‌ها |

**Query params:**
- `channelDbId` - فیلتر بر اساس کانال
- `page` - شماره صفحه (پیش‌فرض: 1)
- `limit` - تعداد در صفحه (پیش‌فرض: 50)
- `search` - جستجو در عنوان/هنرمند
- `sortBy` - مرتب‌سازی (title/artist)

### ❤️ Favorites
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/favorites` | لیست علاقه‌مندی‌ها |
| POST | `/api/favorites/toggle` | لایک/آنلایک |

**POST /api/favorites/toggle body:**
```json
{ "songId": "..." }
```

### 📋 Playlists
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/playlists` | لیست پلی‌لیست‌ها |
| POST | `/api/playlists` | ایجاد پلی‌لیست |
| DELETE | `/api/playlists/:id` | حذف پلی‌لیست |
| GET | `/api/playlists/:id/songs` | آهنگ‌های پلی‌لیست |
| POST | `/api/playlists/:id/songs` | افزودن آهنگ |
| DELETE | `/api/playlists/:id/songs/:songId` | حذف آهنگ |

### 🔊 Stream
| Method | Path | توضیح |
|--------|------|-------|
| POST | `/api/stream` | دریافت فایل صوتی (base64) |
| GET | `/api/stream/:token` | پخش با token موقت |

**POST /api/stream body:**
```json
{
  "fileId": "...",
  "channelUsername": "mymusic",
  "messageId": 123,
  "songId": "..."
}
```

**Response:**
```json
{
  "success": true,
  "audioData": "base64...",
  "streamUrl": "/api/stream/TOKEN",
  "cached": false,
  "size": 5242880,
  "expiresAt": "2026-06-17T..."
}
```

### 📥 Downloads
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/downloads` | لیست دانلودها |
| POST | `/api/downloads/start` | شروع دانلود |
| DELETE | `/api/downloads/:id` | حذف دانلود |

**Query params برای GET:**
- `status` - all/downloading/completed/failed
- `songId` - چک وضعیت یک آهنگ خاص

### 🔧 Proxy
| Method | Path | توضیح |
|--------|------|-------|
| GET | `/api/proxy` | دریافت تنظیمات |
| POST | `/api/proxy` | ذخیره تنظیمات |
| POST | `/api/proxy/test` | تست اتصال |

**POST /api/proxy body:**
```json
{
  "proxyType": "socks5",
  "proxyHost": "127.0.0.1",
  "proxyPort": 1080,
  "proxyUsername": "",
  "proxyPassword": ""
}
```

---

## 🔑 Authentication

تمام endpoint‌های محافظت‌شده نیاز به هدر دارند:
```
Authorization: Bearer <accessToken>
```

---

## 📱 Flutter - تغییر آدرس API

در فایل `lib/services/api_service.dart`:
```dart
static const String baseUrl = 'http://YOUR_SERVER_IP:3000/api';
```

---

## 🗄️ Collections MongoDB

| Collection | توضیح |
|-----------|-------|
| `users` | کاربران |
| `telegram_channels` | کانال‌های تلگرام |
| `telegram_songs` | آهنگ‌ها |
| `user_favorites` | علاقه‌مندی‌ها |
| `user_playlists` | پلی‌لیست‌ها |
| `user_downloads` | وضعیت دانلودها |
| `audio_cache` | فایل‌های کش شده |
| `stream_tokens` | توکن‌های موقت stream |
| `user_proxy_settings` | تنظیمات پروکسی |
