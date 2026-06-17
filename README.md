# 🟠 Randoom v2 — Videochat Aleatorio

## 📁 Estructura
```
randoom/
├── backend/
│   ├── server.js       ← Servidor Node.js + Socket.io + JWT + Multer
│   └── package.json
└── frontend/
    └── public/
        ├── index.html  ← App principal (usuarios)
        └── admin.html  ← Panel administrador (separado)
```

---

## 🚀 Instalación y arranque

```bash
# 1. Instalar dependencias
cd backend
npm install

# 2. Iniciar servidor
node server.js

# 3. Abrir en el navegador:
#    App usuarios: http://localhost:3001
#    Panel admin:  http://localhost:3001/admin.html
```

---

## 🔐 Acceso al panel admin

```
URL:         http://localhost:3001/admin.html
Email:       admin@randoom.com
Contraseña:  Randoom2024!
```

**Cambia la contraseña en `server.js` líneas:**
```js
const ADMIN_EMAIL    = 'admin@randoom.com';
const ADMIN_PASSWORD = 'Randoom2024!';
```

---

## ✨ Funcionalidades completas

### Usuarios
- ✅ Registro con email y contraseña
- ✅ Login / Logout con sesión persistente
- ✅ Perfil: nombre, edad, género, país
- ✅ Videollamadas WebRTC peer-to-peer
- ✅ Chat de texto en tiempo real
- ✅ Límite de 1 minuto (versión gratis)
- ✅ Tiempo ilimitado (Premium)
- ✅ Reportar usuario con lista de motivos
- ✅ Auto-login (recuerda sesión)

### Premium ($399 MXN)
- ✅ Depósito a BBVA: 4152 3145 0215 4761
- ✅ Beneficiaria: Ana Carolina Torres Villegas
- ✅ Subida de foto o PDF del comprobante
- ✅ Activación manual por el admin
- ✅ Filtros: género, país, rango de edad

### Panel Admin (`/admin.html`)
- ✅ Login separado con credenciales admin
- ✅ Dashboard con métricas en tiempo real
- ✅ Lista de usuarios: buscar, filtrar, dar/quitar Premium
- ✅ Banear / desbanear cuentas (con notificación en tiempo real)
- ✅ Ver comprobantes de pago con imagen
- ✅ Aprobar pago → activa Premium automáticamente
- ✅ Rechazar pago con nota
- ✅ Ver reportes con motivo y descripción
- ✅ Resolver reportes y banear usuarios desde ahí

---

## 🏦 Datos bancarios
| Campo | Valor |
|---|---|
| Banco | BBVA |
| Tarjeta | 4152 3145 0215 4761 |
| Beneficiaria | Ana Carolina Torres Villegas |
| Monto | $399 MXN |

---

## ⚙️ Configuración rápida

| Qué cambiar | Dónde |
|---|---|
| Contraseña admin | `server.js` línea 44 |
| Precio Premium | `index.html` busca `$399 MXN` |
| Puerto del servidor | `PORT=4000 node server.js` |

---

## 📦 Dependencias
- `express` — servidor HTTP
- `socket.io` — tiempo real y WebRTC signaling
- `multer` — subida de comprobantes
- `bcryptjs` — contraseñas seguras
- `jsonwebtoken` — autenticación JWT
- `cors`, `uuid`, `body-parser`
