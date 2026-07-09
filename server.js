/**
 * سيرفر بسيط لإرسال رمز تحقق (OTP) عبر SMS باستخدام Twilio (مزود عالمي)
 * ============================================================
 * ليه محتاجين السيرفر ده؟
 * مفتاح Twilio السري (Auth Token) لازم يفضل مخفي هنا على السيرفر،
 * وميتحطش أبدًا في كود صفحة الـ HTML لأن أي حد يقدر يشوفه (View Source).
 * الصفحة بتكلم السيرفر ده، والسيرفر هو بس اللي بيكلم Twilio.
 *
 * التشغيل:
 *   1) npm install
 *   2) cp .env.example .env   ثم املأ القيم من https://console.twilio.com
 *   3) npm start
 *   4) السيرفر هيشتغل على http://localhost:3000
 *
 * بعد كده لازم ترفع السيرفر ده على استضافة زي Render أو Railway أو Fly.io
 * عشان يبقى شغال 24 ساعة، وتحط رابطه في متغير BACKEND_URL جوه صفحة الـ HTML.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  PORT = 3000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
  console.warn(
    '⚠ تحذير: متغيرات Twilio مش متظبطة في ملف .env. الإرسال هيفشل لحد ما تظبطها.'
  );
}

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// تخزين مؤقت في الذاكرة: رقم الهاتف -> { code, expiresAt, attempts }
// ملاحظة: ده مناسب للتجربة وحجم استخدام بسيط. لمشروع إنتاجي حقيقي
// يُفضّل استخدام قاعدة بيانات أو Redis بدل الذاكرة العادية.
const otpStore = new Map();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const MAX_ATTEMPTS = 5;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 أرقام
}

function normalizePhone(phone) {
  // لازم يوصل بصيغة دولية كاملة مثل +201234567890
  return String(phone || '').trim();
}

// -------- إرسال رمز التحقق --------
app.post('/api/send-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);

    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({
        ok: false,
        error: 'رقم الهاتف لازم يكون بالصيغة الدولية الكاملة، مثال: ‎+201234567890',
      });
    }

    if (!client) {
      return res.status(500).json({
        ok: false,
        error: 'إعدادات Twilio ناقصة على السيرفر. راجع ملف .env',
      });
    }

    const code = generateOtp();
    otpStore.set(phone, {
      code,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    await client.messages.create({
      body: `رمز التحقق الخاص بك هو: ${code} (صالح لمدة 5 دقائق)`,
      from: TWILIO_FROM_NUMBER,
      to: phone,
    });

    return res.json({ ok: true, message: 'تم إرسال رمز التحقق' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'فشل إرسال الرسالة. تأكد من صحة الرقم وإعدادات Twilio ورصيد الحساب.',
    });
  }
});

// -------- التحقق من الرمز --------
app.post('/api/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();

  const record = otpStore.get(phone);

  if (!record) {
    return res.status(400).json({ ok: false, error: 'لا يوجد رمز مُرسل لهذا الرقم' });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ ok: false, error: 'انتهت صلاحية الرمز' });
  }

  record.attempts += 1;
  if (record.attempts > MAX_ATTEMPTS) {
    otpStore.delete(phone);
    return res.status(429).json({ ok: false, error: 'محاولات كثيرة جدًا، اطلب رمزًا جديدًا' });
  }

  if (record.code !== code) {
    return res.status(400).json({ ok: false, error: 'الرمز غير صحيح' });
  }

  otpStore.delete(phone); // الرمز يُستخدم مرة واحدة فقط
  return res.json({ ok: true, message: 'تم التحقق بنجاح' });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✓ السيرفر شغال على http://localhost:${PORT}`);
});
