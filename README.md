# CrewStalker Backend 🛫

Backend server for crewstalker.com — automatically tracks flight crew schedules and sends push notifications to spouses.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```
Fill in your values in `.env`

### 3. Generate VAPID keys for push notifications (run once)
```bash
node generate-vapid-keys.js
```
Paste the output keys into your `.env` file AND into Railway environment variables.

### 4. Run locally
```bash
npm run dev
```

### 5. Deploy to Railway
- Push this folder to a GitHub repo
- Connect the repo in Railway
- Add all environment variables from `.env` into Railway → Variables
- Railway auto-deploys on every push

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | / | Health check |
| POST | /analyze | Upload schedule photo, returns flights |
| GET | /flights | Get user's saved flights |
| POST | /subscribe | Save push notification subscription |
| GET | /vapid-public-key | Get public VAPID key for frontend |

## How notifications work
- Server checks every minute for upcoming flights
- Sends push notifications at: 2 hours before, 30 minutes before, takeoff, and landing
- Works even when the user's browser is closed (real push notifications via web-push)

## Tech stack
- Express.js — server
- Supabase — database + auth
- web-push — push notifications
- node-cron — notification scheduler
- Anthropic API — reading schedule photos
