/**
 * Antico Frantoio — Reservation API Server
 * Node.js + Express + PostgreSQL
 *
 * Roles: superadmin (full access) | admin (bookings) | staff (read-only)
 * Features: dynamic opening hours, flexible deposits, amendment emails,
 *           cancellation flow, role-based access, action logging
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Stripe = require('stripe');
const { body, param, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── PROXY & MIDDLEWARE ──────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { console.log(`${req.method} ${req.path}`); next(); });

const limiter = rateLimit({ windowMs: 15*60*1000, max: 100, validate: { xForwardedForHeader: false } });
const reservationLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: 'Too many reservation attempts.', validate: { xForwardedForHeader: false } });
app.use('/api/', limiter);

// ── DATABASE INIT ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      date DATE NOT NULL,
      time TIME NOT NULL,
      adults INTEGER NOT NULL DEFAULT 1,
      children INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      deposit_required BOOLEAN DEFAULT false,
      deposit_paid BOOLEAN DEFAULT false,
      payment_method VARCHAR(20) DEFAULT NULL,
      stripe_session_id VARCHAR(200),
      table_number INTEGER DEFAULT NULL,
      language VARCHAR(5) DEFAULT 'it',
      source VARCHAR(20) DEFAULT 'online',
      reminder_sent BOOLEAN DEFAULT false,
      created_by VARCHAR(100) DEFAULT NULL,
      cancelled_by VARCHAR(100) DEFAULT NULL,
      amended_by VARCHAR(100) DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS special_closures (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      reason VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS partial_closures (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      block_from TIME NOT NULL,
      block_until TIME NOT NULL,
      reason VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS special_hours (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      hours JSONB NOT NULL,
      reason VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS opening_hours (
      day_of_week INTEGER PRIMARY KEY CHECK (day_of_week BETWEEN 0 AND 6),
      is_open BOOLEAN DEFAULT false,
      hours JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS deposit_dates (
      id SERIAL PRIMARY KEY,
      date_value VARCHAR(10) NOT NULL,
      is_recurring BOOLEAN DEFAULT false,
      reason VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(200) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'staff',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO settings (key, value) VALUES
      ('deposit_amount', '25'),
      ('deposit_required_weekends', 'true'),
      ('deposit_required_always', 'false'),
      ('deposit_required_never', 'false'),
      ('max_tables_per_slot', '8'),
      ('total_tables', '15'),
      ('max_guests_per_slot', '45'),
      ('slot_duration_minutes', '60'),
      ('min_booking_notice_hours', '3'),
      ('restaurant_email', ''),
      ('restaurant_name', 'Antico Frantoio')
    ON CONFLICT (key) DO NOTHING;

    INSERT INTO opening_hours (day_of_week, is_open, hours) VALUES
      (0, true,  '[["12:00","15:30"],["18:30","23:00"]]'),
      (1, false, '[]'),
      (2, true,  '[["12:00","15:00"],["18:30","23:00"]]'),
      (3, true,  '[["12:00","15:00"],["18:30","23:00"]]'),
      (4, true,  '[["12:00","15:00"],["18:30","23:00"]]'),
      (5, true,  '[["12:00","15:00"],["18:30","23:00"]]'),
      (6, true,  '[["12:00","15:00"],["18:30","23:00"]]')
    ON CONFLICT (day_of_week) DO NOTHING;

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(100) DEFAULT NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amended_by VARCHAR(100) DEFAULT NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS table_number INTEGER DEFAULT NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'online';
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;
  `);

  // Create default superadmin if no users exist
  const userCount = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(userCount.rows[0].count) === 0) {
    const hash = await bcrypt.hash('anticofrantoio2025', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'superadmin') ON CONFLICT DO NOTHING`,
      ['admin', hash]
    );
    console.log('✅ Default superadmin created: admin / anticofrantoio2025');
  }
  console.log('✅ Database initialized');
}

// ── HELPERS ─────────────────────────────────────────────────────
async function getSetting(key) {
  const res = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return res.rows[0]?.value;
}

// Opening hours cache
let ohCache = null;
let ohCacheTime = 0;
async function getOpeningHours() {
  if (ohCache && Date.now() - ohCacheTime < 60000) return ohCache;
  const res = await pool.query('SELECT * FROM opening_hours ORDER BY day_of_week');
  ohCache = {};
  res.rows.forEach(r => {
    ohCache[r.day_of_week] = r.is_open ? (Array.isArray(r.hours) ? r.hours : JSON.parse(r.hours || '[]')) : null;
  });
  ohCacheTime = Date.now();
  return ohCache;
}
function invalidateOHCache() { ohCache = null; }

function generateSlotsFromHours(hours, slotDuration) {
  const slots = [];
  (hours || []).forEach(([open, close]) => {
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    let cur = oh * 60 + om;
    const end = ch * 60 + cm;
    while (cur + slotDuration <= end) {
      slots.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
      cur += 30;
    }
  });
  return slots;
}

async function generateSlots(date, slotDuration = 60) {
  const dayOfWeek = new Date(date + 'T00:00:00').getDay();

  const closure = await pool.query('SELECT 1 FROM special_closures WHERE date=$1', [date]);
  if (closure.rows.length) return [];

  const specialHours = await pool.query('SELECT hours FROM special_hours WHERE date=$1', [date]);
  let hours;
  if (specialHours.rows.length) {
    hours = specialHours.rows[0].hours;
    if (!hours || hours.length === 0) return [];
  } else {
    const oh = await getOpeningHours();
    hours = oh[dayOfWeek];
    if (!hours) return [];
  }

  let slots = generateSlotsFromHours(hours, slotDuration);

  const partials = await pool.query('SELECT block_from, block_until FROM partial_closures WHERE date=$1', [date]);
  if (partials.rows.length) {
    slots = slots.filter(slot => {
      const [sh, sm] = slot.split(':').map(Number);
      const slotMin = sh * 60 + sm;
      return !partials.rows.some(p => {
        const [fh, fm] = p.block_from.substring(0,5).split(':').map(Number);
        const [uh, um] = p.block_until.substring(0,5).split(':').map(Number);
        return slotMin >= fh*60+fm && slotMin < uh*60+um;
      });
    });
  }
  return slots;
}

function isWeekend(date) {
  const d = new Date(date + 'T00:00:00').getDay();
  return d === 0 || d === 6;
}

async function requiresDeposit(date) {
  const never = await getSetting('deposit_required_never') === 'true';
  if (never) return false;
  const always = await getSetting('deposit_required_always') === 'true';
  if (always) return true;

  const dt = new Date(date + 'T00:00:00');
  const mmdd = `${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const depositDates = await pool.query('SELECT * FROM deposit_dates');
  for (const dd of depositDates.rows) {
    if (dd.is_recurring && dd.date_value === mmdd) return true;
    if (!dd.is_recurring && dd.date_value === date) return true;
  }

  const weekendRequired = await getSetting('deposit_required_weekends') === 'true';
  if (weekendRequired && isWeekend(date)) return true;
  return false;
}

async function getSlotAvailability(date, time, excludeBookingId = null) {
  const maxTables = parseInt(await getSetting('max_tables_per_slot')) || 8;
  const maxGuests = parseInt(await getSetting('max_guests_per_slot')) || 45;
  let query = `SELECT COUNT(*) as tables, COALESCE(SUM(adults + children), 0) as guests FROM bookings WHERE date=$1 AND time=$2 AND status != 'cancelled'`;
  const params = [date, time];
  if (excludeBookingId) { params.push(excludeBookingId); query += ` AND id != $${params.length}`; }
  const result = await pool.query(query, params);
  const tablesUsed = parseInt(result.rows[0].tables) || 0;
  const guestsIn = parseInt(result.rows[0].guests) || 0;
  return {
    tablesUsed, tablesAvail: maxTables - tablesUsed,
    guestsIn, guestsAvail: maxGuests - guestsIn,
    available: tablesUsed < maxTables && guestsIn < maxGuests,
  };
}

// ── DATE HELPERS ─────────────────────────────────────────────────
function formatDateDisplay(date) {
  // Returns dd/mm/yyyy from any date input
  try {
    const d = new Date(typeof date === 'string' && date.length === 10 ? date + 'T00:00:00' : date);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  } catch { return String(date); }
}

function formatDateLong(date, lang) {
  try {
    const d = new Date(typeof date === 'string' && date.length === 10 ? date + 'T00:00:00' : date);
    return d.toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  } catch { return String(date); }
}

function formatTime(time) {
  return typeof time === 'string' ? time.substring(0,5) : String(time);
}

// ── EMAIL SERVICE ────────────────────────────────────────────────
async function sendEmail({ to, toName, subject, html }) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Antico Frantoio', email: process.env.BREVO_FROM || 'salvatore.dalessandro01@gmail.com' },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
      }),
    });
    clearTimeout(timeout);
    const data = await response.json();
    if (!response.ok) { console.error('Brevo error:', JSON.stringify(data)); return false; }
    console.log('Email sent to:', to);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
}

function emailWrapper(content) {
  return `<div style="font-family:'Georgia',serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1A1612">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-size:2rem;font-weight:300;color:#C9A84C;margin:0">Antico Frantoio</h1>
      <p style="color:#6B6460;font-size:.85rem;letter-spacing:.1em;text-transform:uppercase">Via Casarlano 5, 80067 Sorrento (NA), Italia</p>
    </div>
    <hr style="border:none;border-top:1px solid #D4CEC8;margin-bottom:32px">
    ${content}
    <hr style="border:none;border-top:1px solid #D4CEC8;margin:24px 0">
    <p style="color:#6B6460;font-size:.85rem;line-height:1.6;text-align:center">
      Per informazioni: <a href="tel:+390818072200" style="color:#C9A84C">+39 081 807 22 00</a>
    </p>
    <div style="text-align:center;margin-top:24px">
      <p style="color:#C9A84C;font-size:1.1rem;font-style:italic">Antico Frantoio</p>
    </div>
  </div>`;
}

function buildBookingTable(booking, lang) {
  const isIT = lang === 'it';
  const rows = [
    [isIT?'Nome':'Name', booking.name],
    [isIT?'Data':'Date', formatDateLong(booking.date, lang)],
    [isIT?'Orario':'Time', formatTime(booking.time)],
    [isIT?'Ospiti':'Guests', `${booking.adults} ${isIT?'adulti':'adults'}, ${booking.children} ${isIT?'bambini':'children'}`],
    ...(booking.phone ? [[isIT?'Telefono':'Phone', booking.phone]] : []),
    ...(booking.notes ? [[isIT?'Note':'Notes', booking.notes]] : []),
    ...(booking.deposit_required ? [[isIT?'Caparra':'Deposit', booking.deposit_paid?(isIT?'Pagata ✓':'Paid ✓'):(isIT?'Non pagata':'Unpaid')]] : []),
  ];
  return `<table style="width:100%;border-collapse:collapse;margin:20px 0">
    ${rows.map(([k,v]) => `<tr>
      <td style="padding:8px 0;color:#6B6460;font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;width:130px">${k}</td>
      <td style="padding:8px 0;font-size:.9rem"><strong>${v}</strong></td>
    </tr>`).join('')}
  </table>`;
}

// ── EMAIL SENDERS ────────────────────────────────────────────────
async function sendConfirmationEmail(booking, lang = 'it') {
  const isIT = lang === 'it';
  const cancelUrl = `${process.env.FRONTEND_URL || 'https://your-site.vercel.app'}?cancel=${booking.id}`;

  const cancelBlock = `<div style="background:#FAF7F2;border-radius:4px;padding:14px;margin:16px 0;text-align:center">
    <p style="color:#6B6460;font-size:.82rem;margin:0 0 8px">${isIT?'Hai bisogno di cancellare?':'Need to cancel?'}</p>
    <a href="${cancelUrl}" style="color:#A33030;font-size:.82rem">${isIT?'Clicca qui per cancellare la prenotazione':'Click here to cancel your reservation'}</a>
  </div>`;

  await sendEmail({
    to: booking.email, toName: booking.name,
    subject: isIT
      ? `Prenotazione confermata — ${formatDateLong(booking.date,lang)} ${formatTime(booking.time)}`
      : `Reservation confirmed — ${formatDateLong(booking.date,lang)} ${formatTime(booking.time)}`,
    html: emailWrapper(`
      <h2 style="font-weight:300;font-size:1.4rem;margin-bottom:8px">${isIT?'La tua prenotazione è confermata ✓':'Your reservation is confirmed ✓'}</h2>
      ${buildBookingTable(booking, lang)}
      ${cancelBlock}
    `),
  });

  const restaurantEmail = await getSetting('restaurant_email');
  if (restaurantEmail?.trim()) {
    const source = booking.source === 'manual' ? '📞 Telefono' : '🌐 Online';
    const createdBy = booking.created_by ? ` · Inserita da: <strong>${booking.created_by}</strong>` : '';
    await sendEmail({
      to: restaurantEmail.trim(), toName: 'Antico Frantoio',
      subject: `🍽️ Nuova prenotazione — ${booking.name} — ${formatDateDisplay(booking.date)} ${formatTime(booking.time)}`,
      html: emailWrapper(`
        <h2 style="font-weight:300;font-size:1.4rem;margin-bottom:8px">Nuova prenotazione ricevuta</h2>
        ${buildBookingTable(booking, 'it')}
        <div style="background:#C9A84C15;border-radius:4px;padding:10px;font-size:.82rem;color:#8A6820">
          Fonte: ${source}${createdBy}
        </div>
      `),
    });
  }
}

async function sendAmendmentEmail(booking, lang = 'it') {
  const isIT = lang === 'it';
  const cancelUrl = `${process.env.FRONTEND_URL || 'https://your-site.vercel.app'}?cancel=${booking.id}`;

  await sendEmail({
    to: booking.email, toName: booking.name,
    subject: isIT
      ? `Prenotazione modificata — ${formatDateLong(booking.date,lang)} ${formatTime(booking.time)}`
      : `Reservation amended — ${formatDateLong(booking.date,lang)} ${formatTime(booking.time)}`,
    html: emailWrapper(`
      <h2 style="font-weight:300;font-size:1.4rem;margin-bottom:8px">${isIT?'La tua prenotazione è stata modificata':'Your reservation has been updated'}</h2>
      <div style="background:#C9A84C15;border-radius:4px;padding:12px;margin-bottom:16px;font-size:.85rem;color:#8A6820;text-align:center">
        ${isIT?'Di seguito i dettagli aggiornati della tua prenotazione.':'Below are the updated details of your reservation.'}
      </div>
      ${buildBookingTable(booking, lang)}
      <div style="background:#FAF7F2;border-radius:4px;padding:14px;margin:16px 0;text-align:center">
        <p style="color:#6B6460;font-size:.82rem;margin:0 0 8px">${isIT?'Hai bisogno di cancellare?':'Need to cancel?'}</p>
        <a href="${cancelUrl}" style="color:#A33030;font-size:.82rem">${isIT?'Clicca qui per cancellare':'Click here to cancel'}</a>
      </div>
    `),
  });

  const restaurantEmail = await getSetting('restaurant_email');
  if (restaurantEmail?.trim()) {
    const amendedBy = booking.amended_by ? ` · Modificata da: <strong>${booking.amended_by}</strong>` : '';
    await sendEmail({
      to: restaurantEmail.trim(), toName: 'Antico Frantoio',
      subject: `✏️ Prenotazione modificata — ${booking.name} — ${formatDateDisplay(booking.date)} ${formatTime(booking.time)}`,
      html: emailWrapper(`
        <h2 style="font-weight:300;font-size:1.4rem;margin-bottom:8px">Prenotazione modificata</h2>
        ${buildBookingTable(booking, 'it')}
        <div style="background:#C9A84C15;border-radius:4px;padding:10px;font-size:.82rem;color:#8A6820">${amendedBy}</div>
      `),
    });
  }
}

async function sendCancellationEmail(booking) {
  const lang = booking.language || 'it';
  const isIT = lang === 'it';

  await sendEmail({
    to: booking.email, toName: booking.name,
    subject: isIT
      ? `Prenotazione cancellata — ${formatDateDisplay(booking.date)}`
      : `Reservation cancelled — ${formatDateDisplay(booking.date)}`,
    html: emailWrapper(`
      <div style="text-align:center;padding:20px 0">
        <div style="width:4rem;height:4rem;background:#A3303015;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;font-size:1.75rem">✗</div>
        <h2 style="font-weight:300;font-size:1.5rem;margin-bottom:12px">${isIT?'Prenotazione cancellata':'Reservation cancelled'}</h2>
        <p style="color:#6B6460;font-size:.9rem;margin-bottom:24px">${isIT?'La tua prenotazione è stata cancellata con successo.':'Your reservation has been successfully cancelled.'}</p>
      </div>
      ${buildBookingTable(booking, lang)}
      <div style="text-align:center;margin-top:16px">
        <p style="color:#6B6460;font-size:.85rem">${isIT?'Speriamo di rivederti presto!':'We hope to see you soon!'}</p>
      </div>
    `),
  });

  const restaurantEmail = await getSetting('restaurant_email');
  if (restaurantEmail?.trim()) {
    const cancelledBy = booking.cancelled_by ? ` · Ann. da: <strong>${booking.cancelled_by}</strong>` : ' · Ann. dal cliente';
    await sendEmail({
      to: restaurantEmail.trim(), toName: 'Antico Frantoio',
      subject: `❌ Cancellazione — ${booking.name} — ${formatDateDisplay(booking.date)} ${formatTime(booking.time)}`,
      html: emailWrapper(`
        <div style="background:#A3303015;border-radius:4px;padding:12px;margin-bottom:16px;text-align:center;color:#A33030">
          <strong>Prenotazione cancellata</strong>
        </div>
        ${buildBookingTable(booking, 'it')}
        <div style="background:#fafafa;border-radius:4px;padding:10px;font-size:.82rem;color:#6B6460">${cancelledBy}</div>
      `),
    });
  }
}

async function sendReminderEmail(booking) {
  const lang = booking.language || 'it';
  const isIT = lang === 'it';
  const cancelUrl = `${process.env.FRONTEND_URL || 'https://your-site.vercel.app'}?cancel=${booking.id}`;
  await sendEmail({
    to: booking.email, toName: booking.name,
    subject: isIT
      ? `⏰ Promemoria — domani alle ${formatTime(booking.time)} da Antico Frantoio`
      : `⏰ Reminder — tomorrow at ${formatTime(booking.time)} at Antico Frantoio`,
    html: emailWrapper(`
      <div style="background:#C9A84C15;border:1px solid #C9A84C55;border-radius:4px;padding:14px;margin-bottom:20px;text-align:center">
        <p style="color:#8A6820;font-size:1rem;font-weight:bold;margin:0">${isIT?'⏰ La tua prenotazione è domani!':'⏰ Your reservation is tomorrow!'}</p>
      </div>
      ${buildBookingTable(booking, lang)}
      <div style="text-align:center;margin-top:16px">
        <a href="${cancelUrl}" style="color:#A33030;font-size:.82rem">${isIT?'Cancella la prenotazione':'Cancel reservation'}</a>
      </div>
    `),
  });
  await pool.query('UPDATE bookings SET reminder_sent=true WHERE id=$1', [booking.id]);
  console.log('Reminder sent to:', booking.email);
}

async function processReminders() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const result = await pool.query(`SELECT * FROM bookings WHERE date=$1 AND status='confirmed' AND reminder_sent=false`, [tomorrowStr]);
  for (const booking of result.rows) await sendReminderEmail(booking);
  console.log(`Processed ${result.rows.length} reminders for ${tomorrowStr}`);
  return result.rows.length;
}

// ── AUTH ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Role hierarchy: superadmin > admin > staff
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

const superadminOnly = requireRole('superadmin');
const adminOrAbove = requireRole('superadmin', 'admin');

// ── PUBLIC ROUTES ────────────────────────────────────────────────

// GET /api/availability
app.get('/api/availability', async (req, res) => {
  try {
    const { date, adults = 2 } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });

    const closure = await pool.query('SELECT reason FROM special_closures WHERE date=$1', [date]);
    if (closure.rows.length) return res.json({ available: false, reason: 'closed', closureReason: closure.rows[0].reason });

    const minNoticeHours = parseInt(await getSetting('min_booking_notice_hours')) || 3;
    const hoursUntil = (new Date(date+'T00:00:00') - new Date()) / (1000*60*60);
    if (hoursUntil < minNoticeHours) return res.json({ available: false, reason: 'too_soon', minNoticeHours });

    const slotDuration = parseInt(await getSetting('slot_duration_minutes')) || 60;
    const slots = await generateSlots(date, slotDuration);
    if (!slots.length) return res.json({ available: false, reason: 'closed' });

    const slotsWithAvail = await Promise.all(slots.map(async time => {
      const avail = await getSlotAvailability(date, time);
      return { time, available: avail.available && avail.tablesAvail >= 1, tablesLeft: avail.tablesAvail };
    }));

    const depositReq = await requiresDeposit(date);
    const depositAmt = parseInt(await getSetting('deposit_amount')) || 25;

    res.json({
      available: slotsWithAvail.some(s => s.available),
      date, slots: slotsWithAvail,
      depositRequired: depositReq,
      depositAmount: depositReq ? depositAmt * parseInt(adults) : 0,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/reservations — Online booking
app.post('/api/reservations', reservationLimiter, [
  body('name').trim().isLength({ min:2, max:100 }).escape(),
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().isLength({ min:6, max:30 }),
  body('date').isDate(),
  body('time').matches(/^\d{2}:\d{2}$/),
  body('adults').isInt({ min:1, max:20 }),
  body('children').isInt({ min:0, max:10 }),
  body('notes').optional().trim().isLength({ max:500 }).escape(),
  body('payDeposit').optional().isBoolean(),
  body('language').optional().isIn(['it','en']),
  body('gdprConsent').equals('true'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { name, email, phone, date, time, adults, children, notes, payDeposit, language = 'it' } = req.body;
  try {
    const closure = await pool.query('SELECT 1 FROM special_closures WHERE date=$1', [date]);
    if (closure.rows.length) return res.status(409).json({ error: 'Restaurant closed on this date' });

    const minNoticeHours = parseInt(await getSetting('min_booking_notice_hours')) || 3;
    const hoursUntil = (new Date(date+'T00:00:00') - new Date()) / (1000*60*60);
    if (hoursUntil < minNoticeHours) return res.status(400).json({ error: 'too_soon', minNoticeHours });

    const validSlots = await generateSlots(date);
    if (!validSlots.includes(time)) return res.status(400).json({ error: 'Invalid time slot' });

    const avail = await getSlotAvailability(date, time);
    if (!avail.available) return res.status(409).json({ error: 'No availability', code: 'SLOT_FULL' });

    const depositReq = await requiresDeposit(date);
    const depositAmt = parseInt(await getSetting('deposit_amount')) || 25;
    const depositTotal = depositReq ? depositAmt * parseInt(adults) : 0;
    const status = (depositReq && payDeposit) ? 'pending' : 'confirmed';

    const result = await pool.query(`
      INSERT INTO bookings (name,email,phone,date,time,adults,children,notes,status,deposit_required,language,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'online') RETURNING *
    `, [name, email, phone, date, time, adults, children, notes, status, depositReq, language]);

    const booking = result.rows[0];

    if (depositReq && payDeposit) {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price_data: { currency:'eur', unit_amount:depositTotal*100, product_data:{ name:'Caparra — Antico Frantoio', description:`${date} ${time} · ${adults} persone` } }, quantity:1 }],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}?booking=${booking.id}&paid=1`,
        cancel_url: `${process.env.FRONTEND_URL}?cancelled=1`,
        customer_email: email,
        metadata: { bookingId: booking.id },
      });
      await pool.query('UPDATE bookings SET stripe_session_id=$1 WHERE id=$2', [session.id, booking.id]);
      return res.status(201).json({ booking:{ id:booking.id, status:'pending' }, stripeUrl:session.url, requiresPayment:true });
    }

    await sendConfirmationEmail(booking, language);
    res.status(201).json({ booking:{ id:booking.id, status:'confirmed' }, requiresPayment:false });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/booking/:id — Get booking details (for cancellation page)
app.get('/api/booking/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const result = await pool.query('SELECT id,name,email,date,time,adults,children,notes,status,deposit_required,deposit_paid,language FROM bookings WHERE id=$1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = result.rows[0];
    // Format date for display
    b.date_display = formatDateDisplay(b.date);
    b.time_display = formatTime(b.time);
    res.json({ booking: b });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/cancel/:id — Customer cancellation (now POST from confirmation page)
app.post('/api/cancel/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const booking = result.rows[0];

    if (booking.status === 'cancelled') return res.json({ success: true, message: 'already_cancelled' });

    const hoursUntil = (new Date(booking.date+'T00:00:00') - new Date()) / (1000*60*60);
    if (hoursUntil < 24) return res.status(400).json({ error: 'too_late', message: 'Cancellations must be made at least 24 hours in advance.' });

    await pool.query(`UPDATE bookings SET status='cancelled', cancelled_by='customer', updated_at=NOW() WHERE id=$1`, [id]);

    // Send emails
    const updatedBooking = { ...booking, status: 'cancelled', cancelled_by: 'customer' };
    await sendCancellationEmail(updatedBooking);

    res.json({ success: true, booking: { name: booking.name, date_display: formatDateDisplay(booking.date), time_display: formatTime(booking.time) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Stripe webhook
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await pool.query(`UPDATE bookings SET status='confirmed',deposit_paid=true,payment_method='card',updated_at=NOW() WHERE id=$1`, [session.metadata.bookingId]);
    const bRes = await pool.query('SELECT * FROM bookings WHERE id=$1', [session.metadata.bookingId]);
    if (bRes.rows.length) await sendConfirmationEmail(bRes.rows[0], bRes.rows[0].language);
  }
  res.json({ received: true });
});

// Reminder trigger
app.post('/api/reminders/send', async (req, res) => {
  if (req.headers['x-reminder-secret'] !== process.env.REMINDER_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const count = await processReminders();
  res.json({ success: true, remindersSent: count });
});

// ── ADMIN LOGIN ──────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1 AND active=true', [username]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ username: user.username, role: user.role, id: user.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, role: user.role, username: user.username });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── ADMIN BOOKINGS ───────────────────────────────────────────────

// All roles can read bookings
app.get('/api/admin/bookings', authMiddleware, async (req, res) => {
  const { date, status, source, search, page = 1, limit = 100 } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (date) { params.push(date); query += ` AND date=$${params.length}`; }
  if (status) { params.push(status); query += ` AND status=$${params.length}`; }
  if (source) { params.push(source); query += ` AND source=$${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }
  query += ` ORDER BY date DESC, time ASC LIMIT ${parseInt(limit)} OFFSET ${(parseInt(page)-1)*parseInt(limit)}`;
  const result = await pool.query(query, params);
  // Format dates for display
  const bookings = result.rows.map(b => ({
    ...b,
    date_display: formatDateDisplay(b.date),
    time_display: formatTime(b.time),
  }));
  res.json({ bookings });
});

// Admin and above: create manual booking
app.post('/api/admin/bookings', authMiddleware, adminOrAbove, [
  body('name').trim().isLength({ min:2, max:100 }),
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().isLength({ min:6, max:30 }),
  body('date').isDate(),
  body('time').matches(/^\d{2}:\d{2}$/),
  body('adults').isInt({ min:1, max:20 }),
  body('children').isInt({ min:0, max:10 }),
  body('notes').optional().trim().isLength({ max:500 }),
  body('language').optional().isIn(['it','en']),
  body('table_number').optional({ nullable:true }),
  body('payment_method').optional({ nullable:true }).isIn(['cash','card','bank_transfer','']),
  body('deposit_paid').optional().isBoolean(),
  body('send_email').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { name, email, phone, date, time, adults, children, notes, language='it', table_number, payment_method, deposit_paid=false, send_email=true } = req.body;
  try {
    const depositReq = await requiresDeposit(date);
    const result = await pool.query(`
      INSERT INTO bookings (name,email,phone,date,time,adults,children,notes,status,deposit_required,deposit_paid,payment_method,table_number,language,source,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,$12,$13,'manual',$14) RETURNING *
    `, [name,email,phone,date,time,adults,children,notes,depositReq,deposit_paid,payment_method||null,table_number||null,language,req.user.username]);
    const booking = result.rows[0];
    if (send_email) await sendConfirmationEmail(booking, language);
    res.status(201).json({ booking: { ...booking, date_display:formatDateDisplay(booking.date), time_display:formatTime(booking.time) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Admin and above: amend booking (date, time, guests, notes, table, payment, status)
app.patch('/api/admin/bookings/:id', authMiddleware, adminOrAbove, [
  param('id').isUUID(),
  body('status').optional().isIn(['confirmed','pending','cancelled']),
  body('date').optional().isDate(),
  body('time').optional().matches(/^\d{2}:\d{2}$/),
  body('adults').optional().isInt({ min:1, max:20 }),
  body('children').optional().isInt({ min:0, max:10 }),
  body('notes').optional().trim().isLength({ max:500 }),
  body('table_number').optional({ nullable:true }),
  body('payment_method').optional({ nullable:true }).isIn(['cash','card','bank_transfer','']),
  body('deposit_paid').optional().isBoolean(),
  body('send_amendment_email').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { id } = req.params;
  const { status, date, time, adults, children, notes, table_number, payment_method, deposit_paid, send_amendment_email = true } = req.body;

  // If date or time changed, check availability (excluding this booking)
  if (date || time) {
    const currentRes = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    if (!currentRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
    const current = currentRes.rows[0];
    const newDate = date || current.date.toISOString().split('T')[0];
    const newTime = time || formatTime(current.time);
    const avail = await getSlotAvailability(newDate, newTime, id);
    if (!avail.available) return res.status(409).json({ error: 'No availability for the new slot', code: 'SLOT_FULL' });
  }

  const updates = []; const params = [];
  const isAmendment = date || time || adults !== undefined || children !== undefined;

  if (status !== undefined) { params.push(status); updates.push(`status=$${params.length}`); }
  if (date !== undefined) { params.push(date); updates.push(`date=$${params.length}`); }
  if (time !== undefined) { params.push(time); updates.push(`time=$${params.length}`); }
  if (adults !== undefined) { params.push(adults); updates.push(`adults=$${params.length}`); }
  if (children !== undefined) { params.push(children); updates.push(`children=$${params.length}`); }
  if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
  if (table_number !== undefined) { params.push(table_number||null); updates.push(`table_number=$${params.length}`); }
  if (payment_method !== undefined) { params.push(payment_method||null); updates.push(`payment_method=$${params.length}`); }
  if (deposit_paid !== undefined) { params.push(deposit_paid); updates.push(`deposit_paid=$${params.length}`); }

  if (isAmendment) { params.push(req.user.username); updates.push(`amended_by=$${params.length}`); }
  if (status === 'cancelled') { params.push(req.user.username); updates.push(`cancelled_by=$${params.length}`); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(id);
  await pool.query(`UPDATE bookings SET ${updates.join(',')},updated_at=NOW() WHERE id=$${params.length}`, params);

  // Fetch updated booking
  const bRes = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
  const updatedBooking = bRes.rows[0];

  // Send cancellation email if cancelled
  if (status === 'cancelled' && updatedBooking) {
    await sendCancellationEmail({ ...updatedBooking, cancelled_by: req.user.username });
  }

  // Send amendment email whenever send_amendment_email is true and not cancelled
  if (send_amendment_email && status !== 'cancelled' && updatedBooking) {
    console.log('Sending amendment email to:', updatedBooking.email);
    await sendAmendmentEmail({ ...updatedBooking, amended_by: req.user.username }, updatedBooking.language || 'it');
  }

  const b = updatedBooking;
  res.json({ success:true, booking:{ ...b, date_display:formatDateDisplay(b.date), time_display:formatTime(b.time) } });
});

// Admin and above: cancel booking
app.delete('/api/admin/bookings/:id', authMiddleware, adminOrAbove, async (req, res) => {
  const result = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
  if (result.rows.length) {
    await pool.query(`UPDATE bookings SET status='cancelled',cancelled_by=$1,updated_at=NOW() WHERE id=$2`, [req.user.username, req.params.id]);
    await sendCancellationEmail({ ...result.rows[0], status:'cancelled', cancelled_by:req.user.username });
  }
  res.json({ success: true });
});

// ── OPENING HOURS ────────────────────────────────────────────────
app.get('/api/admin/opening-hours', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM opening_hours ORDER BY day_of_week');
  res.json({ openingHours: result.rows });
});
app.patch('/api/admin/opening-hours/:day', authMiddleware, superadminOnly, [
  param('day').isInt({ min:0, max:6 }),
  body('is_open').isBoolean(),
  body('hours').isArray(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { day } = req.params;
  const { is_open, hours } = req.body;
  await pool.query(`INSERT INTO opening_hours (day_of_week,is_open,hours) VALUES ($1,$2,$3) ON CONFLICT (day_of_week) DO UPDATE SET is_open=$2,hours=$3`, [day, is_open, JSON.stringify(hours)]);
  invalidateOHCache();
  res.json({ success: true });
});

// ── SETTINGS ─────────────────────────────────────────────────────
app.get('/api/admin/settings', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT key, value FROM settings');
  res.json(Object.fromEntries(result.rows.map(r => [r.key, r.value])));
});
app.patch('/api/admin/settings', authMiddleware, superadminOnly, async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await pool.query(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()`, [key, String(value)]);
  }
  res.json({ success: true });
});

// ── CLOSURES ─────────────────────────────────────────────────────
app.get('/api/admin/closures', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM special_closures ORDER BY date');
  res.json({ closures: result.rows });
});
app.post('/api/admin/closures', authMiddleware, superadminOnly, [body('date').isDate(), body('reason').optional().trim()], async (req, res) => {
  try { await pool.query('INSERT INTO special_closures (date,reason) VALUES ($1,$2)', [req.body.date, req.body.reason]); res.status(201).json({ success:true }); }
  catch { res.status(409).json({ error:'Date already blocked' }); }
});
app.delete('/api/admin/closures/:id', authMiddleware, superadminOnly, async (req, res) => {
  await pool.query('DELETE FROM special_closures WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

// ── PARTIAL CLOSURES ─────────────────────────────────────────────
app.get('/api/admin/partial-closures', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM partial_closures ORDER BY date,block_from');
  res.json({ partialClosures: result.rows });
});
app.post('/api/admin/partial-closures', authMiddleware, superadminOnly, [
  body('date').isDate(), body('block_from').matches(/^\d{2}:\d{2}$/), body('block_until').matches(/^\d{2}:\d{2}$/), body('reason').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { date, block_from, block_until, reason } = req.body;
  if (block_from >= block_until) return res.status(400).json({ error:'block_from must be before block_until' });
  const result = await pool.query('INSERT INTO partial_closures (date,block_from,block_until,reason) VALUES ($1,$2,$3,$4) RETURNING *', [date,block_from,block_until,reason||null]);
  res.status(201).json({ partialClosure:result.rows[0] });
});
app.delete('/api/admin/partial-closures/:id', authMiddleware, superadminOnly, async (req, res) => {
  await pool.query('DELETE FROM partial_closures WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

// ── SPECIAL HOURS ────────────────────────────────────────────────
app.get('/api/admin/special-hours', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM special_hours ORDER BY date');
  res.json({ specialHours: result.rows });
});
app.post('/api/admin/special-hours', authMiddleware, superadminOnly, [body('date').isDate(), body('hours').isArray(), body('reason').optional().trim()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { date, hours, reason } = req.body;
  const result = await pool.query(`INSERT INTO special_hours (date,hours,reason) VALUES ($1,$2,$3) ON CONFLICT (date) DO UPDATE SET hours=$2,reason=$3,created_at=NOW() RETURNING *`, [date,JSON.stringify(hours),reason||null]);
  res.status(201).json({ specialHours:result.rows[0] });
});
app.delete('/api/admin/special-hours/:id', authMiddleware, superadminOnly, async (req, res) => {
  await pool.query('DELETE FROM special_hours WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

// ── DEPOSIT DATES ────────────────────────────────────────────────
app.get('/api/admin/deposit-dates', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM deposit_dates ORDER BY is_recurring DESC,date_value');
  res.json({ depositDates: result.rows });
});
app.post('/api/admin/deposit-dates', authMiddleware, superadminOnly, [
  body('date_value').trim().isLength({ min:4, max:10 }), body('is_recurring').isBoolean(), body('reason').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { date_value, is_recurring, reason } = req.body;
  const result = await pool.query('INSERT INTO deposit_dates (date_value,is_recurring,reason) VALUES ($1,$2,$3) RETURNING *', [date_value,is_recurring,reason||null]);
  res.status(201).json({ depositDate:result.rows[0] });
});
app.delete('/api/admin/deposit-dates/:id', authMiddleware, superadminOnly, async (req, res) => {
  await pool.query('DELETE FROM deposit_dates WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

// ── USER MANAGEMENT (superadmin only) ────────────────────────────
app.get('/api/admin/users', authMiddleware, superadminOnly, async (req, res) => {
  const result = await pool.query('SELECT id,username,role,active,created_at FROM users ORDER BY created_at');
  res.json({ users: result.rows });
});
app.post('/api/admin/users', authMiddleware, superadminOnly, [
  body('username').trim().isLength({ min:3, max:50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').isLength({ min:8 }),
  body('role').isIn(['superadmin','admin','staff']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { username, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING id,username,role,active,created_at', [username,hash,role]);
    res.status(201).json({ user:result.rows[0] });
  } catch { res.status(409).json({ error:'Username already exists' }); }
});
app.patch('/api/admin/users/:id', authMiddleware, superadminOnly, [
  body('active').optional().isBoolean(),
  body('role').optional().isIn(['superadmin','admin','staff']),
  body('password').optional().isLength({ min:8 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { id } = req.params;
  const { active, role, password } = req.body;
  const updates = []; const params = [];
  if (active !== undefined) { params.push(active); updates.push(`active=$${params.length}`); }
  if (role !== undefined) { params.push(role); updates.push(`role=$${params.length}`); }
  if (password) { const hash = await bcrypt.hash(password,10); params.push(hash); updates.push(`password_hash=$${params.length}`); }
  if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
  params.push(id);
  await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${params.length}`, params);
  res.json({ success:true });
});
app.delete('/api/admin/users/:id', authMiddleware, superadminOnly, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error:'Cannot delete yourself' });
  await pool.query('UPDATE users SET active=false WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

// ── TABLE STATS & CSV ────────────────────────────────────────────
app.get('/api/admin/tables', authMiddleware, async (req, res) => {
  const totalTables = parseInt(await getSetting('total_tables')) || 15;
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(`SELECT table_number,COUNT(*) as bookings FROM bookings WHERE date=$1 AND status!='cancelled' AND table_number IS NOT NULL GROUP BY table_number`, [today]);
  res.json({ totalTables, assignedToday:result.rows });
});

app.get('/api/admin/export', authMiddleware, adminOrAbove, async (req, res) => {
  const result = await pool.query('SELECT * FROM bookings ORDER BY date,time');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="antico_frantoio_prenotazioni_${new Date().toISOString().slice(0,10)}.csv"`);
  const headers = ['id','name','email','phone','date','time','adults','children','notes','status','deposit_required','deposit_paid','payment_method','table_number','source','created_by','cancelled_by','amended_by','language','created_at'];
  res.write(headers.join(',') + '\n');
  result.rows.forEach(r => {
    res.write(headers.map(h => `"${String(r[h]??'').replace(/"/g,'""')}"`).join(',') + '\n');
  });
  res.end();
});

// Reminders
app.post('/api/reminders/send', async (req, res) => {
  if (req.headers['x-reminder-secret'] !== process.env.REMINDER_SECRET) return res.status(401).json({ error:'Unauthorized' });
  const count = await processReminders();
  res.json({ success:true, remindersSent:count });
});

// Health
app.get('/health', (req, res) => res.json({ status:'ok', ts:new Date().toISOString() }));

// ── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🍽️  Antico Frantoio API running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});

module.exports = app;
