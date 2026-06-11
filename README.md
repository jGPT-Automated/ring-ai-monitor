# ring-ai-monitor

Ring doorbell → Claude vision classifier → Supabase → Telegram alerts + live dashboard.

## What it does

- Watches Ring cameras for motion + doorbell press events
- Snapshots the frame → sends to Claude claude-opus-4-5 vision
- Classifies: mailman / delivery_driver / garbageman / neighbor / pedestrian / vehicle / animal / empty / unknown
- Identifies carrier: USPS / FedEx / UPS / Amazon / DHL
- Fires Telegram alert instantly
- Stores all events in Supabase
- Dashboard at localhost:3000 with live feed, category breakdown, hourly heatmap, mailman pattern

## Setup

### 1. Supabase schema
Run `schema.sql` in your Supabase SQL editor.

### 2. Ring refresh token
```bash
npx ring-auth-cli
```
Follow prompts → copy the refresh token into `.env`

### 3. Environment
```bash
cp .env.example .env
# Fill in all values
```

### 4. Install & run
```bash
npm install

# Monitor only (no dashboard)
npm start

# Dashboard only (reads from Supabase, no Ring connection)
npm run dashboard

# Both (two terminals or use pm2)
npm start & npm run dashboard
```

Dashboard: http://localhost:3000

## Notes

- **Wired cameras only** for reliable getSnapshot(). Battery cameras need Ring Protect subscription.
- Claude model: claude-opus-4-5. Swap for claude-haiku for lower cost if volume is high.
- Dashboard polls every 15s. No websockets needed — Supabase does the persistence.

## Stack
- `ring-client-api` — Ring event subscription
- `@anthropic-ai/sdk` — Claude vision
- `@supabase/supabase-js` — event storage + queries
- `node-telegram-bot-api` — push alerts
- `express` — dashboard server
