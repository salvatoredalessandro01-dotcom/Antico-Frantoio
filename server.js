/**
 * Ristorante Serafino — Reservation API Server
 * Node.js + Express + PostgreSQL
 * 
 * Setup: npm install && npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Stripe = require('stripe');
const { body, param, validationResult } = require('express-validator');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── TRUST RENDER'S PROXY ────────────────────────────────────────
app.set('trust proxy', 1);

// ── MIDDLEWARE ──────────────────────────────────────────────────
// Helmet with CORS-friendly settings
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));

// CORS — allow all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, validate: { xForwardedForHeader: false } });
const reservationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reservation attempts.', validate: { xForwardedForHeader: false } });
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
      stripe_session_id VARCHAR(200),
      language VARCHAR(5) DEFAULT 'it',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS special_closures (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      reason VARCHAR(200),
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
      ('deposit_required_holidays', 'true'),
      ('max_tables_per_slot', '8'),
      ('max_guests_per_slot', '45'),
      ('slot_duration_minutes', '60'),
      ('buffer_minutes', '0')
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log('✅ Database initialized');
}

// ── HELPERS ─────────────────────────────────────────────────────
const OPENING_HOURS = {
  0: [['12:30','15:00']],       // Sunday (lunch only)
  1: null,                       // Monday (closed)
  2: [['12:30','14:30'],['19:30','22:30']],
  3: [['12:30','14:30'],['19:30','22:30']],
  4: [['12:30','14:30'],['19:30','22:30']],
  5: [['12:30','14:30'],['19:30','22:30']],
  6: [['12:30','14:30'],['19:30','22:30']],
};

function generateSlots(date, slotDuration = 60) {
  const dt = new Date(date + 'T00:00:00');
  const dayOfWeek = dt.getDay();
  const hours = OPENING_HOURS[dayOfWeek];
  if (!hours) return [];

  const slots = [];
  hours.forEach(([open, close]) => {
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    let cur = oh * 60 + om;
    const end = ch * 60 + cm;
    while (cur + slotDuration <= end) {
      const hh = String(Math.floor(cur / 60)).padStart(2, '0');
      const mm = String(cur % 60).padStart(2, '0');
      slots.push(`${hh}:${mm}`);
      cur += 30; // 30-min increments
    }
  });
  return slots;
}

function isWeekend(date) {
  const d = new Date(date + 'T00:00:00').getDay();
  return d === 0 || d === 6;
}

async function getSetting(key) {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows[0]?.value;
}

async function requiresDeposit(date) {
  const weekendRequired = await getSetting('deposit_required_weekends') === 'true';
  if (weekendRequired && isWeekend(date)) return true;
  return false;
}

async function getSlotAvailability(date, time) {
  const maxTables = parseInt(await getSetting('max_tables_per_slot')) || 8;
  const maxGuests = parseInt(await getSetting('max_guests_per_slot')) || 45;

  const result = await pool.query(`
    SELECT COUNT(*) as tables, SUM(adults + children) as guests
    FROM bookings
    WHERE date = $1 AND time = $2 AND status != 'cancelled'
  `, [date, time]);

  const tablesUsed = parseInt(result.rows[0].tables) || 0;
  const guestsIn = parseInt(result.rows[0].guests) || 0;

  return {
    tablesUsed,
    tablesAvail: maxTables - tablesUsed,
    guestsIn,
    guestsAvail: maxGuests - guestsIn,
    available: tablesUsed < maxTables && guestsIn < maxGuests,
  };
}

// ── EMAIL SERVICE (Brevo HTTP API) ─────────────────────────────
async function sendConfirmationEmail(booking, lang = 'it') {
  const isIT = lang === 'it';
  const subject = isIT
    ? `Prenotazione confermata — ${booking.date} ${booking.time}`
    : `Reservation confirmed — ${booking.date} ${booking.time}`;

  const html = `
    <div style="font-family:'Georgia',serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1A1612">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="font-size:2rem;font-weight:300;color:#C9A84C;margin:0">Antico Frantoio</h1>
        <p style="color:#6B6460;font-size:.85rem;letter-spacing:.1em;text-transform:uppercase">
          ${isIT ? 'Via Casarlano 5, 80067 Sorrento (NA), Italia' : 'Via Casarlano 5, 80067 Sorrento (NA), Italy'}
        </p>
      </div>
      <hr style="border:none;border-top:1px solid #D4CEC8;margin-bottom:32px">
      <h2 style="font-weight:300;font-size:1.5rem">
        ${isIT ? 'La tua prenotazione è confermata' : 'Your reservation is confirmed'}
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:20px 0">
        ${[
          [isIT?'Nome':'Name', booking.name],
          [isIT?'Data':'Date', booking.date],
          [isIT?'Orario':'Time', booking.time],
          [isIT?'Ospiti':'Guests', `${booking.adults} ${isIT?'adulti':'adults'}, ${booking.children} ${isIT?'bambini':'children'}`],
          ...(booking.notes ? [[isIT?'Note':'Notes', booking.notes]] : []),
          ...(booking.deposit_required ? [[isIT?'Caparra':'Deposit', booking.deposit_paid ? (isIT?'Pagata ✓':'Paid ✓') : (isIT?'Non pagata':'Unpaid')]] : []),
        ].map(([k,v]) => `
          <tr>
            <td style="padding:8px 0;color:#6B6460;font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;width:120px">${k}</td>
            <td style="padding:8px 0;font-size:.9rem"><strong>${v}</strong></td>
          </tr>
        `).join('')}
      </table>
      <hr style="border:none;border-top:1px solid #D4CEC8;margin:24px 0">
      <p style="color:#6B6460;font-size:.85rem;line-height:1.6">
        ${isIT
          ? 'Per modifiche o cancellazioni, contattaci almeno 24 ore prima al <a href="tel:+390818072200" style="color:#C9A84C">+39 081 807 22 00</a> oppure rispondi a questa email.'
          : 'For changes or cancellations, please contact us at least 24 hours before at <a href="tel:+390818072200" style="color:#C9A84C">+39 081 807 22 00</a> or reply to this email.'
        }
      </p>
      <div style="text-align:center;margin-top:32px">
        <p style="color:#C9A84C;font-size:1.1rem;font-style:italic">
          ${isIT ? 'Non vediamo l\'ora di accogliervi.' : 'We look forward to welcoming you.'}
        </p>
      </div>
    </div>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: 'Antico Frantoio',
          email: process.env.BREVO_FROM || 'salvatore.dalessandro01@gmail.com',
        },
        to: [{ email: booking.email, name: booking.name }],
        subject,
        htmlContent: html,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Brevo API error:', JSON.stringify(data));
    } else {
      console.log('Email sent successfully to:', booking.email);
    }
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}

// ── ROUTES ──────────────────────────────────────────────────────

/**
 * GET /api/availability?date=YYYY-MM-DD&adults=2
 * Returns available time slots with capacity info
 */
