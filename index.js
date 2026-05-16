require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Web Push ──────────────────────────────────────────────
webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

// ── Auth helper ───────────────────────────────────────────
async function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'CrewStalker', version: '1.0.0' });
});

// ─────────────────────────────────────────────────────────
// ROUTE: Analyze schedule photo
// POST /analyze
// Body: multipart/form-data with field "photo"
// ─────────────────────────────────────────────────────────
app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/png';

    // Call Anthropic API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        system: `You are an expert flight schedule parser. Extract ALL flights from the image.
Return ONLY a valid JSON array. No markdown, no explanation, no backticks.
Each object must have exactly:
- flightNumber: string e.g. "UA312"
- airline: string e.g. "United Airlines" (infer from prefix: UA=United, AA=American, DL=Delta, WN=Southwest, B6=JetBlue, AS=Alaska, F9=Frontier, NK=Spirit)
- origin: string IATA code e.g. "ORD"
- destination: string IATA code e.g. "AUS"
- departureTime: string 24h "HH:MM" e.g. "19:45", or ""
- arrivalTime: string 24h "HH:MM" e.g. "22:49", or ""
- date: string "MM/DD" e.g. "05/04", or ""
- gate: string e.g. "C22" or ""
- status: "On time","Delayed","Boarding","Departed","Cancelled", or "Unknown"
For crew schedules: times prefixed with "S" are scheduled times — use those.
Return [] if no flights found.`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Extract every flight. Return JSON array only.' }
          ]
        }]
      })
    });

    const anthropicData = await anthropicRes.json();
    if (anthropicData.error) throw new Error(anthropicData.error.message);

    const raw = (anthropicData.content || []).map(b => b.text || '').join('');
    const flights = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (!Array.isArray(flights) || flights.length === 0) {
      return res.status(422).json({ error: 'No flights detected in photo' });
    }

    // Delete old flights for this user and save new ones
    await supabase.from('flights').delete().eq('user_id', user.id);

    const rows = flights.map(f => ({ ...f, user_id: user.id }));
    const { error: insertError } = await supabase.from('flights').insert(rows);
    if (insertError) throw insertError;

    res.json({ success: true, flights });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze photo' });
  }
});

// ─────────────────────────────────────────────────────────
// ROUTE: Get user's saved flights
// GET /flights
// ─────────────────────────────────────────────────────────
app.get('/flights', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const { data, error } = await supabase
      .from('flights')
      .select('*')
      .eq('user_id', user.id)
      .order('flight_date', { ascending: true });

    if (error) throw error;
    res.json({ flights: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------
// ROUTE: Save manually entered flights
// POST /flights/manual
// ---------------------------------------------------------
app.post('/flights/manual', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { flights } = req.body;
    if (!Array.isArray(flights) || flights.length === 0) return res.status(400).json({ error: 'No flights provided' });
    await supabase.from('flights').delete().eq('user_id', user.id);
    const rows = flights.map(f => ({
      flight_number: f.flightNumber,
      airline: f.airline,
      origin: f.origin,
      destination: f.destination,
      departure_time: f.departureTime,
      arrival_time: f.arrivalTime,
      flight_date: f.date,
      gate: f.gate,
      status: f.status,
      user_id: user.id
    }));
    const { error } = await supabase.from('flights').insert(rows);
    if (error) throw error;
    res.json({ success: true, flights });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// ROUTE: Save push subscription
// POST /subscribe
// Body: { subscription: PushSubscription }
// ─────────────────────────────────────────────────────────
app.post('/subscribe', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'No subscription provided' });

    // Upsert subscription (replace old one for this user)
    await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
    const { error } = await supabase.from('push_subscriptions').insert({
      user_id: user.id,
      subscription
    });
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// ROUTE: Get VAPID public key (needed by frontend)
// GET /vapid-public-key
// ─────────────────────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// ─────────────────────────────────────────────────────────
// NOTIFICATION SCHEDULER
// Runs every minute, checks for flights needing alerts
// ─────────────────────────────────────────────────────────
async function sendPushToUser(userId, title, body) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('subscription')
    .eq('user_id', userId);

  if (!subs || subs.length === 0) return;

  const payload = JSON.stringify({ title, body });

  for (const row of subs) {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (err) {
      // Subscription expired — remove it
      if (err.statusCode === 410) {
        await supabase.from('push_subscriptions')
          .delete()
          .eq('user_id', userId);
      }
    }
  }
}

function parseFlightDateTime(flight) {
  if (!flight.departure_time || !flight.flight_date) return null;
  const [month, day] = flight.flight_date.split('/');
  const [hour, minute] = flight.departure_time.split(':');
  const year = new Date().getFullYear();
  return new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), 0);
}

function parseArrivalDateTime(flight) {
  if (!flight.arrival_time || !flight.flight_date) return null;
  const [month, day] = flight.flight_date.split('/');
  const [hour, minute] = flight.arrival_time.split(':');
  const year = new Date().getFullYear();
  const dep = parseFlightDateTime(flight);
  const arr = new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), 0);
  if (dep && arr < dep) arr.setDate(arr.getDate() + 1);
  return arr;
}

// Check every minute for flights that need notifications
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    const { data: flights } = await supabase
      .from('flights')
      .select('*')
      .not('departure_time', 'is', null)
      .not('flight_date', 'is', null);

    if (!flights || flights.length === 0) return;

    for (const flight of flights) {
      const dep = parseFlightDateTime(flight);
      if (!dep) continue;

      const fn = flight.flight_number || 'Flight';
      const route = `${flight.origin || '?'} → ${flight.destination || '?'}`;
      const gate = flight.gate ? ` · Gate ${flight.gate}` : '';
      const depMs = dep.getTime();
      const diffMin = (depMs - nowMs) / 60000;

      // 2-hour reminder (between 120 and 121 minutes before)
      if (diffMin >= 119 && diffMin < 120) {
        await sendPushToUser(flight.user_id,
          `✈️ 2 hrs: ${fn} departs soon`,
          `${route} at ${flight.departure_time}${gate}`
        );
      }

      // 30-minute reminder (between 30 and 31 minutes before)
      if (diffMin >= 29 && diffMin < 30) {
        await sendPushToUser(flight.user_id,
          `🚨 30 min: ${fn} boarding now!`,
          `${route} at ${flight.departure_time}${gate} — check the gate!`
        );
      }

      // Takeoff (within 1 minute of departure)
      if (diffMin >= -1 && diffMin < 0) {
        await sendPushToUser(flight.user_id,
          `✈️ ${fn} is in the air!`,
          `${route} — he's on his way!`
        );
      }

      // Landing
      const arr = parseArrivalDateTime(flight);
      if (arr) {
        const arrDiff = (arr.getTime() - nowMs) / 60000;
        if (arrDiff >= -1 && arrDiff < 0) {
          await sendPushToUser(flight.user_id,
            `🛬 ${fn} has landed!`,
            `${route} — he should be deplaning soon!`
          );
        }
      }
    }
  } catch (err) {
    console.error('Scheduler error:', err);
  }
});

// ── Start server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛫 CrewStalker backend running on port ${PORT}`);
  console.log(`   Notification scheduler active — checking every minute`);
});
