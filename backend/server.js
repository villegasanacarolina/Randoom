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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Ensure upload directory ───────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer config (images only, max 5MB) ─────────────────────────────────────
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

// ── In-memory DB (replace with real DB for production) ───────────────────────
// users[email] = { email, passwordHash, name, age, gender, country, isPremium, banned, createdAt, socketId, ... }
const usersDB    = {};   // keyed by email
const sessionsDB = {};   // socketId → email
const paymentsDB = [];   // array of payment requests
const reportsDB  = [];   // array of reports

// ── Admin credentials ─────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = 'Randoom2024!'; // change in production
const JWT_SECRET     = 'randoom-super-secret-jwt-key-2024';

// ── Active socket sessions ────────────────────────────────────────────────────
const activeSockets  = {}; // socketId → { email, ...profile }
const waitingPool    = [];

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

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, age, gender, country } = req.body;
  if (!email || !password || !name || !age || !gender) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }
  if (usersDB[email]) return res.status(409).json({ error: 'El correo ya está registrado' });
  if (parseInt(age) < 18) return res.status(400).json({ error: 'Debes tener al menos 18 años' });

  const passwordHash = await bcrypt.hash(password, 10);
  usersDB[email] = {
    email, passwordHash, name,
    age: parseInt(age), gender, country: country || 'MX',
    isPremium: false, banned: false,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    totalSessions: 0, totalMinutes: 0
  };
  const token = jwt.sign({ email, name, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(usersDB[email]) });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  // Admin login
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email, isAdmin: true }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, isAdmin: true });
  }

  const user = usersDB[email];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.banned) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida' });

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

// Submit payment request (with optional file upload)
app.post('/api/payments/submit', authUser, upload.single('comprobante'), (req, res) => {
  const { nombre, referencia, fecha, monto } = req.body;
  if (!nombre || !referencia || !fecha || !monto) {
    return res.status(400).json({ error: 'Completa todos los campos' });
  }

  const payment = {
    id: uuidv4(),
    email: req.user.email,
    userName: usersDB[req.user.email]?.name || nombre,
    nombre, referencia, fecha, monto,
    comprobante: req.file ? `/uploads/${req.file.filename}` : null,
    status: 'pending', // pending | approved | rejected
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
    reportedEmail,
    reason, description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// REST API — Admin
// ════════════════════════════════════════════════════════════════════════════════

// Stats
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const total    = Object.keys(usersDB).length;
  const premium  = Object.values(usersDB).filter(u => u.isPremium).length;
  const banned   = Object.values(usersDB).filter(u => u.banned).length;
  const online   = Object.keys(activeSockets).length;
  const pending  = paymentsDB.filter(p => p.status === 'pending').length;
  const reports  = reportsDB.filter(r => r.status === 'pending').length;
  res.json({ total, premium, banned, online, pendingPayments: pending, pendingReports: reports });
});

// All users
app.get('/api/admin/users', authAdmin, (req, res) => {
  const list = Object.values(usersDB).map(u => ({
    ...sanitizeUser(u),
    isOnline: Object.values(activeSockets).some(s => s.email === u.email)
  }));
  res.json(list);
});

// Activate / deactivate premium
app.post('/api/admin/users/:email/premium', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.isPremium = req.body.active;
  // Notify via socket if online
  const sock = Object.entries(activeSockets).find(([, s]) => s.email === user.email);
  if (sock) io.to(sock[0]).emit(user.isPremium ? 'premium_activated' : 'premium_removed');
  res.json({ ok: true });
});

// Ban / unban user
app.post('/api/admin/users/:email/ban', authAdmin, (req, res) => {
  const user = usersDB[decodeURIComponent(req.params.email)];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.banned = req.body.ban;
  user.banReason = req.body.reason || '';
  // Kick from socket if online
  const sock = Object.entries(activeSockets).find(([, s]) => s.email === user.email);
  if (sock && user.banned) {
    io.to(sock[0]).emit('account_banned', { reason: user.banReason });
    io.sockets.sockets.get(sock[0])?.disconnect(true);
  }
  res.json({ ok: true });
});

// All payments
app.get('/api/admin/payments', authAdmin, (req, res) => {
  res.json(paymentsDB.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Approve / reject payment
app.post('/api/admin/payments/:id/review', authAdmin, (req, res) => {
  const payment = paymentsDB.find(p => p.id === req.params.id);
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
  payment.status     = req.body.status; // approved | rejected
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

// All reports
app.get('/api/admin/reports', authAdmin, (req, res) => {
  res.json(reportsDB.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Resolve report
app.post('/api/admin/reports/:id/resolve', authAdmin, (req, res) => {
  const report = reportsDB.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });
  report.status = 'resolved';
  report.resolvedAt = new Date().toISOString();
  res.json({ ok: true });
});

// Health
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
    if (activeSockets[socket.id]?.isPremium) {
      activeSockets[socket.id].filters = filters;
    }
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

      const partnerUser = usersDB[activeSockets[matchId].email];
      const myUser      = usersDB[user.email];

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
      // track minutes
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

// ── Helper ────────────────────────────────────────────────────────────────────
function sanitizeUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Randoom v2 corriendo en puerto ${PORT}`));
