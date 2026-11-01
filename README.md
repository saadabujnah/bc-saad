# Crash Casino (BC.Game style)

لعبة **Crash** كاملة ومحاكية لمنصة BC.Game:

- واجهة أمامية داكنة نيون + رسم بياني حي على Canvas.
- خادم Node.js + Express + Socket.io يبث المضاعف كل 100ms.
- خوارزمية **Provably Fair** حقيقية بـ HMAC-SHA256.
- تكامل كامل مع **Supabase** (جداول + RLS + دوال ذرية للأرصدة).
- وضع **Demo** داخلي بالذاكرة يعمل بدون أي إعداد Supabase.

---

## 1. هيكل المشروع

```
crash-casino/
├── package.json
├── .env.example
├── supabase/
│   └── schema.sql          # كل جداول ووظائف Supabase
├── server/
│   ├── index.js            # Express + Socket.io + API
│   ├── engine.js           # دورة حياة الجولة والرهانات
│   ├── provablyFair.js     # HMAC-SHA256 + معادلة الانهيار
│   ├── db.js               # Supabase store + memory fallback
│   ├── config.js
│   └── errors.js
└── public/
    ├── bc.html             # الواجهة الرئيسية (تُخدم على / و /register)
    ├── index.html          # الواجهة السابقة (غير مستخدمة)
    ├── styles.css
    └── app.js
```

---

## 2. التشغيل السريع (وضع Demo بدون Supabase)

```bash
cd crash-casino
npm install
npm start
```

افتح: **http://localhost:3000**

بدون متغيرات بيئة سيعمل الخادم في وضع `memory` بمستخدم تجريبي واحد
(`demo_player`) ورصيد ابتدائي `$0`. هذا الوضع ممتاز لتجربة اللعبة فورًا.

---

## 3. ربط Supabase (الوضع الكامل)

### أ) إنشاء المشروع والجداول

