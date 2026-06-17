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
const https = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Ensure upload directory ───────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ── In-memory DB ──────────────────────────────────────────────────────────────
const usersDB      = {};  // email → user
const pendingCodes = {};  // email → { code, data, expiresAt }
const paymentsDB   = [];
const reportsDB    = [];

// ── Config ────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = 'Randoom2024!';
const JWT_SECRET     = 'randoom-super-secret-jwt-key-2024';

// ── Nodemailer (Gmail) ────────────────────────────────────────────────────────
// ── Resend email sender (uses HTTPS, never blocked) ──────────────────────────
function sendWithResend(to, subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: 'Randoom <onboarding@resend.dev>',
      to: [to],
      subject,
      html
    });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Resend error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendVerificationEmail(email, name, code) {
  const subject = '🟠 Tu código de verificación — Randoom';
  const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"/></head>
      <body style="margin:0;padding:0;background:#0E0400;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="max-width:480px;margin:40px auto;background:#1A0800;border-radius:20px;overflow:hidden;border:1px solid rgba(255,107,0,0.3);">
          
          <!-- Header -->
          <div style="background:linear-gradient(135deg,#FF6B00,#D95A00);padding:32px;text-align:center;">
            <div style="background:rgba(255,255,255,0.15);display:inline-block;padding:12px 20px;border-radius:14px;margin-bottom:12px;">
              <span style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;">RD</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Rand<span style="opacity:0.85">oom</span></h1>
          </div>

          <!-- Body -->
          <div style="padding:36px 32px;text-align:center;">
            <p style="color:#C8A882;font-size:15px;margin:0 0 8px;">Hola, <strong style="color:#fff">${name}</strong> 👋</p>
            <p style="color:#C8A882;font-size:14px;margin:0 0 32px;line-height:1.6;">
              Usa este código para confirmar tu correo y activar tu cuenta en Randoom.
            </p>

            <!-- Code box -->
            <div style="background:rgba(255,107,0,0.12);border:2px solid rgba(255,107,0,0.4);border-radius:16px;padding:28px;margin-bottom:28px;">
              <p style="color:#C8A882;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;">Tu código de verificación</p>
              <div style="font-size:48px;font-weight:900;color:#FF6B00;letter-spacing:12px;font-family:monospace;">${code}</div>
              <p style="color:#8A6040;font-size:12px;margin:12px 0 0;">⏱ Válido por 15 minutos</p>
            </div>

            <p style="color:#8A6040;font-size:12px;line-height:1.6;margin:0;">
              Si no creaste una cuenta en Randoom, ignora este mensaje.<br/>
              Nadie más puede ver este código.
            </p>
          </div>

          <!-- Footer -->
          <div style="padding:20px 32px;border-top:1px solid rgba(255,107,0,0.15);text-align:center;">
            <p style="color:#8A6040;font-size:11px;margin:0;">
              © 2024 Randoom — Conecta con el mundo 🌎
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

  await sendWithResend(email, subject, html);
}

// ── Active socket sessions ────────────────────────────────────────────────────
const activeSockets = {};
const waitingPool   = [];

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── JWT middleware ────────────────────────────────────────────────────────────
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'No es admin' });
    req.admin = decoded;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

function authUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// ════════════════════════════════════════════════════════════════════════════════
// REST API — Auth
// ════════════════════════════════════════════════════════════════════════════════

// PASO 1: Registro → guarda temporalmente y envía código
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, age, gender, country } = req.body;
  if (!email || !password || !name || !age || !gender)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  if (usersDB[email])
    return res.status(409).json({ error: 'El correo ya está registrado' });
  if (parseInt(age) < 18)
    return res.status(400).json({ error: 'Debes tener al menos 18 años' });

  // Genera código de 6 dígitos
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const passwordHash = await bcrypt.hash(password, 10);

  // Guarda temporalmente por 15 minutos
  pendingCodes[email] = {
    code,
    expiresAt: Date.now() + 15 * 60 * 1000,
    data: { email, passwordHash, name, age: parseInt(age), gender, country: country || 'MX' }
  };

  // Envía email
  try {
    await sendVerificationEmail(email, name, code);
    res.json({ ok: true, message: 'Código enviado a tu correo' });
  } catch (e) {
    console.error('Error enviando email:', e.message);
    // Si falla el email, igual guardamos el código y lo mostramos en respuesta (modo desarrollo)
    res.json({ ok: true, message: 'Código enviado', devCode: process.env.NODE_ENV !== 'production' ? code : undefined });
  }
});

// PASO 2: Verificar código → crea la cuenta
app.post('/api/auth/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code)
    return res.status(400).json({ error: 'Faltan datos' });

  const pending = pendingCodes[email];
  if (!pending)
    return res.status(404).json({ error: 'No hay registro pendiente para este correo' });
  if (Date.now() > pending.expiresAt) {
    delete pendingCodes[email];
    return res.status(410).json({ error: 'El código expiró. Vuelve a registrarte.' });
  }
  if (pending.code !== code.trim())
    return res.status(401).json({ error: 'Código incorrecto' });

  // Crea el usuario
  const { data } = pending;
  usersDB[email] = {
    ...data,
    isPremium: false, banned: false,
    createdAt: new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
    totalSessions: 0, totalMinutes: 0,
    verified: true
  };
  delete pendingCodes[email];

  const token = jwt.sign({ email, name: data.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(usersDB[email]) });
});