app.get('/api/availability', async (req, res) => {
  try {
    const { date, adults = 2 } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Check closures
    const closure = await pool.query('SELECT reason FROM special_closures WHERE date = $1', [date]);
    if (closure.rows.length > 0) {
      return res.json({ available: false, reason: 'closed', closureReason: closure.rows[0].reason });
    }

    const slotDuration = parseInt(await getSetting('slot_duration_minutes')) || 60;
    const slots = generateSlots(date, slotDuration);

    if (!slots.length) {
      return res.json({ available: false, reason: 'closed' });
    }

    const slotsWithAvail = await Promise.all(slots.map(async (time) => {
      const avail = await getSlotAvailability(date, time);
      return {
        time,
        available: avail.available && avail.tablesAvail >= 1,
        tablesLeft: avail.tablesAvail,
        totalGuests: avail.guestsIn,
      };
    }));

    const depositRequired = await requiresDeposit(date);
    const depositAmt = parseInt(await getSetting('deposit_amount')) || 25;

    res.json({
      available: slotsWithAvail.some(s => s.available),
      date,
      slots: slotsWithAvail,
      depositRequired,
      depositAmount: depositRequired ? depositAmt * parseInt(adults) : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/reservations
 * Create a new reservation
 */
app.post('/api/reservations', reservationLimiter, [
  body('name').trim().isLength({ min: 2, max: 100 }).escape(),
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().isLength({ min: 6, max: 30 }),
  body('date').isDate(),
  body('time').matches(/^\d{2}:\d{2}$/),
  body('adults').isInt({ min: 1, max: 20 }),
  body('children').isInt({ min: 0, max: 10 }),
  body('notes').optional().trim().isLength({ max: 500 }).escape(),
  body('payDeposit').optional().isBoolean(),
  body('language').optional().isIn(['it','en']),
  body('gdprConsent').equals('true'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { name, email, phone, date, time, adults, children, notes, payDeposit, language = 'it' } = req.body;

  try {
    // Check closure
    const closure = await pool.query('SELECT 1 FROM special_closures WHERE date = $1', [date]);
    if (closure.rows.length) return res.status(409).json({ error: 'Restaurant closed on this date' });

    // Validate slot exists
    const validSlots = generateSlots(date);
    if (!validSlots.includes(time)) return res.status(400).json({ error: 'Invalid time slot' });

    // Check availability
    const avail = await getSlotAvailability(date, time);
    if (!avail.available) return res.status(409).json({ error: 'No availability for this slot', code: 'SLOT_FULL' });

    const depositRequired = await requiresDeposit(date);
    const depositAmt = parseInt(await getSetting('deposit_amount')) || 25;
    const depositTotal = depositRequired ? depositAmt * parseInt(adults) : 0;

    // Create booking (pending until deposit paid if required)
    const status = (depositRequired && payDeposit) ? 'pending' : 'confirmed';

    const result = await pool.query(`
      INSERT INTO bookings (name, email, phone, date, time, adults, children, notes, status, deposit_required, language)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [name, email, phone, date, time, adults, children, notes, status, depositRequired, language]);

    const booking = result.rows[0];

    // If deposit payment requested → create Stripe session
    if (depositRequired && payDeposit) {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: depositTotal * 100,
            product_data: {
              name: `Caparra — Ristorante Serafino`,
              description: `${date} ${time} · ${adults} persone`,
            },
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}/success?booking=${booking.id}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}?cancelled=1`,
        customer_email: email,
        metadata: { bookingId: booking.id },
      });

      await pool.query('UPDATE bookings SET stripe_session_id = $1 WHERE id = $2', [session.id, booking.id]);

      return res.status(201).json({
        booking: { id: booking.id, status: 'pending' },
        stripeUrl: session.url,
        requiresPayment: true,
      });
    }

    // No deposit needed — confirm immediately
    await sendConfirmationEmail(booking, language);
    res.status(201).json({ booking: { id: booking.id, status: 'confirmed' }, requiresPayment: false });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/webhooks/stripe
 * Handle Stripe payment completion
 */
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata.bookingId;

    await pool.query(`
      UPDATE bookings SET status='confirmed', deposit_paid=true, updated_at=NOW()
      WHERE id=$1
    `, [bookingId]);

    const bRes = await pool.query('SELECT * FROM bookings WHERE id=$1', [bookingId]);
    if (bRes.rows.length) await sendConfirmationEmail(bRes.rows[0], bRes.rows[0].language);
  }

  res.json({ received: true });
});

// ── ADMIN ROUTES (JWT protected) ───────────────────────────────
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Admin users (in production: store in DB)
const ADMIN_USERS = {
  admin: process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('serafino2025', 10),
};

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const hash = ADMIN_USERS[username];
  if (!hash || !await bcrypt.compare(password, hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

app.get('/api/admin/bookings', authMiddleware, async (req, res) => {
  const { date, status, search, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (date) { params.push(date); query += ` AND date=$${params.length}`; }
  if (status) { params.push(status); query += ` AND status=$${params.length}`; }
  if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
  query += ` ORDER BY date DESC, time ASC LIMIT ${limit} OFFSET ${(page-1)*limit}`;
  const result = await pool.query(query, params);
  res.json({ bookings: result.rows });
});

app.patch('/api/admin/bookings/:id', authMiddleware, [
  param('id').isUUID(),
  body('status').optional().isIn(['confirmed','pending','cancelled']),
  body('notes').optional().trim().isLength({ max: 500 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  const { id } = req.params;
  const { status, notes } = req.body;
  const updates = []; const params = [];
  if (status) { params.push(status); updates.push(`status=$${params.length}`); }
  if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(id);
  await pool.query(`UPDATE bookings SET ${updates.join(',')},updated_at=NOW() WHERE id=$${params.length}`, params);
  res.json({ success: true });
});

app.delete('/api/admin/bookings/:id', authMiddleware, async (req, res) => {
  await pool.query(`UPDATE bookings SET status='cancelled',updated_at=NOW() WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/settings', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT key, value FROM settings');
  const settings = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
  res.json(settings);
});

app.patch('/api/admin/settings', authMiddleware, async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(`
      INSERT INTO settings (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
    `, [key, String(value)]);
  }
  res.json({ success: true });
});

app.get('/api/admin/closures', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM special_closures ORDER BY date');
  res.json({ closures: result.rows });
});

app.post('/api/admin/closures', authMiddleware, [
  body('date').isDate(),
  body('reason').optional().trim().isLength({ max: 200 }),
], async (req, res) => {
  const { date, reason } = req.body;
  try {
    await pool.query('INSERT INTO special_closures (date, reason) VALUES ($1, $2)', [date, reason]);
    res.status(201).json({ success: true });
  } catch { res.status(409).json({ error: 'Date already blocked' }); }
});

app.delete('/api/admin/closures/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM special_closures WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/export', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM bookings ORDER BY date, time');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="serafino_bookings_${new Date().toISOString().slice(0,10)}.csv"`);
  const headers = ['id','name','email','phone','date','time','adults','children','notes','status','deposit_required','deposit_paid','created_at'];
  res.write(headers.join(',') + '\n');
  result.rows.forEach(r => {
    res.write(headers.map(h => `"${String(r[h] || '').replace(/"/g,'""')}"`).join(',') + '\n');
  });
  res.end();
});

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── START ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🍽️  Serafino API running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});

module.exports = app;
