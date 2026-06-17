#!/bin/bash
# Omegol — Script de inicio rápido

echo ""
echo "🟠 =============================="
echo "   OMEGOL — Iniciando servidor"
echo "🟠 =============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js no está instalado."
  echo "   Descárgalo en https://nodejs.org"
  exit 1
fi

# Install deps if needed
if [ ! -d "backend/node_modules" ]; then
  echo "📦 Instalando dependencias..."
  cd backend && npm install && cd ..
fi

echo "🚀 Iniciando servidor en http://localhost:3001"
echo "🌐 Abre frontend/public/index.html en tu navegador"
echo ""
echo "Presiona Ctrl+C para detener"
echo ""

cd backend && node server.js
