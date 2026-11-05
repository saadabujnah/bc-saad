import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server } from 'socket.io';

import { config, supabaseEnabled } from './config.js';
import { createStore } from './db.js';
import { CrashGame } from './engine.js';
import { diceRollFromSeed } from './provablyFair.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

const store = createStore(config);
const game = new CrashGame({ store, io, config });

const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());

// Home is the games lobby. Crash and Dice are separate game pages.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'home.html')));
app.get('/home', (_req, res) => res.sendFile(path.join(publicDir, 'home.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(publicDir, 'bc.html')));
app.get('/crash', (_req, res) => res.sendFile(path.join(publicDir, 'bc.html')));
app.get('/crash/register', (_req, res) => res.sendFile(path.join(publicDir, 'bc.html')));
app.get('/classic', (_req, res) => res.sendFile(path.join(publicDir, 'bc.html')));
app.get('/classic/register', (_req, res) => res.sendFile(path.join(publicDir, 'bc.html')));
app.get('/dice', (_req, res) => res.sendFile(path.join(publicDir, 'dice.html')));
app.get('/dice/register', (_req, res) => res.sendFile(path.join(publicDir, 'dice.html')));

app.use(express.static(publicDir));

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

app.get('/api/config', (_req, res) => {
  res.json({
    mode: store.mode,
    supabaseEnabled,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    growthRate: config.growthRate,
    waitingMs: config.waitingMs,
    crashedMs: config.crashedMs,
    houseEdgePercent: game.getHouseEdgePercent(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: store.mode,
    phase: game.phase,
    houseEdgePercent: game.getHouseEdgePercent(),
    round: game.publicRound(),
  });
});

app.get('/api/house-edge', async (_req, res) => {
  try {
    await game.refreshHouseEdge();
    res.json({ houseEdgePercent: game.getHouseEdgePercent() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/house-edge', async (req, res) => {
  if (!config.houseEdgeAdminKey) {
    return res.status(503).json({
      error: 'House edge admin is disabled. Set HOUSE_EDGE_ADMIN_KEY to enable it.',
    });
  }

  if (req.headers['x-admin-key'] !== config.houseEdgeAdminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const percent = Number(req.body?.houseEdgePercent);
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
    return res.status(400).json({
      error: 'houseEdgePercent must be a number between 0 and 99.99.',
    });
  }

  try {
    const saved = await game.setHouseEdgePercent(percent);
    res.json({ ok: true, houseEdgePercent: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history', async (_req, res) => {
  try {
    const history = await store.getRecentRounds(20);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await store.verifyToken(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const profile = await store.getProfile(user.id);
    res.json({
      id: profile.id,
      username: profile.username,
      balance: Number(profile.balance),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user-bets', async (req, res) => {
  try {
    const user = await store.verifyToken(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const bets = await store.getUserBets(user.id, 50);
    res.json({ bets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------------------- dice ----------------------------------- */

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

app.get('/api/dice/history', async (req, res) => {
  try {
    const user = await store.verifyToken(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const rolls = await store.getUserDiceRolls(user.id, 50);
    res.json({ rolls, houseEdgePercent: game.getHouseEdgePercent() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dice/bet', async (req, res) => {
  try {
    const user = await store.verifyToken(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

    const amount = round2(req.body?.amount);
    const target = round2(req.body?.target);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount.', code: 'INVALID_AMOUNT' });
    }

    const source = game.getCurrentSeedSource();
    if (!source?.serverSeed || !source.serverSeedHash) {
      return res.status(503).json({
        error: 'The shared Crash seed is not ready. Try again in a moment.',
        code: 'DICE_NOT_READY',
      });
    }

    const edgePercent = Math.min(
      99.99,
      Math.max(0, Number(source.houseEdgePercent ?? game.getHouseEdgePercent()) || 0)
    );
    const maxTarget = Math.min(99, Math.max(1, Math.floor((100 - edgePercent) * 100) / 100));

    if (!Number.isFinite(target) || target < 1 || target > maxTarget) {
      return res.status(400).json({
        error: `Target must be between 1 and ${maxTarget}.`,
        code: 'INVALID_TARGET',
      });
    }

    const nonce = crypto.randomBytes(6).readUIntBE(0, 6);
    const roll = diceRollFromSeed(source.serverSeed, source.clientSeed, nonce);

    const multiplier =
      Math.round(Math.min(10000, Math.max(0.0001, (100 - edgePercent) / target)) * 10000) /
      10000;

    const result = await store.placeDiceBet({
      userId: user.id,
      roundId: source.roundId,
      amount,
      target,
      nonce,
      roll,
      multiplier,
      serverSeedHash: source.serverSeedHash,
    });

    res.json({
      ok: true,
      id: result.roll.id,
      status: result.roll.status,
      win: result.roll.status === 'won',
      roll: result.roll.roll,
      target: result.roll.target,
      amount: result.roll.amount,
      multiplier: result.roll.multiplier,
      payout: result.roll.payout,
      balance: result.balance,
      roundId: source.roundId,
      roundNumber: source.roundNumber,
      nonce: result.roll.nonce,
      serverSeedHash: source.serverSeedHash,
      clientSeed: source.clientSeed,
      houseEdgePercent: edgePercent,
      serverSeed: source.revealed ? source.serverSeed : null,
      createdAt: result.roll.createdAt,
    });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code || 'DICE_ERROR' });
  }
});

// Registration is done server-side with the service role so it does not depend
// on the project's SMTP / confirmation-email rate limits.
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body || {};

    if (!/^[A-Za-z0-9_]{3,20}$/.test(String(username || ''))) {
      return res.status(400).json({
        error: 'اسم المستخدم يجب أن يكون 3-20 حرفًا (أحرف/أرقام/شرطة سفلية).',
      });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) {
      return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
    }
    if (store.mode !== 'supabase') {
      return res.status(400).json({ error: 'التسجيل غير متاح في وضع العرض التجريبي.' });
    }

    const user = await store.createUser({ email, password, username });
    res.json({ ok: true, user: { id: user.id, username } });
  } catch (error) {
    const message = error?.message || 'Registration failed.';

    if (/USERNAME_TAKEN/.test(message)) {
      return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل.' });
    }
    if (/already|exists|registered/i.test(message)) {
      return res.status(409).json({ error: 'هذا البريد مسجّل بالفعل. جرّب تسجيل الدخول.' });
    }
    if (/password/i.test(message)) {
      return res.status(400).json({ error: 'كلمة المرور ضعيفة أو غير صالحة.' });
    }

    res.status(400).json({ error: message });
  }
});

/* --------------------------------- Socket.io -------------------------------- */

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || null;

    // No token: allow the socket as a read-only spectator so the live game is
    // visible before signing in (matches the bc.html layout).
    if (!token) {
      socket.data.userId = null;
      return next();
    }

    const user = await store.verifyToken(token);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.data.userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
});

io.on('connection', async (socket) => {
  const userId = socket.data.userId;

  socket.emit('state', game.getState());

  if (userId) {
    try {
      const profile = await store.getProfile(userId);
      socket.emit('me', { id: profile.id, username: profile.username });
      socket.emit('balance', { balance: Number(profile.balance) });
    } catch (error) {
      console.error('[socket] failed to load profile:', error);
      socket.emit('fatal', { error: error.message });
    }
  } else {
    socket.emit('me', null);
  }

  socket.on('bet', async (payload, ack) => {
    if (!userId) {
      ack?.({ ok: false, code: 'UNAUTHORIZED', error: 'Please sign in to bet.' });
      return;
    }
    try {
      const result = await game.placeBet(userId, payload?.amount, payload?.betType);
      socket.emit('balance', { balance: result.balance });
      ack?.({ ok: true, bet: result.bet, balance: result.balance });
    } catch (error) {
      ack?.({
        ok: false,
        code: error.code || 'ERROR',
        error: error.message,
      });
    }
  });

  socket.on('cashout', async (_payload, ack) => {
    if (!userId) {
      ack?.({ ok: false, code: 'UNAUTHORIZED', error: 'Please sign in to cash out.' });
      return;
    }
    try {
      const result = await game.cashout(userId);
      socket.emit('balance', { balance: result.balance });
      ack?.({ ok: true, bet: result.bet, balance: result.balance });
    } catch (error) {
      ack?.({
        ok: false,
        code: error.code || 'ERROR',
        error: error.message,
      });
    }
  });

  socket.on('cancel', async (_payload, ack) => {
    if (!userId) {
      ack?.({ ok: false, code: 'UNAUTHORIZED', error: 'Please sign in to cancel a bet.' });
      return;
    }
    try {
      const result = await game.cancelBet(userId);
      socket.emit('balance', { balance: result.balance });
      ack?.({ ok: true, bet: result.bet, balance: result.balance });
    } catch (error) {
      ack?.({
        ok: false,
        code: error.code || 'ERROR',
        error: error.message,
      });
    }
  });

  socket.on('disconnect', () => {
    // Bets stay active on disconnect; they are settled when the round crashes.
  });
});

/* ---------------------------------- start ----------------------------------- */

await game.init();

server.listen(config.port, () => {
  console.log('');
  console.log('  Crash Casino is running');
  console.log(`  URL:  http://localhost:${config.port}`);
  console.log(`  Mode: ${store.mode}${store.mode === 'memory' ? ' (no Supabase, demo user)' : ''}`);
  console.log('');
});
