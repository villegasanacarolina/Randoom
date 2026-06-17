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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Upload dirs ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INE_DIR     = path.join(__dirname, 'uploads', 'ine');
[UPLOADS_DIR, INE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Multer ────────────────────────────────────────────────────────────────────
const makeStorage = dest => multer.diskStorage({
  destination: (req, file, cb) => cb(null, dest),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const imgFilter = (req, file, cb) =>
  cb(null, /jpeg|jpg|png|gif|webp|pdf/.test(path.extname(file.originalname).toLowerCase()));

const uploadINE = multer({ storage: makeStorage(INE_DIR), limits: { fileSize: 8*1024*1024 }, fileFilter: imgFilter });

// ── In-memory DB ──────────────────────────────────────────────────────────────
const usersDB       = {};  // email → user
const pendingCodes  = {};  // email → { code, data, expiresAt }
const ineRequestsDB = [];  // identity verification requests
const reportsDB     = [];

// ── Config ────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = 'Randoom2024!';
const JWT_SECRET     = 'randoom-super-secret-jwt-key-2024';

// ── MercadoPago helper ────────────────────────────────────────────────────────
function mpRequest(method, mpPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.mercadopago.com',
      path: mpPath,
      method,
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

// ── Brevo email (HTTPS API — nunca bloqueado por Railway) ────────────────────
function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) { reject(new Error('BREVO_API_KEY no configurada')); return; }

    const body = JSON.stringify({
      sender:    { name: 'Randoom', email: 'carovillegass13@gmail.com' },
      to:        [{ email: to }],
      subject,
      htmlContent: html
    });

    const opts = {
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'api-key':        apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = httpsLib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 300) resolve();
        else reject(new Error(`Brevo ${res.statusCode}: ${d}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
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
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">Rand<span style="opacity:.85">oom</span></h1>
      </div>
      <div style="padding:32px 28px;">${content}</div>
      <div style="padding:16px 28px;border-top:1px solid rgba(160,32,240,0.2);text-align:center;">
        <p style="color:#6B4A8A;font-size:11px;margin:0;">© 2024 Randoom — Conecta con el mundo 🌎</p>
      </div>
    </div>
  </body></html>`;
}

async function sendVerificationEmail(email, name, code) {
  await sendEmail(email, '🟣 Tu código de verificación — Randoom', tpl(`
    <p style="color:#C8A8E0;font-size:15px;margin:0 0 6px;">Hola, <strong style="color:#fff">${name}</strong> 👋</p>
    <p style="color:#C8A8E0;font-size:13px;margin:0 0 24px;">Usa este código para confirmar tu correo:</p>
    <div style="background:rgba(123,0,255,0.15);border:2px solid rgba(123,0,255,0.5);border-radius:14px;padding:24px;text-align:center;margin-bottom:20px;">
      <p style="color:#C8A8E0;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 10px;">Código de verificación</p>
      <div style="font-size:44px;font-weight:900;color:#A020F0;letter-spacing:10px;font-family:monospace;">${code}</div>
      <p style="color:#6B4A8A;font-size:11px;margin:10px 0 0;">⏱ Válido por 15 minutos</p>
    </div>
  `));
}

async function sendApprovalEmail(email, name) {
  await sendEmail(email, '✅ ¡Tu cuenta fue aprobada! — Randoom', tpl(`
    <div style="text-align:center;margin-bottom:20px;"><span style="font-size:52px;">🎉</span></div>
    <h2 style="font-family:'Poppins',sans-serif;font-weight:800;font-size:22px;color:#fff;text-align:center;margin:0 0 12px;">¡Bienvenido a Randoom!</h2>
    <p style="color:#C8A8E0;font-size:14px;line-height:1.7;text-align:center;margin:0 0 24px;">
      Hola <strong style="color:#fff">${name}</strong>, tu identidad fue verificada exitosamente. Ya puedes entrar a Randoom y conectar con el mundo.
    </p>
    <div style="text-align:center;">
      <a href="${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}" 
         style="background:linear-gradient(135deg,#9B30FF,#5B00CC);color:#fff;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
        Entrar a Randoom →
      </a>
    </div>
  `));
}

async function sendRejectionEmail(email, name, note) {
  await sendEmail(email, '❌ Verificación no aprobada — Randoom', tpl(`
    <div style="text-align:center;margin-bottom:20px;"><span style="font-size:52px;">❌</span></div>
    <h2 style="font-family:'Poppins',sans-serif;font-weight:800;font-size:20px;color:#fff;text-align:center;margin:0 0 12px;">Verificación no aprobada</h2>
    <p style="color:#C8A8E0;font-size:14px;line-height:1.7;text-align:center;margin:0 0 16px;">
      Hola <strong style="color:#fff">${name}</strong>, no pudimos verificar tu identidad.
    </p>
    ${note ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:14px;margin-bottom:16px;"><p style="color:#FCA5A5;font-size:13px;margin:0;"><strong>Motivo:</strong> ${note}</p></div>` : ''}
    <p style="color:#6B4A8A;font-size:12px;text-align:center;margin:0;">Puedes volver a intentarlo con fotos más claras desde la app.</p>
  `));
}

async function sendPremiumEmail(email, name) {
  await sendEmail(email, '⭐ ¡Premium activado! — Randoom', tpl(`
    <div style="text-align:center;margin-bottom:20px;"><span style="font-size:52px;">👑</span></div>
    <h2 style="font-family:'Poppins',sans-serif;font-weight:800;font-size:22px;color:#fff;text-align:center;margin:0 0 12px;">¡Ya eres Premium!</h2>
    <p style="color:#C8A8E0;font-size:14px;line-height:1.7;text-align:center;margin:0 0 20px;">
      Hola <strong style="color:#fff">${name}</strong>, tu pago fue confirmado. Ahora tienes acceso a filtros avanzados y videollamadas sin límite de tiempo.
    </p>
    <div style="text-align:center;">
      <a href="${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}"
         style="background:linear-gradient(135deg,#9B30FF,#5B00CC);color:#fff;padding:14px 32px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
        Ir al chat →
      </a>
    </div>
  `));
}

// ── Active sockets ─────────────────────────────────────────────────────────────
const activeSockets = {};
const waitingPool   = [];

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── JWT middleware ─────────────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// AUTH — Register sends code, account needs INE approval to be fully active
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, age, gender, country } = req.body;
  if (!email||!password||!name||!age||!gender) return res.status(400).json({ error: 'Todos los campos son requeridos' });
  if (usersDB[email]) return res.status(409).json({ error: 'El correo ya está registrado' });
  if (parseInt(age) < 18) return res.status(400).json({ error: 'Debes tener al menos 18 años' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const passwordHash = await bcrypt.hash(password, 10);
  pendingCodes[email] = { code, expiresAt: Date.now() + 15*60*1000,
    data: { email, passwordHash, name, age: parseInt(age), gender, country: country||'MX' } };
  try { await sendVerificationEmail(email, name, code); res.json({ ok: true }); }
  catch(e) { console.error('Email error:', e.message); res.json({ ok: true }); }
});

app.post('/api/auth/verify', async (req, res) => {
  const { email, code } = req.body;
  const pending = pendingCodes[email];
  if (!pending) return res.status(404).json({ error: 'No hay registro pendiente' });
  if (Date.now() > pending.expiresAt) { delete pendingCodes[email]; return res.status(410).json({ error: 'Código expirado. Vuelve a registrarte.' }); }
  if (pending.code !== code.trim()) return res.status(401).json({ error: 'Código incorrecto' });
  // Create user but NOT approved yet — needs INE verification
  usersDB[email] = { ...pending.data,
    isPremium: false, banned: false, approved: false,
    ineStatus: 'none', ineVerified: false,
    emailVerified: true,
    createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
    totalSessions: 0, totalMinutes: 0
  };
  delete pendingCodes[email];
  // Return token but user must complete INE to access chat
  const token = jwt.sign({ email, name: usersDB[email].name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(usersDB[email]), needsINE: true });
});

app.post('/api/auth/resend', async (req, res) => {
  const { email } = req.body;
  const pending = pendingCodes[email];
  if (!pending) return res.status(404).json({ error: 'No hay registro pendiente' });
  pending.code = Math.floor(100000 + Math.random() * 900000).toString();
  pending.expiresAt = Date.now() + 15*60*1000;
  try { await sendVerificationEmail(email, pending.data.name, pending.code); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: 'Error al enviar correo' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD)
    return res.json({ token: jwt.sign({ email, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' }), isAdmin: true });
  const user = usersDB[email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.banned) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida' });
  if (!await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  user.lastSeen = new Date().toISOString();
  const token = jwt.sign({ email, name: user.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user), needsINE: !user.approved });
});

app.get('/api/auth/me', authUser, (req, res) => {
  const user = usersDB[req.user.email];
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  res.json(sanitizeUser(user));
});

// ══════════════════════════════════════════════════════════════════════════════
// INE + FACE VERIFICATION
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/ine/submit', authUser,
  uploadINE.fields([{ name: 'frontal', maxCount:1 }, { name: 'trasera', maxCount:1 }, { name: 'rostro', maxCount:1 }]),
  (req, res) => {
    const user = usersDB[req.user.email];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.ineStatus === 'approved') return res.status(400).json({ error: 'Tu identidad ya fue verificada' });
    if (!req.files?.frontal || !req.files?.trasera || !req.files?.rostro)
      return res.status(400).json({ error: 'Debes subir frente de INE, reverso de INE y foto de tu rostro' });

    // Remove previous pending request
    const idx = ineRequestsDB.findIndex(r => r.email === req.user.email);
    if (idx !== -1) ineRequestsDB.splice(idx, 1);

    const request = {
      id: uuidv4(),
      email: req.user.email,
      userName: user.name,
      age: user.age,
      gender: user.gender,
      country: user.country,
      frontal: `/uploads/ine/${req.files.frontal[0].filename}`,
      trasera: `/uploads/ine/${req.files.trasera[0].filename}`,
      rostro:  `/uploads/ine/${req.files.rostro[0].filename}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      reviewNote: ''
    };
    ineRequestsDB.push(request);
    user.ineStatus = 'pending';
    res.json({ ok: true, requestId: request.id });
  }
);

app.get('/api/ine/status', authUser, (req, res) => {
  const user = usersDB[req.user.email];
  res.json({ ineStatus: user?.ineStatus||'none', ineVerified: user?.ineVerified||false, approved: user?.approved||false });
});

// ══════════════════════════════════════════════════════════════════════════════
// MERCADOPAGO — Create preference
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/payments/create-preference', authUser, async (req, res) => {
  const user = usersDB[req.user.email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    const preference = {
      items: [{
        title: 'Randoom Premium — 1 mes',
        description: 'Videollamadas ilimitadas + filtros avanzados',
        quantity: 1,
        unit_price: parseFloat(process.env.PREMIUM_PRICE_MXN) || 399,
        currency_id: 'MXN'
      }],
      payer: { email: user.email, name: user.name },
      back_urls: {
        success: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/payment-success.html`,
        failure: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/?payment=failed`,
        pending: `${process.env.FRONTEND_URL||'https://randoom-zeta.vercel.app'}/?payment=pending`
      },
      auto_return: 'approved',
      external_reference: req.user.email,
      notification_url: `${process.env.BACKEND_URL||'https://randoom-production.up.railway.app'}/api/payments/webhook`,
      statement_descriptor: 'RANDOOM',
      expires: false
    };

    const result = await mpRequest('POST', '/checkout/preferences', preference);
    if (result.status >= 400) return res.status(400).json({ error: 'Error creando preferencia', detail: result.data });

    res.json({
      id: result.data.id,
      init_point: result.data.init_point,          // redirect URL for production
      sandbox_init_point: result.data.sandbox_init_point  // for testing
    });
  } catch(e) {
    console.error('MP error:', e.message);
    res.status(500).json({ error: 'Error con MercadoPago' });
  }
});

// MercadoPago webhook — auto-activate premium on payment
app.post('/api/payments/webhook', async (req, res) => {
  res.status(200).send('OK'); // respond fast
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return;

    const result = await mpRequest('GET', `/v1/payments/${data.id}`);
    const payment = result.data;

    if (payment.status === 'approved') {
      const email = payment.external_reference;
      const user  = usersDB[email];
      if (user && !user.isPremium) {
        user.isPremium = true;
        // Notify via socket if online
        const sock = Object.entries(activeSockets).find(([,s]) => s.email === email);
        if (sock) io.to(sock[0]).emit('premium_activated');
        // Send email
        try { await sendPremiumEmail(email, user.name); } catch(e) {}
      }
    }
  } catch(e) { console.error('Webhook error:', e.message); }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/reports/submit', authUser, (req, res) => {
  const { reportedEmail, reason, description } = req.body;
  if (!reportedEmail||!reason) return res.status(400).json({ error: 'Faltan datos' });
  reportsDB.push({ id: uuidv4(), reporterEmail: req.user.email, reportedEmail, reason,
    description: description||'', status: 'pending', createdAt: new Date().toISOString() });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authAdmin, (req, res) => {
  res.json({
    total:           Object.keys(usersDB).length,
    approved:        Object.values(usersDB).filter(u => u.approved).length,
    pending:         ineRequestsDB.filter(r => r.status === 'pending').length,
    premium:         Object.values(usersDB).filter(u => u.isPremium).length,
    banned:          Object.values(usersDB).filter(u => u.banned).length,
    online:          Object.keys(activeSockets).length,
    pendingINE:      ineRequestsDB.filter(r => r.status === 'pending').length,
    pendingReports:  reportsDB.filter(r => r.status === 'pending').length,
  });
});

app.get('/api/admin/users', authAdmin, (req, res) => {
  res.json(Object.values(usersDB).map(u => ({
    ...sanitizeUser(u),
    isOnline: Object.values(activeSockets).some(s => s.email === u.email)
  })));
});

app.post('/api/admin/users/:email/premium', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  user.isPremium = req.body.active;
  const s = Object.entries(activeSockets).find(([,s]) => s.email === user.email);
  if (s) io.to(s[0]).emit(user.isPremium ? 'premium_activated' : 'premium_removed');
  if (user.isPremium) sendPremiumEmail(user.email, user.name).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/admin/users/:email/ban', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  user.banned = req.body.ban; user.banReason = req.body.reason||'';
  const s = Object.entries(activeSockets).find(([,s]) => s.email === user.email);
  if (s && user.banned) { io.to(s[0]).emit('account_banned', { reason: user.banReason }); io.sockets.sockets.get(s[0])?.disconnect(true); }
  res.json({ ok: true });
});

