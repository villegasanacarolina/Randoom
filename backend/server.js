const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
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
  `);
  console.log('Base de datos inicializada ✅');
}

// ── Upload dirs ────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INE_DIR     = path.join(__dirname, 'uploads', 'ine');
[UPLOADS_DIR, INE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const makeStorage = dest => multer.diskStorage({
  destination: (req, file, cb) => cb(null, dest),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const imgFilter = (req, file, cb) =>
  cb(null, /jpeg|jpg|png|gif|webp|pdf/.test(path.extname(file.originalname).toLowerCase()));

const uploadINE = multer({ storage: makeStorage(INE_DIR), limits: { fileSize: 8*1024*1024 }, fileFilter: imgFilter });

// ── Config ─────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = 'Randoom2024!';
const JWT_SECRET     = 'randoom-super-secret-jwt-key-2024';

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

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOADS_DIR));
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
    email: r.email, name: r.name, age: r.age, gender: r.gender,
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
  const { email, password, name, age, gender, country } = req.body;
  if (!email||!password||!name||!age||!gender) return res.status(400).json({ error: 'Todos los campos son requeridos' });
  if (parseInt(age) < 18) return res.status(400).json({ error: 'Debes tener al menos 18 años' });
  try {
    const exists = await pool.query('SELECT email FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'El correo ya está registrado' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO pending_codes(email,code,expires_at,data) VALUES($1,$2,$3,$4)
       ON CONFLICT(email) DO UPDATE SET code=$2, expires_at=$3, data=$4`,
      [email, code, Date.now() + 15*60*1000, JSON.stringify({ email, passwordHash, name, age: parseInt(age), gender, country: country||'MX' })]
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
      `INSERT INTO users(email,password_hash,name,age,gender,country,email_verified)
       VALUES($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT(email) DO NOTHING`,
      [d.email, d.passwordHash || d.password_hash, d.name, d.age, d.gender, d.country]
    );
    await pool.query('DELETE FROM pending_codes WHERE email=$1', [email]);
    const user = rowToUser((await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0]);
    const token = jwt.sign({ email, name: user.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user, needsINE: true });
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

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD)
    return res.json({ token: jwt.sign({ email, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' }), isAdmin: true });
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
    res.json(rowToUser(r.rows[0]));
  } catch(e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// INE
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/ine/submit', authUser,
  uploadINE.fields([{ name:'frontal',maxCount:1 },{ name:'trasera',maxCount:1 },{ name:'rostro',maxCount:1 }]),
  async (req, res) => {
    if (!req.files?.frontal||!req.files?.trasera||!req.files?.rostro)
      return res.status(400).json({ error: 'Debes subir frente, reverso y foto de rostro' });
    try {
      const u = (await pool.query('SELECT * FROM users WHERE email=$1', [req.user.email])).rows[0];
      if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (u.ine_status === 'approved') return res.status(400).json({ error: 'Ya verificado' });
      const id = uuidv4();
      await pool.query('DELETE FROM ine_requests WHERE email=$1 AND status=$2', [req.user.email, 'pending']);
      await pool.query(
        `INSERT INTO ine_requests(id,email,user_name,age,gender,country,frontal,trasera,rostro)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, req.user.email, u.name, u.age, u.gender, u.country,
         `/uploads/ine/${req.files.frontal[0].filename}`,
         `/uploads/ine/${req.files.trasera[0].filename}`,
         `/uploads/ine/${req.files.rostro[0].filename}`]
      );
      await pool.query('UPDATE users SET ine_status=$1 WHERE email=$2', ['pending', req.user.email]);
      res.json({ ok: true, requestId: id });
    } catch(e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); }
  }
);

app.get('/api/ine/status', authUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT ine_status,ine_verified,approved FROM users WHERE email=$1', [req.user.email]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ineStatus: r.rows[0].ine_status, ineVerified: r.rows[0].ine_verified, approved: r.rows[0].approved });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MERCADOPAGO
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/payments/create-preference', authUser, async (req, res) => {
  try {
    const u = (await pool.query('SELECT name,email FROM users WHERE email=$1', [req.user.email])).rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const preference = {
      items: [{ title:'Randoom Premium — 1 mes', quantity:1, unit_price: parseFloat(process.env.PREMIUM_PRICE_MXN)||399, currency_id:'MXN' }],
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
    await pool.query('INSERT INTO reports(id,reporter_email,reported_email,reason,description) VALUES($1,$2,$3,$4,$5)',
      [uuidv4(), req.user.email, reportedEmail, reason, description||'']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const [total, approved, premium, banned, pendingINE, pendingReports] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE approved=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_premium=true'),
      pool.query('SELECT COUNT(*) FROM users WHERE banned=true'),
      pool.query("SELECT COUNT(*) FROM ine_requests WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM reports WHERE status='pending'")
    ]);
    res.json({
      total:          parseInt(total.rows[0].count),
      approved:       parseInt(approved.rows[0].count),
      premium:        parseInt(premium.rows[0].count),
      banned:         parseInt(banned.rows[0].count),
      online:         Object.keys(activeSockets).length,
      pendingINE:     parseInt(pendingINE.rows[0].count),
      pendingReports: parseInt(pendingReports.rows[0].count)
    });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
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

app.post('/api/admin/users/:email/ban', authAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    await pool.query('UPDATE users SET banned=$1, ban_reason=$2 WHERE email=$3', [req.body.ban, req.body.reason||'', email]);
    const s = Object.entries(activeSockets).find(([,s]) => s.email === email);
    if (s && req.body.ban) { io.to(s[0]).emit('account_banned', { reason: req.body.reason }); io.sockets.sockets.get(s[0])?.disconnect(true); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/ine', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ine_requests ORDER BY created_at DESC');
    res.json(r.rows.map(r => ({
      id: r.id, email: r.email, userName: r.user_name, age: r.age,
      gender: r.gender, country: r.country, frontal: r.frontal,
      trasera: r.trasera, rostro: r.rostro, status: r.status,
      reviewNote: r.review_note, createdAt: r.created_at, reviewedAt: r.reviewed_at
    })));
  } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/ine/:id/review', authAdmin, async (req, res) => {
  const { status, note } = req.body;
  try {
    const r = await pool.query('SELECT * FROM ine_requests WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const request = r.rows[0];
    await pool.query('UPDATE ine_requests SET status=$1, review_note=$2, reviewed_at=NOW() WHERE id=$3', [status, note||'', req.params.id]);
    await pool.query('UPDATE users SET ine_status=$1, ine_verified=$2, approved=$3 WHERE email=$4',
      [status, status==='approved', status==='approved', request.email]);
    const s = Object.entries(activeSockets).find(([,s]) => s.email === request.email);
    if (s) io.to(s[0]).emit('ine_reviewed', { status, note });
    if (status === 'approved') sendApprovalEmail(request.email, request.user_name).catch(() => {});
    else sendRejectionEmail(request.email, request.user_name, note).catch(() => {});
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Error' }); }
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

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', online: Object.keys(activeSockets).length }));

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════════════════
function matchesFilters(a, b) {
  const s = activeSockets[a], c = activeSockets[b];
  if (!s||!c) return false;
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
        filters: {}, partnerId: null, sessionStart: null
      };
      await pool.query('UPDATE users SET total_sessions=total_sessions+1, last_seen=NOW() WHERE email=$1', [d.email]);
      socket.emit('joined', { isPremium: u.is_premium, ineVerified: u.ine_verified, ineStatus: u.ine_status, approved: u.approved });
    } catch(e) { socket.emit('error', { message: 'Token inválido' }); }
  });

  socket.on('set_filters', f => { if (activeSockets[socket.id]?.isPremium) activeSockets[socket.id].filters = f; });

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

  socket.on('disconnect', async () => {
    const u = activeSockets[socket.id];
    if (u) {
      if (u.partnerId) { io.to(u.partnerId).emit('partner_disconnected'); if(activeSockets[u.partnerId]) activeSockets[u.partnerId].partnerId=null; }
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