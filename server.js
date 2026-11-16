
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();const DB_PATH = process.env.DB_PATH || path.join(__dirname, "bookings.sqlite");
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  booking_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const SERVICES = {
  groom: { name: "گریم داماد", price: 4000000, duration: 120 },
  hairbeard: { name: "اصلاح سر و ریش", price: 500000, duration: 45 },
  facial: { name: "پاک‌سازی پوست", price: 1000000, duration: 60 }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function minutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function hhmm(n) {
  return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00"));
}
function overlaps(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}
function isWithinBusinessHours(start, end) {
  return (start >= 600 && end <= 840) || (start >= 960 && end <= 1320);
}
function occupied(date, ignoreId = null) {
  return db.prepare(`
    SELECT id, start_time, end_time FROM bookings
    WHERE booking_date = ? AND status IN ('pending','approved') AND (? IS NULL OR id != ?)
  `).all(date, ignoreId, ignoreId);
}
function slotAvailable(date, start, duration, ignoreId = null) {
  const end = start + duration;
  if (!isWithinBusinessHours(start, end)) return false;
  return !occupied(date, ignoreId).some(b =>
    overlaps(start, end, minutes(b.start_time), minutes(b.end_time))
  );
}

app.get("/api/services", (req, res) => res.json(SERVICES));

app.get("/api/availability", (req, res) => {
  const date = req.query.date;
  const serviceId = req.query.service;
  if (!validDate(date) || !SERVICES[serviceId]) return res.status(400).json({error:"تاریخ یا خدمت نامعتبر است."});
  const duration = SERVICES[serviceId].duration;
  const slots = [];
  for (const [from, to] of [[600, 840], [960, 1320]]) {
    for (let t = from; t + duration <= to; t += 15) {
      if (slotAvailable(date, t, duration)) slots.push(hhmm(t));
    }
  }
  res.json({slots});
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};

  if (!ADMIN_TOKEN) {
    console.log("ADMIN_TOKEN is missing or empty");
    return res.status(503).json({
      error: "توکن مدیر در تنظیمات سرور تعریف نشده است."
    });
  }

  if (!ADMIN_PASSWORD) {
    console.log("ADMIN_PASSWORD is missing or empty");
    return res.status(503).json({
      error: "رمز مدیر در تنظیمات سرور تعریف نشده است."
    });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "رمز عبور اشتباه است."
    });
  }

  res.json({ ok: true, token: ADMIN_TOKEN });
});
  const { name, phone, serviceId, date, time, note } = req.body || {};
  if (!name || !phone || !SERVICES[serviceId] || !validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) {
    return res.status(400).json({error:"لطفاً اطلاعات رزرو را کامل و درست وارد کنید."});
  }
  if (name.trim().length < 2 || phone.replace(/\D/g,"").length < 10) {
    return res.status(400).json({error:"نام یا شماره موبایل معتبر نیست."});
  }
  const service = SERVICES[serviceId];
  const start = minutes(time);
  if (!slotAvailable(date, start, service.duration)) {
    return res.status(409).json({error:"این ساعت دیگر خالی نیست. لطفاً ساعت دیگری انتخاب کنید."});
  }
  const result = db.prepare(`
    INSERT INTO bookings (customer_name, phone, service_id, service_name, price, duration, booking_date, start_time, end_time, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), phone.trim(), serviceId, service.name, service.price, service.duration, date, time, hhmm(start + service.duration), (note || "").trim());
  res.json({ok:true, id:result.lastInsertRowid, status:"pending", message:"درخواست شما ثبت شد و پس از تأیید آرایشگاه قطعی می‌شود."});
});

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).json({error:"دسترسی مدیر تأیید نشد."});
  next();
}
app.post("/api/admin/login", (req, res) => {
  const {password} = req.body || {};
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({error:"توکن مدیر در تنظیمات سرور تعریف نشده است."});
  if (password !== ADMIN_PASSWORD) return res.status(401).json({error:"رمز عبور اشتباه است."});
  res.json({ok:true, token:process.env.ADMIN_TOKEN});
});
app.get("/api/admin/bookings", adminAuth, (req, res) => {
  const date = req.query.date;
  let rows;
  if (date && validDate(date)) rows = db.prepare("SELECT * FROM bookings WHERE booking_date=? ORDER BY start_time").all(date);
  else rows = db.prepare("SELECT * FROM bookings ORDER BY booking_date DESC, start_time DESC LIMIT 300").all();
  res.json(rows);
});
app.patch("/api/admin/bookings/:id", adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const {status} = req.body || {};
  if (!["approved","rejected"].includes(status)) return res.status(400).json({error:"وضعیت نامعتبر است."});
  const row = db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  if (!row) return res.status(404).json({error:"رزرو پیدا نشد."});
  if (status === "approved") {
    const conflict = occupied(row.booking_date, id).some(b =>
      overlaps(minutes(row.start_time), minutes(row.end_time), minutes(b.start_time), minutes(b.end_time))
    );
    if (conflict) return res.status(409).json({error:"با یک رزرو دیگر تداخل دارد."});
  }
  db.prepare("UPDATE bookings SET status=? WHERE id=?").run(status, id);
  res.json({ok:true});
});

app.listen(PORT, () => console.log(`Ghasr Barber running on ${PORT}`));