// Reenviar código
app.post('/api/auth/resend', async (req, res) => {
  const { email } = req.body;
  const pending = pendingCodes[email];
  if (!pending)
    return res.status(404).json({ error: 'No hay registro pendiente para este correo' });

  // Renueva código y tiempo
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pending.code      = code;
  pending.expiresAt = Date.now() + 15 * 60 * 1000;

  try {
    await sendVerificationEmail(email, pending.data.name, code);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, isAdmin: true });
  }

  const user = usersDB[email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.banned) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida' });
  if (!user.verified) return res.status(403).json({ error: 'Verifica tu correo primero' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' });

  user.lastSeen = new Date().toISOString();
  const token = jwt.sign({ email, name: user.name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
});

// Get current user
app.get('/api/auth/me', authUser, (req, res) => {
  const user = usersDB[req.user.email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(sanitizeUser(user));
});

// ════════════════════════════════════════════════════════════════════════════════
// REST API — Payments
// ════════════════════════════════════════════════════════════════════════════════
app.post('/api/payments/submit', authUser, upload.single('comprobante'), (req, res) => {
  const { nombre, referencia, fecha, monto } = req.body;
  if (!nombre || !referencia || !fecha || !monto)
    return res.status(400).json({ error: 'Completa todos los campos' });

  const payment = {
    id: uuidv4(),
    email: req.user.email,
    userName: usersDB[req.user.email]?.name || nombre,
    nombre, referencia, fecha, monto,
    comprobante: req.file ? `/uploads/${req.file.filename}` : null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewNote: ''
  };
  paymentsDB.push(payment);
  res.json({ ok: true, paymentId: payment.id });
});

// ════════════════════════════════════════════════════════════════════════════════
// REST API — Reports
// ════════════════════════════════════════════════════════════════════════════════
app.post('/api/reports/submit', authUser, (req, res) => {
  const { reportedEmail, reason, description } = req.body;
  if (!reportedEmail || !reason) return res.status(400).json({ error: 'Faltan datos' });
  reportsDB.push({
    id: uuidv4(),
    reporterEmail: req.user.email,
    reportedEmail, reason,
    description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// REST API — Admin
// ════════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const total   = Object.keys(usersDB).length;
  const premium = Object.values(usersDB).filter(u => u.isPremium).length;
  const banned  = Object.values(usersDB).filter(u => u.banned).length;
  const online  = Object.keys(activeSockets).length;
  const pending = paymentsDB.filter(p => p.status === 'pending').length;
  const reports = reportsDB.filter(r => r.status === 'pending').length;
  res.json({ total, premium, banned, online, pendingPayments: pending, pendingReports: reports });
});

app.get('/api/admin/users', authAdmin, (req, res) => {
  const list = Object.values(usersDB).map(u => ({
    ...sanitizeUser(u),
    isOnline: Object.values(activeSockets).some(s => s.email === u.email)
  }));
  res.json(list);
});

app.post('/api/admin/users/:email/premium', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.isPremium = req.body.active;
  const sock = Object.entries(activeSockets).find(([, s]) => s.email === user.email);
  if (sock) io.to(sock[0]).emit(user.isPremium ? 'premium_activated' : 'premium_removed');
  res.json({ ok: true });
});

app.post('/api/admin/users/:email/ban', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.banned    = req.body.ban;
  user.banReason = req.body.reason || '';
  const sock = Object.entries(activeSockets).find(([, s]) => s.email === user.email);
  if (sock && user.banned) {
    io.to(sock[0]).emit('account_banned', { reason: user.banReason });
    io.sockets.sockets.get(sock[0])?.disconnect(true);
  }
  res.json({ ok: true });
});

app.get('/api/admin/payments', authAdmin, (req, res) => {
  res.json(paymentsDB.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/admin/payments/:id/review', authAdmin, (req, res) => {
  const payment = paymentsDB.find(p => p.id === req.params.id);
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
  payment.status     = req.body.status;
  payment.reviewedAt = new Date().toISOString();
  payment.reviewNote = req.body.note || '';
  if (req.body.status === 'approved') {
    const user = usersDB[payment.email];
    if (user) {
      user.isPremium = true;
      const sock = Object.entries(activeSockets).find(([, s]) => s.email === payment.email);
      if (sock) io.to(sock[0]).emit('premium_activated');
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/reports', authAdmin, (req, res) => {
  res.json(reportsDB.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/admin/reports/:id/resolve', authAdmin, (req, res) => {
  const report = reportsDB.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });
  report.status     = 'resolved';
  report.resolvedAt = new Date().toISOString();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', online: Object.keys(activeSockets).length }));

// ════════════════════════════════════════════════════════════════════════════════
// Socket.io
// ════════════════════════════════════════════════════════════════════════════════
function matchesFilters(seeker, candidate) {
  const s = activeSockets[seeker];
  const c = activeSockets[candidate];
  if (!s || !c) return false;
  if (s.isPremium && s.filters) {
    const f = s.filters;
    if (f.gender  && f.gender  !== 'any' && c.gender  !== f.gender)  return false;
    if (f.country && f.country !== 'any' && c.country !== f.country) return false;
    if (f.ageMin  && c.age < parseInt(f.ageMin)) return false;
    if (f.ageMax  && c.age > parseInt(f.ageMax)) return false;
  }
  if (c.isPremium && c.filters) {
    const f = c.filters;
    if (f.gender  && f.gender  !== 'any' && s.gender  !== f.gender)  return false;
    if (f.country && f.country !== 'any' && s.country !== f.country) return false;
    if (f.ageMin  && s.age < parseInt(f.ageMin)) return false;
    if (f.ageMax  && s.age > parseInt(f.ageMax)) return false;
  }
  return true;
}

function findMatch(socketId) {
  for (let i = 0; i < waitingPool.length; i++) {
    const c = waitingPool[i];
    if (c === socketId || !activeSockets[c]) continue;
    if (matchesFilters(socketId, c)) { waitingPool.splice(i, 1); return c; }
  }
  return null;
}

io.on('connection', (socket) => {
  socket.on('join', ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user    = usersDB[decoded.email];
      if (!user || user.banned) { socket.emit('error', { message: 'Cuenta suspendida' }); return; }
      activeSockets[socket.id] = {
        socketId: socket.id, email: decoded.email,
        name: user.name, age: user.age, gender: user.gender,
        country: user.country, isPremium: user.isPremium,
        filters: {}, partnerId: null, partnerEmail: null,
        sessionStart: null
      };
      user.totalSessions = (user.totalSessions || 0) + 1;
      socket.emit('joined', { isPremium: user.isPremium });
    } catch { socket.emit('error', { message: 'Token inválido' }); }
  });

  socket.on('set_filters', (filters) => {
    if (activeSockets[socket.id]?.isPremium) activeSockets[socket.id].filters = filters;
  });

  socket.on('find_partner', () => {
    const user = activeSockets[socket.id];
    if (!user) return;
    if (user.partnerId) {
      io.to(user.partnerId).emit('partner_disconnected');
      if (activeSockets[user.partnerId]) activeSockets[user.partnerId].partnerId = null;
      user.partnerId = null;
    }
    const idx = waitingPool.indexOf(socket.id);
    if (idx !== -1) waitingPool.splice(idx, 1);
    const matchId = findMatch(socket.id);
    if (matchId) {
      user.partnerId = matchId;
      activeSockets[matchId].partnerId = socket.id;
      user.sessionStart = Date.now();
      activeSockets[matchId].sessionStart = Date.now();
      socket.emit('partner_found', {
        partner: { name: activeSockets[matchId].name, age: activeSockets[matchId].age, gender: activeSockets[matchId].gender, country: activeSockets[matchId].country, email: activeSockets[matchId].email },
        initiator: true
      });
      io.to(matchId).emit('partner_found', {
        partner: { name: user.name, age: user.age, gender: user.gender, country: user.country, email: user.email },
        initiator: false
      });
    } else {
      waitingPool.push(socket.id);
      socket.emit('searching');
    }
  });

  socket.on('stop_search', () => {
    const idx = waitingPool.indexOf(socket.id);
    if (idx !== -1) waitingPool.splice(idx, 1);
    socket.emit('search_stopped');
  });

  socket.on('offer',         d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('offer', d); });
  socket.on('answer',        d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('answer', d); });
  socket.on('ice_candidate', d => { const u = activeSockets[socket.id]; if (u?.partnerId) io.to(u.partnerId).emit('ice_candidate', d); });

  socket.on('chat_message', d => {
    const u = activeSockets[socket.id];
    if (u?.partnerId) io.to(u.partnerId).emit('chat_message', { text: d.text, from: 'partner' });
  });

  socket.on('disconnect', () => {
    const user = activeSockets[socket.id];
    if (user) {
      if (user.partnerId) {
        io.to(user.partnerId).emit('partner_disconnected');
        if (activeSockets[user.partnerId]) activeSockets[user.partnerId].partnerId = null;
      }
      if (user.sessionStart && usersDB[user.email]) {
        usersDB[user.email].totalMinutes = (usersDB[user.email].totalMinutes || 0) +
          Math.floor((Date.now() - user.sessionStart) / 60000);
      }
      const idx = waitingPool.indexOf(socket.id);
      if (idx !== -1) waitingPool.splice(idx, 1);
      delete activeSockets[socket.id];
    }
  });
});

function sanitizeUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Randoom v2 corriendo en puerto ${PORT}`));