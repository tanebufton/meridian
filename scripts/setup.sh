#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "  ███╗   ███╗███████╗██████╗ ██╗██████╗ ██╗ █████╗ ███╗   ██╗"
echo "  ████╗ ████║██╔════╝██╔══██╗██║██╔══██╗██║██╔══██╗████╗  ██║"
echo "  ██╔████╔██║█████╗  ██████╔╝██║██║  ██║██║███████║██╔██╗ ██║"
echo "  ██║╚██╔╝██║██╔══╝  ██╔══██╗██║██║  ██║██║██╔══██║██║╚██╗██║"
echo "  ██║ ╚═╝ ██║███████╗██║  ██║██║██████╔╝██║██║  ██║██║ ╚████║"
echo "  ╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝"
echo ""
echo "  Network Latency Monitor — Setup"
echo ""

# 1. Check Node.js >= 20
if ! command -v node &>/dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${NC}"
  exit 1
fi

NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1).split('.')[0]) >= 20 ? 0 : 1)" 2>/dev/null && echo "ok" || echo "fail")
if [[ "$NODE_VER" != "ok" ]]; then
  echo -e "${RED}Error: Node.js >= 20 is required. Found: $(node --version)${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

if ! command -v npm &>/dev/null; then
  echo -e "${RED}Error: npm is not installed.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# 2. npm install
echo ""
echo "Installing dependencies..."
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# 3. Create .env if missing
if [[ ! -f .env ]]; then
  cp .env.example .env
  # Never leave the placeholder secret in place: generate a random one
  SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  chmod 600 .env
  echo -e "${GREEN}✓ .env created with a freshly generated SESSION_SECRET${NC}"
  echo -e "${YELLOW}⚠ Review .env (ADMIN_HOST, TRUST_CF_HEADERS) before exposing anything${NC}"
fi

# 4. Run migrations
echo ""
echo "Running database migrations..."
node scripts/migrate.js
echo -e "${GREEN}✓ Database migrated${NC}"

# 5. Seed?
echo ""
read -rp "Seed example targets? (y/n): " SEED_ANSWER
if [[ "$SEED_ANSWER" =~ ^[Yy]$ ]]; then
  node scripts/seed.js
  echo -e "${GREEN}✓ Example targets seeded${NC}"
fi

# 6. Create initial admin user
echo ""
echo "Create initial admin user:"
node scripts/create-admin.js

# 7. Build Vite apps
echo ""
echo "Building public frontend..."
npm run build --workspace=apps/public
echo -e "${GREEN}✓ Public frontend built${NC}"

echo "Building admin frontend..."
npm run build --workspace=apps/admin
echo -e "${GREEN}✓ Admin frontend built${NC}"

# 8. Get LAN IP
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "<your-lan-ip>")

echo ""
echo -e "${GREEN}✅ Meridian setup complete${NC}"
echo ""
echo "  Public UI:  http://localhost:3001"
echo "  Admin UI:   http://${LAN_IP}:3002"
echo ""
echo "  Start with: pm2 start ecosystem.config.js"
echo "  Save PM2:   pm2 save && pm2 startup"
echo ""
