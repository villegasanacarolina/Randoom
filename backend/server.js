const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// ── LiveKit config ────────────────────────────────────────────────────────────
const LK_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LK_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LK_URL        = process.env.LIVEKIT_URL        || '';
const LK_ENABLED    = !!(LK_API_KEY && LK_API_SECRET && LK_URL);
const lkRoom        = LK_ENABLED ? new RoomServiceClient(LK_URL, LK_API_KEY, LK_API_SECRET) : null;

function lkToken(identity, roomName, isHost) {
  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, { identity, ttl: '4h' });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: !!isHost,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const httpsLib   = require('https');
const { Pool }   = require('pg');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email         TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      age           INT  NOT NULL,
      gender        TEXT NOT NULL,
      country       TEXT DEFAULT 'MX',
      is_premium    BOOLEAN DEFAULT FALSE,
      banned        BOOLEAN DEFAULT FALSE,
      ban_reason    TEXT DEFAULT '',
      approved      BOOLEAN DEFAULT FALSE,
      ine_status    TEXT DEFAULT 'none',
      ine_verified  BOOLEAN DEFAULT FALSE,
      email_verified BOOLEAN DEFAULT FALSE,
      username      TEXT UNIQUE,
      total_sessions INT DEFAULT 0,
      total_minutes  INT DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      last_seen     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ine_requests (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      user_name   TEXT NOT NULL,
      age         INT,
      gender      TEXT,
      country     TEXT,
      frontal     TEXT,
      trasera     TEXT,
      rostro      TEXT,
      status      TEXT DEFAULT 'pending',
      review_note TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS reports (
      id              TEXT PRIMARY KEY,
      reporter_email  TEXT NOT NULL,
      reported_email  TEXT NOT NULL,
      reason          TEXT NOT NULL,
      description     TEXT DEFAULT '',
      status          TEXT DEFAULT 'pending',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS pending_codes (
      email       TEXT PRIMARY KEY,
      code        TEXT NOT NULL,
      expires_at  BIGINT NOT NULL,
      data        JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      email         TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
      display_name  TEXT,
      bio           TEXT DEFAULT '',
      avatar_url    TEXT DEFAULT '',
      zodiac        TEXT DEFAULT '',
      interests     TEXT[] DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id            TEXT PRIMARY KEY,
      from_email    TEXT NOT NULL,
      to_email      TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(from_email, to_email)
    );

    CREATE TABLE IF NOT EXISTS friends (
      id            TEXT PRIMARY KEY,
      email1        TEXT NOT NULL,
      email2        TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(email1, email2)
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id              TEXT PRIMARY KEY,
      report_id       TEXT NOT NULL,
      reporter_email  TEXT NOT NULL,
      recorded_email  TEXT NOT NULL,
      filename        TEXT NOT NULL,
      filesize        BIGINT DEFAULT 0,
      duration_secs   INT DEFAULT 0,
      status          TEXT DEFAULT 'recording',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      ended_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS call_invites (
      id           TEXT PRIMARY KEY,
      from_email   TEXT NOT NULL,
      to_email     TEXT NOT NULL,
      status       TEXT DEFAULT 'pending',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── Migrate existing DB: add columns that may not exist yet ──────────────────
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_sessions INT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_minutes INT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS zodiac TEXT DEFAULT ''`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}'`,
  ];
  for (const m of migrations) {
    await pool.query(m).catch(e => console.log('Migration skip:', e.message));
  }

  console.log('Base de datos inicializada ✅');
}

// ── Upload dirs ────────────────────────────────────────────────────────────────
const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const INE_DIR       = path.join(__dirname, 'uploads', 'ine');
const REC_DIR       = path.join(__dirname, 'uploads', 'recordings');
const AVATAR_DIR    = path.join(__dirname, 'uploads', 'avatars');
[UPLOADS_DIR, INE_DIR, REC_DIR, AVATAR_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const makeStorage = dest => multer.diskStorage({
  destination: (req, file, cb) => cb(null, dest),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const imgFilter = (req, file, cb) =>
  cb(null, /jpeg|jpg|png|gif|webp|pdf/.test(path.extname(file.originalname).toLowerCase()));

const uploadINE = multer({ storage: makeStorage(INE_DIR), limits: { fileSize: 8*1024*1024 }, fileFilter: imgFilter });
const recFilter = (req, file, cb) => cb(null, /webm|mp4|ogg/.test(path.extname(file.originalname).toLowerCase()) || file.mimetype.startsWith('video/'));
const uploadRec    = multer({ storage: makeStorage(REC_DIR),    limits: { fileSize: 200*1024*1024 }, fileFilter: recFilter });
const uploadAvatar = multer({ storage: makeStorage(AVATAR_DIR), limits: { fileSize: 5*1024*1024 },   fileFilter: imgFilter });

// ── Config ─────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Randoom2024!';
const JWT_SECRET     = process.env.JWT_SECRET || 'randoom-super-secret-jwt-key-2024';

// ── MercadoPago ────────────────────────────────────────────────────────────────
function mpRequest(method, mpPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.mercadopago.com', path: mpPath, method,
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': uuidv4(),
        ...(body ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = httpsLib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

// ── Brevo email ────────────────────────────────────────────────────────────────
function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) { reject(new Error('BREVO_API_KEY no configurada')); return; }
    const body = JSON.stringify({
      sender:      { name: 'Randoom', email: 'carovillegass13@gmail.com' },
      to:          [{ email: to }],
      subject,
      htmlContent: html
    });
    const opts = {
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = httpsLib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`Brevo ${res.statusCode}: ${d}`)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function tpl(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
  <body style="margin:0;padding:0;background:#0D0015;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:480px;margin:40px auto;background:#130022;border-radius:20px;overflow:hidden;border:1px solid rgba(160,32,240,0.4);">
      <div style="background:linear-gradient(135deg,#7B00FF,#4B0099);padding:28px;text-align:center;">
        <div style="background:rgba(255,255,255,0.15);display:inline-block;padding:10px 18px;border-radius:12px;margin-bottom:10px;">
          <span style="font-size:24px;font-weight:900;color:#fff;">RD</span>
        </div>
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">Randoom</h1>
      </div>
      <div style="padding:32px 28px;">${content}</div>
      <div style="padding:16px 28px;border-top:1px solid rgba(160,32,240,.15);text-align:center;">
        <p style="color:#6B4A8A;font-size:11px;margin:0;">© 2024 Randoom</p>
      </div>
    </div>
  </body></html>`;
}

const sendVerificationEmail = (email, name, code) => sendEmail(email, '🟣 Tu código de verificación — Randoom', tpl(`
  <p style="color:#C8A8E0;font-size:15px;margin:0 0 6px;">Hola <strong style="color:#fff">${name}</strong> 👋</p>
  <p style="color:#C8A8E0;font-size:13px;margin:0 0 24px;">Usa este código para confirmar tu correo:</p>
  <div style="background:rgba(123,0,255,.15);border:2px solid rgba(123,0,255,.5);border-radius:14px;padding:24px;text-align:center;">
    <div style="font-size:44px;font-weight:900;color:#A020F0;letter-spacing:10px;font-family:monospace;">${code}</div>
    <p style="color:#6B4A8A;font-size:11px;margin:10px 0 0;">⏱ Válido por 15 minutos</p>
  </div>
`));

const sendApprovalEmail = (email, name) => sendEmail(email, '✅ ¡Tu cuenta fue aprobada! — Randoom', tpl(`
  <div style="text-align:center;font-size:52px;margin-bottom:16px;">🎉</div>
  <h2 style="color:#fff;text-align:center;margin:0 0 12px;">¡Bienvenido a Randoom!</h2>
  <p style="color:#C8A8E0;font-size:14px;line-height:1.7;text-align:center;margin:0 0 24px;">
    Hola <strong style="color:#fff">${name}</strong>, tu identidad fue verificada. Ya puedes conectar con el mundo.
  </p>
  <div style="text-align:center;">
    <a href="${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}"
       style="background:linear-gradient(135deg,#9B30FF,#5B00CC);color:#fff;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:700;">
      Entrar a Randoom →
    </a>
  </div>
`));

const sendRejectionEmail = (email, name, note) => sendEmail(email, '❌ Verificación no aprobada — Randoom', tpl(`
  <div style="text-align:center;font-size:52px;margin-bottom:16px;">❌</div>
  <h2 style="color:#fff;text-align:center;margin:0 0 12px;">Verificación no aprobada</h2>
  <p style="color:#C8A8E0;font-size:14px;text-align:center;margin:0 0 16px;">
    Hola <strong style="color:#fff">${name}</strong>, no pudimos verificar tu identidad.
  </p>
  ${note ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:14px;">
    <p style="color:#FCA5A5;font-size:13px;margin:0;"><strong>Motivo:</strong> ${note}</p></div>` : ''}
`));

const sendPremiumEmail = (email, name) => sendEmail(email, '⭐ ¡Premium activado! — Randoom', tpl(`
  <div style="text-align:center;font-size:52px;margin-bottom:16px;">👑</div>
  <h2 style="color:#fff;text-align:center;margin:0 0 12px;">¡Ya eres Premium!</h2>
  <p style="color:#C8A8E0;font-size:14px;text-align:center;margin:0 0 20px;">
    Hola <strong style="color:#fff">${name}</strong>, tu pago fue confirmado. Disfruta sin límites.
  </p>
  <div style="text-align:center;">
    <a href="${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}"
       style="background:linear-gradient(135deg,#9B30FF,#5B00CC);color:#fff;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:700;">
      Ir al chat →
    </a>
  </div>
`));

// ── Active sockets ─────────────────────────────────────────────────────────────
const activeSockets = {};
const waitingPool   = [];

// ── Lives (in-memory) ─────────────────────────────────────────────────────────
// Map: liveId → { id, hostEmail, hostName, title, viewers: Set<socketId>, startedAt }
const activeLives = new Map();

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/recordings', express.static(REC_DIR));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── JWT ────────────────────────────────────────────────────────────────────────
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { const d = jwt.verify(token, JWT_SECRET); if (!d.isAdmin) return res.status(403).json({ error: 'No es admin' }); req.admin = d; next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}
function authUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
function rowToUser(r) {
  if (!r) return null;
  return {
    email: r.email, name: r.name, username: r.username, age: r.age, gender: r.gender,
    country: r.country, isPremium: r.is_premium, banned: r.banned,
    banReason: r.ban_reason, approved: r.approved, ineStatus: r.ine_status,
    ineVerified: r.ine_verified, emailVerified: r.email_verified,
    totalSessions: r.total_sessions, totalMinutes: r.total_minutes,
    createdAt: r.created_at, lastSeen: r.last_seen
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, age, gender, country, zodiac, username } = req.body;
  if (!email||!password||!name||!age||!gender||!username) return res.status(400).json({ error: 'Todos los campos son requeridos' });
  if (parseInt(age) < 18) return res.status(400).json({ error: 'Debes tener al menos 18 años' });
  try {
    const exists = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    const uExists = await pool.query('SELECT email FROM users WHERE username=$1', [username]);
    if (uExists.rows.length) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
    if (exists.rows.length) return res.status(409).json({ error: 'El correo ya está registrado' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO pending_codes(email,code,expires_at,data) VALUES($1,$2,$3,$4)
       ON CONFLICT(email) DO UPDATE SET code=$2, expires_at=$3, data=$4`,
      [email, code, Date.now() + 15*60*1000, JSON.stringify({ email, passwordHash, name, username: username.toLowerCase().trim(), age: parseInt(age), gender, country: country||'MX', zodiac: zodiac||'' })]
    );
    try { await sendVerificationEmail(email, name, code); } catch(e) { console.error('Email error:', e.message); }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); }
});

app.post('/api/auth/verify', async (req, res) => {
  const { email, code } = req.body;
  try {
    const r = await pool.query('SELECT * FROM pending_codes WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(404).json({ error: 'No hay registro pendiente' });
    const pending = r.rows[0];
    if (Date.now() > pending.expires_at) {
      await pool.query('DELETE FROM pending_codes WHERE email=$1', [email]);
      return res.status(410).json({ error: 'Código expirado. Vuelve a registrarte.' });
    }
    if (pending.code !== code.trim()) return res.status(401).json({ error: 'Código incorrecto' });
    const d = pending.data;
    await pool.query(
      `INSERT INTO users(email,password_hash,name,username,age,gender,country,email_verified,approved)
       VALUES($1,$2,$3,$4,$5,$6,$7,true,true)
       ON CONFLICT(email) DO NOTHING`,
      [d.email, d.passwordHash || d.password_hash, d.name, d.username||null, d.age, d.gender, d.country]
    );
    // Create profile with zodiac
    await pool.query(
      `INSERT INTO profiles(email,display_name,zodiac) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING`,
      [d.email, d.name, d.zodiac||'']
    );
    await pool.query('DELETE FROM pending_codes WHERE email=$1', [email]);
    const user = rowToUser((await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0]);
    const token = jwt.sign({ email, name: user.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); }
});

app.post('/api/auth/resend', async (req, res) => {
  const { email } = req.body;
  try {
    const r = await pool.query('SELECT * FROM pending_codes WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(404).json({ error: 'No hay registro pendiente' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query('UPDATE pending_codes SET code=$1, expires_at=$2 WHERE email=$3',
      [code, Date.now() + 15*60*1000, email]);
    await sendVerificationEmail(email, r.rows[0].data.name, code);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error al enviar correo' }); }
});

// ── Dedicated admin login (never hits DB) ────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, isAdmin: true });
  }
  res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  // Admin goes through /api/admin/login, not here
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = r.rows[0];
    if (u.banned) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida' });
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Contraseña incorrecta' });
    await pool.query('UPDATE users SET last_seen=NOW() WHERE email=$1', [email]);
    const user = rowToUser(u);
    const token = jwt.sign({ email, name: user.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user, needsINE: !user.approved });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); }
});

app.get('/api/auth/me', authUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [req.user.email]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const u = rowToUser(r.rows[0]);
    // Include profile data so frontend doesn't need a second request
    const p = await pool.query('SELECT avatar_url,bio,zodiac,display_name,interests FROM profiles WHERE email=$1', [req.user.email]);
    if (p.rows.length) {
      const pr = p.rows[0];
      u.avatar_url   = pr.avatar_url;
      u.bio          = pr.bio;
      u.zodiac       = pr.zodiac;
      u.display_name = pr.display_name;
      u.interests    = pr.interests;
    }
    res.json(u);
  } catch(e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MERCADOPAGO
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/payments/create-preference', authUser, async (req, res) => {
  try {
    const u = (await pool.query('SELECT name,email FROM users WHERE email=$1', [req.user.email])).rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const preference = {
      items: [{ title:'Randoom Premium — 1 mes ($149 MXN)', quantity:1, unit_price: parseFloat(process.env.PREMIUM_PRICE_MXN)||149, currency_id:'MXN' }],
      payer: { email: u.email, name: u.name },
      back_urls: {
        success: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/?payment=success`,
        failure: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/?payment=failed`,
        pending: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/?payment=pending`
      },
      auto_return: 'approved',
      external_reference: u.email,
      notification_url: `${process.env.BACKEND_URL||'https://randoom-production.up.railway.app'}/api/payments/webhook`
    };
    const result = await mpRequest('POST', '/checkout/preferences', preference);
    if (result.status >= 400) return res.status(400).json({ error: 'Error MP', detail: result.data });
    res.json({ init_point: result.data.init_point, sandbox_init_point: result.data.sandbox_init_point });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error con MercadoPago' }); }
});

app.post('/api/payments/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return;
    const result = await mpRequest('GET', `/v1/payments/${data.id}`);
    if (result.data.status === 'approved') {
      const email = result.data.external_reference;
      await pool.query('UPDATE users SET is_premium=true WHERE email=$1', [email]);
      const u = (await pool.query('SELECT name FROM users WHERE email=$1', [email])).rows[0];
      const s = Object.entries(activeSockets).find(([,s]) => s.email === email);
      if (s) io.to(s[0]).emit('premium_activated');
      if (u) sendPremiumEmail(email, u.name).catch(() => {});
    }
  } catch(e) { console.error('Webhook error:', e.message); }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/reports/submit', authUser, async (req, res) => {
  const { reportedEmail, reason, description } = req.body;
  if (!reportedEmail||!reason) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const reportId = uuidv4();
    await pool.query('INSERT INTO reports(id,reporter_email,reported_email,reason,description) VALUES($1,$2,$3,$4,$5)',
      [reportId, req.user.email, reportedEmail, reason, description||'']);

    // Signal the REPORTED user's socket to start recording
    const reportedSocket = Object.entries(activeSockets).find(([,s]) => s.email === reportedEmail);
    const reporterSocket = Object.entries(activeSockets).find(([,s]) => s.email === req.user.email);

    if (reportedSocket) {
      // Tell reported user's browser to start recording and upload
      io.to(reportedSocket[0]).emit('start_recording', { reportId, reason });
    }
    if (reporterSocket) {
      // Also record the reporter's side
      io.to(reporterSocket[0]).emit('start_recording', { reportId, reason, isReporter: true });
    }

    res.json({ ok: true, reportId });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

// Upload recording chunk from browser
app.post('/api/recordings/upload', authUser, uploadRec.single('recording'), async (req, res) => {
  const { reportId, duration } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  try {
    const recId = uuidv4();
    const filename = req.file.filename;
    await pool.query(
      `INSERT INTO recordings(id,report_id,reporter_email,recorded_email,filename,filesize,duration_secs,status,ended_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'completed',NOW())`,
      [recId, reportId, req.user.email, req.user.email, filename, req.file.size, parseInt(duration)||0]
    );
    console.log(`Grabación guardada: \${filename} (\${req.file.size} bytes)`);
    res.json({ ok: true, recordingId: recId });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error guardando grabación' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const [total, approved, premium, banned, pendingReports] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE approved=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_premium=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE banned=true'),
      pool.query("SELECT COUNT(*) FROM reports WHERE status='pending'")
    ]);
    res.json({
      total:          parseInt(total.rows[0].count),
      approved:       parseInt(approved.rows[0].count),
      premium:        parseInt(premium.rows[0].count),
      banned:         parseInt(banned.rows[0].count),
      online:         Object.keys(activeSockets).length,
      pendingReports: parseInt(pendingReports.rows[0].count)
    });
  } catch(e) { console.error('Stats error:',e.message); res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(r.rows.map(u => ({
      ...rowToUser(u),
      isOnline: Object.values(activeSockets).some(s => s.email === u.email)
    })));
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/users/:email/premium', authAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    await pool.query('UPDATE users SET is_premium=$1 WHERE email=$2', [req.body.active, email]);
    const s = Object.entries(activeSockets).find(([,s]) => s.email === email);
    if (s) io.to(s[0]).emit(req.body.active ? 'premium_activated' : 'premium_removed');
    if (req.body.active) {
      const u = (await pool.query('SELECT name FROM users WHERE email=$1', [email])).rows[0];
      if (u) sendPremiumEmail(email, u.name).catch(() => {});
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/users/:email/username', authAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { username } = req.body;
  if (!username || username.length < 3) return res.status(400).json({ error: 'Username muy corto' });
  const clean = username.toLowerCase().trim().replace(/[^a-z0-9_]/g,'');
  try {
    const exists = await pool.query('SELECT email FROM users WHERE username=$1 AND email!=$2', [clean, email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username ya en uso' });
    await pool.query('UPDATE users SET username=$1 WHERE email=$2', [clean, email]);
    res.json({ ok: true, username: clean });
  } catch(e) { console.error('Username update error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:email/ban', authAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    await pool.query('UPDATE users SET banned=$1, ban_reason=$2 WHERE email=$3', [req.body.ban, req.body.reason||'', email]);
    const s = Object.entries(activeSockets).find(([,s]) => s.email === email);
    if (s && req.body.ban) { io.to(s[0]).emit('account_banned', { reason: req.body.reason }); io.sockets.sockets.get(s[0])?.disconnect(true); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/reports', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM reports ORDER BY created_at DESC');
    res.json(r.rows.map(r => ({
      id: r.id, reporterEmail: r.reporter_email, reportedEmail: r.reported_email,
      reason: r.reason, description: r.description, status: r.status,
      createdAt: r.created_at, resolvedAt: r.resolved_at
    })));
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/reports/:id/resolve', authAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE reports SET status='resolved', resolved_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// Admin — get recordings for a report
app.get('/api/admin/recordings', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM recordings ORDER BY created_at DESC');
    res.json(r.rows.map(r => ({
      id: r.id, reportId: r.report_id,
      reporterEmail: r.reporter_email, recordedEmail: r.recorded_email,
      filename: r.filename, filesize: r.filesize,
      durationSecs: r.duration_secs, status: r.status,
      createdAt: r.created_at, endedAt: r.ended_at,
      url: `/recordings/${r.filename}`
    })));
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/recordings/:reportId', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM recordings WHERE report_id=$1 ORDER BY created_at DESC', [req.params.reportId]);
    res.json(r.rows.map(r => ({
      id: r.id, reportId: r.report_id,
      reporterEmail: r.reporter_email, recordedEmail: r.recorded_email,
      filename: r.filename, filesize: r.filesize,
      durationSecs: r.duration_secs, status: r.status,
      createdAt: r.created_at, endedAt: r.ended_at,
      url: `/recordings/${r.filename}`
    })));
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ── PROFILES ─────────────────────────────────────────────────────────────────
app.get('/api/profile/:email', authUser, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const [user, profile, friends] = await Promise.all([
      pool.query('SELECT name,age,gender,country,is_premium FROM users WHERE email=$1', [email]),
      pool.query('SELECT * FROM profiles WHERE email=$1', [email]),
      pool.query('SELECT COUNT(*) FROM friends WHERE email1=$1 OR email2=$1', [email])
    ]);
    if (!user.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json({
      email,
      name: user.rows[0].name,
      age: user.rows[0].age,
      gender: user.rows[0].gender,
      country: user.rows[0].country,
      isPremium: user.rows[0].is_premium,
      ...profile.rows[0],
      friendCount: parseInt(friends.rows[0].count)
    });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/profile/me/full', authUser, async (req, res) => {
  try {
    const email = req.user.email;
    const [user, friends, pendingReqs] = await Promise.all([
      pool.query('SELECT * FROM users WHERE email=$1', [email]),
      pool.query('SELECT COUNT(*) FROM friends WHERE email1=$1 OR email2=$1', [email]),
      pool.query("SELECT * FROM friend_requests WHERE to_email=$1 AND status='pending'", [email])
    ]);
    if (!user.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const u = user.rows[0];
    // Auto-create profile row for users who don't have one yet
    const profile = await pool.query(
      `INSERT INTO profiles(email, display_name, zodiac)
       VALUES($1,$2,$3)
       ON CONFLICT(email) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [email, u.name, '']
    );
    res.json({
      email, name: u.name, username: u.username, age: u.age, gender: u.gender,
      country: u.country, isPremium: u.is_premium,
      ...profile.rows[0],
      friendCount: parseInt(friends.rows[0].count),
      pendingRequests: pendingReqs.rows
    });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/profile', authUser, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    const { bio, interests, zodiac, display_name, username } = req.body;
    // Update username on users table if provided
    if (username) {
      const uname = username.toLowerCase().trim().replace(/[^a-z0-9_]/g,'');
      if (uname.length >= 3) {
        const exists = await pool.query('SELECT email FROM users WHERE username=$1 AND email!=$2', [uname, req.user.email]);
        if (exists.rows.length) return res.status(409).json({ error: 'Ese nombre ya está en uso' });
        await pool.query('UPDATE users SET username=$1 WHERE email=$2', [uname, req.user.email]);
      }
    }
    const interestsArr = interests ? (Array.isArray(interests) ? interests : interests.split(',').map(s=>s.trim())) : [];
    const updates = { bio: bio||'', interests: interestsArr, zodiac: zodiac||'', display_name: display_name||'' };
    if (req.file) updates.avatar_url = `/uploads/avatars/${req.file.filename}`;
    await pool.query(
      `INSERT INTO profiles(email,bio,interests,zodiac,display_name,avatar_url,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(email) DO UPDATE SET
         bio = EXCLUDED.bio,
         interests = EXCLUDED.interests,
         zodiac = EXCLUDED.zodiac,
         display_name = EXCLUDED.display_name,
         avatar_url = CASE WHEN EXCLUDED.avatar_url='' THEN profiles.avatar_url ELSE EXCLUDED.avatar_url END,
         updated_at = NOW()`,
      [req.user.email, updates.bio, updates.interests, updates.zodiac, updates.display_name, updates.avatar_url||'']
    );
    // Return updated profile so frontend can confirm
    const updated = await pool.query('SELECT * FROM profiles WHERE email=$1', [req.user.email]);
    res.json({ ok: true, profile: updated.rows[0] });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

// ── FRIEND REQUESTS ───────────────────────────────────────────────────────────
app.post('/api/friends/request', authUser, async (req, res) => {
  const { toEmail } = req.body;
  if (!toEmail || toEmail === req.user.email) return res.status(400).json({ error: 'Email inválido' });
  try {
    // Check already friends
    const already = await pool.query(
      'SELECT id FROM friends WHERE (email1=$1 AND email2=$2) OR (email1=$2 AND email2=$1)',
      [req.user.email, toEmail]
    );
    if (already.rows.length) return res.status(409).json({ error: 'Ya son amigos' });
    await pool.query(
      `INSERT INTO friend_requests(id,from_email,to_email) VALUES($1,$2,$3)
       ON CONFLICT(from_email,to_email) DO NOTHING`,
      [uuidv4(), req.user.email, toEmail]
    );
    // Notify via socket
    const sock = Object.entries(activeSockets).find(([,s]) => s.email === toEmail);
    if (sock) {
      const fromUser = await pool.query('SELECT name FROM users WHERE email=$1', [req.user.email]);
      io.to(sock[0]).emit('friend_request', { fromEmail: req.user.email, fromName: fromUser.rows[0]?.name });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/friends/requests', authUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fr.*, u.name as from_name FROM friend_requests fr
       JOIN users u ON fr.from_email=u.email
       WHERE fr.to_email=$1 AND fr.status='pending' ORDER BY fr.created_at DESC`,
      [req.user.email]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/friends/respond', authUser, async (req, res) => {
  const { requestId, accept } = req.body;
  try {
    const r = await pool.query('SELECT * FROM friend_requests WHERE id=$1 AND to_email=$2', [requestId, req.user.email]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const req2 = r.rows[0];
    await pool.query("UPDATE friend_requests SET status=$1 WHERE id=$2", [accept ? 'accepted' : 'rejected', requestId]);
    if (accept) {
      await pool.query('INSERT INTO friends(id,email1,email2) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [uuidv4(), req2.from_email, req2.to_email]);
      // Notify requester
      const sock = Object.entries(activeSockets).find(([,s]) => s.email === req2.from_email);
      if (sock) io.to(sock[0]).emit('friend_accepted', { email: req.user.email, name: req.user.name });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/friends/list', authUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.email, u.name, u.age, u.country, p.avatar_url, p.zodiac
       FROM friends f
       JOIN users u ON u.email = CASE WHEN f.email1=$1 THEN f.email2 ELSE f.email1 END
       LEFT JOIN profiles p ON p.email = u.email
       WHERE (f.email1=$1 OR f.email2=$1) AND u.email != $1`,
      [req.user.email]
    );
    res.json(r.rows);
  } catch(e) { console.error('friends/list error:', e.message); res.status(500).json({ error: 'Error' }); }
});

// ── Username search ───────────────────────────────────────────────────────────
app.get('/api/users/search', authUser, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT u.email, u.name, u.username, p.avatar_url, p.zodiac,
              (CASE WHEN f.id IS NOT NULL THEN true ELSE false END) as is_friend
       FROM users u
       LEFT JOIN profiles p ON u.email=p.email
       LEFT JOIN friends f ON (f.email1=$2 AND f.email2=u.email) OR (f.email2=$2 AND f.email1=u.email)
       WHERE (u.username ILIKE $1 OR u.name ILIKE $1) AND u.email != $2 AND u.banned=false
       LIMIT 10`,
      ['%'+q+'%', req.user.email]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/users/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ available: false });
  try {
    const r = await pool.query('SELECT email FROM users WHERE username=$1', [username.toLowerCase().trim()]);
    res.json({ available: r.rows.length === 0 });
  } catch(e) { res.json({ available: false }); }
});

// ── Call invites ──────────────────────────────────────────────────────────────
app.post('/api/calls/invite', authUser, async (req, res) => {
  const { toEmail } = req.body;
  try {
    const id = uuidv4();
    await pool.query('INSERT INTO call_invites(id,from_email,to_email) VALUES($1,$2,$3)', [id, req.user.email, toEmail]);
    // Send via socket if online
    const sock = Object.entries(activeSockets).find(([,s]) => s.email === toEmail);
    if (sock) {
      const me = await pool.query('SELECT name,username FROM users WHERE email=$1', [req.user.email]);
      io.to(sock[0]).emit('call_invite', { from: req.user.email, name: me.rows[0]?.name, inviteId: id });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/calls/respond', authUser, async (req, res) => {
  const { inviteId, accept } = req.body;
  try {
    const r = await pool.query('SELECT * FROM call_invites WHERE id=$1 AND to_email=$2', [inviteId, req.user.email]);
    if (!r.rows.length) return res.status(404).json({ error: 'Invitación no encontrada' });
    await pool.query('UPDATE call_invites SET status=$1 WHERE id=$2', [accept?'accepted':'rejected', inviteId]);
    const inv = r.rows[0];
    const sock = Object.entries(activeSockets).find(([,s]) => s.email === inv.from_email);
    if (sock) {
      if (accept) {
        io.to(sock[0]).emit('call_accepted', { from: req.user.email });
      } else {
        io.to(sock[0]).emit('call_rejected', { from: req.user.email });
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ── Online friends ────────────────────────────────────────────────────────────
app.get('/api/friends/online', authUser, async (req, res) => {
  try {
    // Use UNION to handle both directions of friendship cleanly
    const r = await pool.query(
      `SELECT u.email, u.name, u.username, p.avatar_url, p.zodiac
       FROM friends f
       JOIN users u ON u.email = CASE WHEN f.email1=$1 THEN f.email2 ELSE f.email1 END
       LEFT JOIN profiles p ON p.email = u.email
       WHERE (f.email1=$1 OR f.email2=$1) AND u.email != $1`,
      [req.user.email]
    );
    const onlineEmails = new Set(Object.values(activeSockets).map(s => s.email));
    const friends = r.rows.map(f => ({ ...f, online: onlineEmails.has(f.email) }));
    res.json(friends);
  } catch(e) { console.error('friends/online error:', e.message); res.status(500).json({ error: 'Error' }); }
});

// ── LIVES ────────────────────────────────────────────────────────────────────
app.get('/api/lives', async (req, res) => {
  const lives = Array.from(activeLives.values()).map(l => ({
    id: l.id, hostEmail: l.hostEmail, hostName: l.hostName,
    title: l.title, viewerCount: l.viewers.size,
    startedAt: l.startedAt
  }));
  res.json(lives);
});

// ── LiveKit token ─────────────────────────────────────────────────────────────
app.post('/api/lives/token', authUser, async (req, res) => {
  const { liveId, isHost } = req.body;
  if (!LK_ENABLED) return res.status(503).json({ error: 'LiveKit no configurado' });
  if (!liveId) return res.status(400).json({ error: 'Falta liveId' });
  try {
    const identity = req.user.email;
    const token = await lkToken(identity, liveId, !!isHost);
    res.json({ token, url: LK_URL, liveId });
  } catch(e) { console.error('LiveKit token error:', e); res.status(500).json({ error: 'Error generando token' }); }
});

// Endpoint para que el host cree la sala y obtenga su token
app.post('/api/lives/start', authUser, async (req, res) => {
  const { title } = req.body;
  if (!LK_ENABLED) return res.status(503).json({ error: 'LiveKit no configurado' });
  try {
    const liveId = uuidv4();
    const token = await lkToken(req.user.email, liveId, true);
    // Store in activeLives
    activeLives.set(liveId, {
      id: liveId, hostEmail: req.user.email, hostName: req.user.name||req.user.email,
      title: title || `${req.user.name} en vivo`,
      viewers: new Set(), startedAt: new Date().toISOString(),
      hostSocketId: null // will be set via socket
    });
    res.json({ token, url: LK_URL, liveId });
  } catch(e) { console.error('LiveKit start error:', e); res.status(500).json({ error: 'Error iniciando live' }); }
});

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', online: Object.keys(activeSockets).length }));

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════════════════
function matchesFilters(a, b) {
  const s = activeSockets[a], c = activeSockets[b];
  if (!s||!c) return false;

  // Mood matching: if either user has a mood set, both must have same mood
  const sm = s.mode || null;
  const cm = c.mode || null;
  if (sm || cm) {
    // Both need to have a mood, and it must match
    if (!sm || !cm || sm !== cm) return false;
  }

  const check = (f, t) => {
    if (!f) return true;
    if (f.gender  && f.gender  !== 'any' && t.gender  !== f.gender)  return false;
    if (f.country && f.country !== 'any' && t.country !== f.country) return false;
    if (f.ageMin  && t.age < parseInt(f.ageMin)) return false;
    if (f.ageMax  && t.age > parseInt(f.ageMax)) return false;
    return true;
  };
  return (s.isPremium ? check(s.filters, c) : true) && (c.isPremium ? check(c.filters, s) : true);
}

function findMatch(id) {
  for (let i = 0; i < waitingPool.length; i++) {
    const c = waitingPool[i];
    if (c === id || !activeSockets[c]) continue;
    if (matchesFilters(id, c)) { waitingPool.splice(i, 1); return c; }
  }
  return null;
}

io.on('connection', socket => {
  socket.on('join', async ({ token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const r = await pool.query('SELECT * FROM users WHERE email=$1', [d.email]);
      if (!r.rows.length) { socket.emit('error', { message: 'Usuario no encontrado' }); return; }
      const u = r.rows[0];
      if (u.banned) { socket.emit('error', { message: 'Cuenta suspendida' }); return; }
      activeSockets[socket.id] = {
        socketId: socket.id, email: d.email, name: u.name, age: u.age,
        gender: u.gender, country: u.country, isPremium: u.is_premium,
        filters: {}, mode: null, partnerId: null, sessionStart: null
      };
      await pool.query('UPDATE users SET total_sessions=total_sessions+1, last_seen=NOW() WHERE email=$1', [d.email]);
      socket.emit('joined', { isPremium: u.is_premium, ineVerified: u.ine_verified, ineStatus: u.ine_status, approved: u.approved });
      // Broadcast online status to friends
      const friendsR = await pool.query('SELECT email1,email2 FROM friends WHERE email1=$1 OR email2=$1',[u.email]);
      friendsR.rows.forEach(row => {
        const friendEmail = row.email1 === u.email ? row.email2 : row.email1;
        const fSock = Object.entries(activeSockets).find(([,s]) => s.email === friendEmail);
        if (fSock) io.to(fSock[0]).emit('friend_online', { email: u.email, online: true });
      });
    } catch(e) { socket.emit('error', { message: 'Token inválido' }); }
  });

  socket.on('set_filters', f => { if (activeSockets[socket.id]?.isPremium) activeSockets[socket.id].filters = f; });
  socket.on('set_mode', ({mode}) => { if (activeSockets[socket.id]?.isPremium) activeSockets[socket.id].mode = mode; });

  socket.on('find_partner', () => {
    const u = activeSockets[socket.id]; if (!u) return;
    if (u.partnerId) { io.to(u.partnerId).emit('partner_disconnected'); if (activeSockets[u.partnerId]) activeSockets[u.partnerId].partnerId=null; u.partnerId=null; }
    const idx = waitingPool.indexOf(socket.id); if (idx!==-1) waitingPool.splice(idx,1);
    const mid = findMatch(socket.id);
    if (mid) {
      u.partnerId=mid; activeSockets[mid].partnerId=socket.id;
      u.sessionStart=activeSockets[mid].sessionStart=Date.now();
      const pu=activeSockets[mid];
      socket.emit('partner_found',{partner:{name:pu.name,age:pu.age,gender:pu.gender,country:pu.country,email:pu.email},initiator:true});
      io.to(mid).emit('partner_found',{partner:{name:u.name,age:u.age,gender:u.gender,country:u.country,email:u.email},initiator:false});
    } else { waitingPool.push(socket.id); socket.emit('searching'); }
  });

  socket.on('stop_search', () => { const i=waitingPool.indexOf(socket.id); if(i!==-1) waitingPool.splice(i,1); socket.emit('search_stopped'); });
  socket.on('offer',         d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('offer',d); });
  socket.on('answer',        d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('answer',d); });
  socket.on('ice_candidate', d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('ice_candidate',d); });
  socket.on('chat_message',  d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('chat_message',{text:d.text,from:'partner'}); });

  // ── Game relay — forward to partner ──────────────────────────────────────
  socket.on('game_invite', d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('game_invite', d); });
  socket.on('game_score',  d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('game_score',  d); });
  socket.on('game_end',    d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('game_end',    d); });
  socket.on('game_state',  d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('game_state',  d); });
  socket.on('game_result', d => { const u=activeSockets[socket.id]; if(u?.partnerId) io.to(u.partnerId).emit('game_result', d); });
  socket.on('call_accept', d => {
    const target = Object.entries(activeSockets).find(([,s]) => s.email === d.toEmail);
    if (target) io.to(target[0]).emit('call_accepted_direct', { from: activeSockets[socket.id]?.email });
  });
  // set_mode handled above

  // ── Live socket events ──────────────────────────────────────────────────────
  socket.on('live_start', ({ title, liveId: existingLiveId }) => {
    const u = activeSockets[socket.id]; if (!u) return;
    // End any existing live by this host
    for (const [id, live] of activeLives) {
      if (live.hostEmail === u.email) {
        live.viewers.forEach(vid => io.to(vid).emit('live_ended', { liveId: id }));
        activeLives.delete(id);
      }
    }
    // Use liveId from /api/lives/start if provided, otherwise create new
    const liveId = existingLiveId || uuidv4();
    if (!activeLives.has(liveId)) {
      activeLives.set(liveId, {
        id: liveId, hostEmail: u.email, hostName: u.name,
        title: title || `${u.name} en vivo`,
        viewers: new Set(), startedAt: new Date().toISOString(),
        hostSocketId: socket.id
      });
    } else {
      // Update hostSocketId for existing room (created via REST)
      activeLives.get(liveId).hostSocketId = socket.id;
    }
    socket.join(`live:${liveId}`);
    socket.emit('live_started', { liveId });
    const partnerSock = activeSockets[socket.id]?.partnerId;
    if (partnerSock) io.to(partnerSock).emit('partner_live_started', { liveId, hostName: u.name });
    io.emit('lives_updated');
  });

  socket.on('live_end', () => {
    const u = activeSockets[socket.id]; if (!u) return;
    for (const [id, live] of activeLives) {
      if (live.hostEmail === u.email) {
        live.viewers.forEach(vid => io.to(vid).emit('live_ended', { liveId: id }));
        activeLives.delete(id);
        socket.leave(`live:${id}`);
        io.emit('lives_updated');
        // Notify videocall partner that live ended
        if (u.partnerId) io.to(u.partnerId).emit('partner_live_ended');
      }
    }
  });

  socket.on('live_join', ({ liveId }) => {
    const live = activeLives.get(liveId); if (!live) return;
    live.viewers.add(socket.id);
    socket.join(`live:${liveId}`);
    socket.data = { ...socket.data, watchingLive: liveId };
    socket.emit('live_joined', { liveId, viewerCount: live.viewers.size, hostName: live.hostName, title: live.title });
    // Tell host + viewers about new count
    io.to(`live:${liveId}`).emit('live_viewer_count', { liveId, count: live.viewers.size });
  });

  socket.on('live_leave', ({ liveId }) => {
    const live = activeLives.get(liveId); if (!live) return;
    live.viewers.delete(socket.id);
    socket.leave(`live:${liveId}`);
    io.to(`live:${liveId}`).emit('live_viewer_count', { liveId, count: live.viewers.size });
  });

  socket.on('live_comment', ({ liveId, text }) => {
    if (!text || !text.trim()) return;
    const live = activeLives.get(liveId); if (!live) return;
    const u = activeSockets[socket.id];
    const payload = { from: (u?.name) || 'Viewer', text: text.slice(0, 200), ts: Date.now() };
    io.to(`live:${liveId}`).emit('live_comment', payload);
    // Also relay to videocall partner of host (so both see comments in chat)
    const hostSock = Object.entries(activeSockets).find(([,s]) => s.email === live.hostEmail);
    if (hostSock) {
      const partnerId = activeSockets[hostSock[0]]?.partnerId;
      if (partnerId) io.to(partnerId).emit('live_comment', payload);
    }
  });

  // Live WebRTC: viewer requests offer from host
  socket.on('live_request_offer', ({ liveId }) => {
    const live = activeLives.get(liveId); if (!live) return;
    io.to(live.hostSocketId).emit('live_viewer_requesting', { viewerSocketId: socket.id });
  });
  socket.on('live_offer',     ({ viewerSocketId, offer })     => io.to(viewerSocketId).emit('live_offer', { offer }));
  socket.on('live_answer', ({ answer, liveId: aLiveId }) => {
    // Find the live's host socket and send answer
    for (const [, live] of activeLives) {
      if (live.viewers.has(socket.id) || aLiveId === live.id) {
        if (live.hostSocketId) io.to(live.hostSocketId).emit('live_answer', { answer });
        break;
      }
    }
  });
  socket.on('live_ice',       ({ targetId, candidate })       => io.to(targetId).emit('live_ice', { candidate }));

  socket.on('disconnect', async () => {
    const u = activeSockets[socket.id];
    if (u) {
      // Clean up live if this socket was hosting
      for (const [id, live] of activeLives) {
        if (live.hostSocketId === socket.id) {
          live.viewers.forEach(vid => io.to(vid).emit('live_ended', { liveId: id }));
          activeLives.delete(id);
          io.emit('lives_updated');
        } else {
          live.viewers.delete(socket.id);
          io.to(`live:${id}`).emit('live_viewer_count', { liveId: id, count: live.viewers.size });
        }
      }
      if (u.partnerId) { io.to(u.partnerId).emit('partner_disconnected'); if(activeSockets[u.partnerId]) activeSockets[u.partnerId].partnerId=null; }
      // Notify friends this user went offline
      try {
        const friendsR2 = await pool.query('SELECT email1,email2 FROM friends WHERE email1=$1 OR email2=$1',[u.email]);
        friendsR2.rows.forEach(row => {
          const friendEmail = row.email1 === u.email ? row.email2 : row.email1;
          const fSock2 = Object.entries(activeSockets).find(([,s]) => s.email === friendEmail);
          if (fSock2) io.to(fSock2[0]).emit('friend_online', { email: u.email, online: false });
        });
      } catch(e) {}
      if (u.sessionStart) {
        const mins = Math.floor((Date.now()-u.sessionStart)/60000);
        if (mins > 0) pool.query('UPDATE users SET total_minutes=total_minutes+$1 WHERE email=$2', [mins, u.email]).catch(()=>{});
      }
      const i=waitingPool.indexOf(socket.id); if(i!==-1) waitingPool.splice(i,1);
      delete activeSockets[socket.id];
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Randoom v3 con PostgreSQL corriendo en puerto ${PORT}`));
}).catch(e => {
  console.error('Error iniciando DB:', e.message);
  // Start anyway without DB for development
  server.listen(PORT, () => console.log(`Randoom v3 corriendo en puerto ${PORT} (sin DB)`));
});