1. أنشئ مشروعًا جديدًا على [supabase.com](https://supabase.com).
2. افتح **SQL Editor → New query**.
3. الصق كامل محتوى الملف `supabase/schema.sql` ثم اضغط **Run**.

هذا ينشئ:

| الجدول | الوصف |
| --- | --- |
| `profiles` | المستخدم + الرصيد (`balance`) + الاسم |
| `game_rounds` | كل جولة: `crash_point`, `server_seed`, `server_seed_hash`, `client_seed`, `nonce`, `status` |
| `bets` | كل رهان: المستخدم، الجولة، المبلغ، `cashout_multiplier`، `status`، `payout` |

كما ينشئ:

- Trigger `on_auth_user_created` لإنشاء profile تلقائيًا لكل مستخدم جديد برصيد 0.
- دوال ذرية: `place_bet`, `cashout_bet`, `settle_round`.
- سياسات RLS تمنع أي كتابة من المتصفح (كل الكتابة عبر الخادم بمفتاح `service_role`).

### ب) الحصول على المفاتيح

من **Project Settings → API**:

- `Project URL` → `SUPABASE_URL`
- `anon public` أو `Publishable key` (`sb_publishable_...`) → `SUPABASE_ANON_KEY`
- `service_role` أو `Secret key` (`sb_secret_...`) → `SUPABASE_SERVICE_ROLE_KEY` (**لا تضعه في الواجهة أبدًا**)

### ج) ملف `.env`

```bash
cp .env.example .env
```

ثم املأ:

```env
PORT=3000
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### د) تفعيل تسجيل الدخول

- **Authentication → Providers → Email**: فعّل Email.
- لتشغيل زر "Play as Guest": **Authentication → Settings → Anonymous sign-ins** = ON.
- إن أردت تسجيلًا فوريًا بدون تأكيد بريد: عطّل **Confirm email** مؤقتًا.
  (بدونه قد تظهر رسالة `email rate limit exceeded` لأن خدمة البريد المدمجة محدودة،
  أو استخدم SMTP مخصصًا.)
- صفحة التسجيل متاحة على `/register`، وتظهر تلقائيًا لزائر غير مسجّل،
  وتتضمن تبويبَي **Register** و **Sign In** مع حقل Username.

ثم:

```bash
npm start
```

---

## 4. كيف تعمل الجولة؟

1. **Waiting (6 ثوانٍ)**: الخادم ينشئ `serverSeed` عشوائي، ينشر `serverSeedHash = SHA256(serverSeed)` و`clientSeed` و`nonce`. يمكن للاعبين وضع الرهان.
2. **Running**: كل 100ms يبث Socket.io الحدث `tick` بالمضاعف الحالي:
   `multiplier = e^(0.12 × elapsedSeconds)`.
3. عند الوصول إلى `crashPoint`:
   - يُبث `round:crashed` مع `serverSeed` المكشوف.
   - تُسوّى الجولة: الرهانات النشطة تصبح `lost`.
4. **Crashed (2.5 ثانية)** ثم جولة جديدة.

### الخوارزمية (Provably Fair)

```
hash   = HMAC_SHA256(key = serverSeed, message = `${clientSeed}:${nonce}`)
r      = أول 52 بت من hash (13 حرف hex)
X      = r / 2^52
X      = 99 / (1 - X)
crash  = max(1, floor(X) / 100)
```

- `P(crash >= m) = 0.99 / m` أي هامش منزل 1%.
- قبل الجولة يُنشر فقط `SHA256(serverSeed)`، وبعد الانهيار يُكشف `serverSeed` للتحقق.

### التحقق من العدالة في الواجهة

اضغط **Provably Fair** أو أي رقم في شريط النتائج السابقة:

- يعرض hash البذرة الحالية و client seed و nonce.
- اختر جولة سابقة، وسيُعاد حساب نقطة الانهيار محليًا في المتصفح عبر CryptoJS.
- يتحقق أيضًا أن `SHA256(serverSeed)` يطابق الهاش المنشور.

---

## 5. واجهات API

| Method | Path | الوصف |
| --- | --- | --- |
| GET | `/api/config` | وضع التشغيل + مفاتيح Supabase العامة |
| GET | `/api/health` | حالة الخادم والجولة |
| GET | `/api/history` | آخر 20 جولة منتهية |
| GET | `/api/me` | بروفايل المستخدم (Bearer token) |

### أحداث Socket.io

**من الخادم للعميل**

| الحدث | الحمولة |
| --- | --- |
| `state` | الحالة الكاملة عند الاتصال |
| `round:waiting` | `serverSeedHash`, `clientSeed`, `nonce`, `startsAt` |
| `round:running` | `startedAt`, `growthRate` |
| `tick` | `multiplier`, `elapsed` (كل 100ms) |
| `round:crashed` | `crashPoint`, `serverSeed`, ... |
| `bets:list` | كل رهانات الجولة الحالية |
| `bet:placed` / `bet:cashout` | تحديث مباشر للرهانات |
| `balance` | رصيد المستخدم بعد أي عملية |
| `history` | آخر النتائج |

**من العميل للخادم**

| الحدث | الحمولة | الرد |
| --- | --- | --- |
| `bet` | `{ amount }` | `{ ok, bet, balance }` أو `{ ok:false, error }` |
| `cashout` | `{}` | `{ ok, bet, balance }` أو `{ ok:false, error }` |

المضاعف المستخدم عند السحب هو **قيمة الخادم الحالية**، وليس قيمة يرسلها العميل،
لذلك لا يمكن التلاعب بها.

---

## 6. الأمان وملاحظات مهمة

- مفتاح `service_role` يبقى في الخادم فقط، ولا يُرسل للمتصفح إطلاقًا.
- كل خصم/إضافة رصيد يتم داخل دوال PostgreSQL ذرية (`place_bet`, `cashout_bet`).
- RLS يمنع المستخدم من رؤية `crash_point` أو `server_seed` قبل انتهاء الجولة.
- لا يوجد قيد `unique` يمنع أكثر من رهان نشط لكل مستخدم في نفس الجولة؟ **يوجد**:
  `uniq_active_bet_per_round`.
- المشروع تعليمي/محاكاة. لا تستخدمه بمال حقيقي دون مراجعة قانونية وأمنية كاملة.

---

## 7. أوامر مفيدة

```bash
npm start        # تشغيل
npm run dev      # تشغيل مع إعادة تحميل تلقائية (Node 18+)
```