app.get('/api/admin/ine', authAdmin, (req, res) =>
  res.json(ineRequestsDB.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))));

app.post('/api/admin/ine/:id/review', authAdmin, async (req, res) => {
  const request = ineRequestsDB.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'No encontrado' });
  const { status, note } = req.body;
  request.status = status; request.reviewedAt = new Date().toISOString(); request.reviewNote = note||'';
  const user = usersDB[request.email];
  if (user) {
    user.ineStatus   = status;
    user.ineVerified = status === 'approved';
    user.approved    = status === 'approved'; // THIS unlocks the app
    const s = Object.entries(activeSockets).find(([,s]) => s.email === request.email);
    if (s) io.to(s[0]).emit('ine_reviewed', { status, note });
  }
  try {
    if (status === 'approved') await sendApprovalEmail(request.email, request.userName);
    else await sendRejectionEmail(request.email, request.userName, note);
  } catch(e) { console.error('Email error:', e.message); }
  res.json({ ok: true });
});

app.get('/api/admin/reports', authAdmin, (req, res) =>
  res.json(reportsDB.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))));

app.post('/api/admin/reports/:id/resolve', authAdmin, (req, res) => {
  const r = reportsDB.find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  r.status = 'resolved'; r.resolvedAt = new Date().toISOString();
  res.json({ ok: true });
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
  socket.on('join', ({ token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const u = usersDB[d.email];
      if (!u || u.banned) { socket.emit('error', { message: 'Cuenta suspendida o no encontrada' }); return; }
      activeSockets[socket.id] = {
        socketId: socket.id, email: d.email, name: u.name, age: u.age,
        gender: u.gender, country: u.country, isPremium: u.isPremium,
        filters: {}, partnerId: null, sessionStart: null
      };
      u.totalSessions = (u.totalSessions||0) + 1;
      socket.emit('joined', { isPremium: u.isPremium, ineVerified: u.ineVerified, ineStatus: u.ineStatus, approved: u.approved });
    } catch { socket.emit('error', { message: 'Token inválido' }); }
  });

  socket.on('set_filters', f => { if (activeSockets[socket.id]?.isPremium) activeSockets[socket.id].filters = f; });

  socket.on('find_partner', () => {
    const u = activeSockets[socket.id]; if (!u) return;
    if (u.partnerId) { io.to(u.partnerId).emit('partner_disconnected'); if (activeSockets[u.partnerId]) activeSockets[u.partnerId].partnerId = null; u.partnerId = null; }
    const idx = waitingPool.indexOf(socket.id); if (idx !== -1) waitingPool.splice(idx, 1);
    const mid = findMatch(socket.id);
    if (mid) {
      u.partnerId = mid; activeSockets[mid].partnerId = socket.id;
      u.sessionStart = activeSockets[mid].sessionStart = Date.now();
      const pu = activeSockets[mid];
      socket.emit('partner_found', { partner: { name:pu.name, age:pu.age, gender:pu.gender, country:pu.country, email:pu.email }, initiator: true });
      io.to(mid).emit('partner_found', { partner: { name:u.name, age:u.age, gender:u.gender, country:u.country, email:u.email }, initiator: false });
    } else { waitingPool.push(socket.id); socket.emit('searching'); }
  });

  socket.on('stop_search', () => { const i = waitingPool.indexOf(socket.id); if (i !== -1) waitingPool.splice(i, 1); socket.emit('search_stopped'); });
  socket.on('offer',         d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('offer', d); });
  socket.on('answer',        d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('answer', d); });
  socket.on('ice_candidate', d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('ice_candidate', d); });
  socket.on('chat_message',  d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('chat_message', { text: d.text, from: 'partner' }); });

  socket.on('disconnect', () => {
    const u = activeSockets[socket.id];
    if (u) {
      if (u.partnerId) { io.to(u.partnerId).emit('partner_disconnected'); if (activeSockets[u.partnerId]) activeSockets[u.partnerId].partnerId = null; }
      if (u.sessionStart && usersDB[u.email]) usersDB[u.email].totalMinutes = (usersDB[u.email].totalMinutes||0) + Math.floor((Date.now()-u.sessionStart)/60000);
      const i = waitingPool.indexOf(socket.id); if (i !== -1) waitingPool.splice(i, 1);
      delete activeSockets[socket.id];
    }
  });
});

function sanitizeUser(u) { const { passwordHash, ...r } = u; return r; }

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Randoom v3 corriendo en puerto ${PORT}`));