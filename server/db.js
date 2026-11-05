import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { GameError } from './errors.js';

const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

function normalizeRound(row) {
  return {
    id: row.id,
    roundNumber: Number(row.round_number),
    crashPoint: Number(row.crash_point),
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    clientSeed: row.client_seed,
    nonce: Number(row.nonce),
    status: row.status,
    houseEdgePercent:
      row.house_edge === null || row.house_edge === undefined
        ? 1
        : Number(row.house_edge),
    endedAt: row.ended_at,
  };
}

function normalizeBet(row) {
  return {
    id: row.id,
    userId: row.user_id,
    roundId: row.round_id,
    amount: Number(row.amount),
    status: row.status,
    cashoutMultiplier:
      row.cashout_multiplier === null || row.cashout_multiplier === undefined
        ? null
        : Number(row.cashout_multiplier),
    payout: Number(row.payout || 0),
  };
}

function normalizeDiceRoll(row) {
  return {
    id: row.id,
    userId: row.user_id,
    roundId: row.round_id,
    amount: Number(row.amount),
    target: Number(row.target),
    roll: Number(row.roll),
    multiplier: Number(row.multiplier),
    payout: Number(row.payout || 0),
    status: row.status,
    nonce: Number(row.nonce),
    serverSeedHash: row.server_seed_hash,
    createdAt: row.created_at,
  };
}

const ERROR_MESSAGES = {
  INVALID_AMOUNT: 'Invalid bet amount.',
  INSUFFICIENT_BALANCE: 'Insufficient balance.',
  PROFILE_NOT_FOUND: 'Profile not found.',
  BET_NOT_FOUND: 'Bet not found.',
  BET_NOT_ACTIVE: 'This bet is no longer active.',
  INVALID_MULTIPLIER: 'Invalid multiplier.',
  INVALID_TARGET: 'Invalid dice target.',
  INVALID_ROLL: 'Invalid dice roll.',
  BET_EXISTS: 'You already have an active bet this round.',
};

function mapDbError(error) {
  const message = error?.message || 'Database error.';
  if (/duplicate key/i.test(message)) {
    return new GameError('BET_EXISTS', ERROR_MESSAGES.BET_EXISTS);
  }
  for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(code)) return new GameError(code, text);
  }
  return new GameError('DB_ERROR', message);
}

/* -------------------------------------------------------------------------- */
/* Supabase store                                                             */
/* -------------------------------------------------------------------------- */

class SupabaseStore {
  mode = 'supabase';

  constructor(config) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async verifyToken(token) {
    if (!token) return null;
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  async createUser({ email, password, username }) {
    const { data: existing, error: lookupError } = await this.client
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existing) throw new Error('USERNAME_TAKEN');

    // email_confirm: true skips the confirmation email, so registration works
    // even when the project's built-in SMTP is rate-limited.
    const { data, error } = await this.client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username },
    });

    if (error) throw error;
    return data.user;
  }

  async getProfile(userId) {
    const { data, error } = await this.client
      .from('profiles')
      .select('id, username, balance, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    // Safety net in case the auth trigger was not installed.
    const { data: created, error: insertError } = await this.client
      .from('profiles')
      .upsert(
        { id: userId, username: `player_${String(userId).slice(0, 6)}` },
        { onConflict: 'id' }
      )
      .select('id, username, balance, created_at')
      .single();

    if (insertError) throw insertError;
    return created;
  }

  async createRound({ serverSeed, serverSeedHash, clientSeed, nonce, crashPoint, houseEdgePercent }) {
    const row = {
      server_seed: serverSeed,
      server_seed_hash: serverSeedHash,
      client_seed: clientSeed,
      nonce,
      crash_point: crashPoint,
      house_edge: houseEdgePercent,
      status: 'waiting',
    };

    let { data, error } = await this.client
      .from('game_rounds')
      .insert(row)
      .select()
      .single();

    // Allow the app to keep running before supabase/house_edge.sql is applied.
    if (error && /house_edge/i.test(error.message || '')) {
      console.warn('[db] game_rounds.house_edge is missing. Run supabase/house_edge.sql.');
      delete row.house_edge;
      ({ data, error } = await this.client
        .from('game_rounds')
        .insert(row)
        .select()
        .single());
    }

    if (error) throw error;
    return data;
  }

  async getHouseEdgePercent() {
    const { data, error } = await this.client
      .from('house_edge_settings')
      .select('house_edge')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return Number(data.house_edge);
  }

  async setHouseEdgePercent(percent) {
    const { data, error } = await this.client.rpc('set_house_edge', {
      p_house_edge: percent,
    });

    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return Number(row?.house_edge ?? percent);
  }

  async startRound(roundId) {
    const { error } = await this.client
      .from('game_rounds')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', roundId);
    if (error) throw error;
  }

  async settleRound(roundId) {
    const { error } = await this.client.rpc('settle_round', {
      p_round_id: roundId,
    });
    if (error) throw error;
  }

  async getRecentRounds(limit = 20) {
    const { data, error } = await this.client
      .from('game_rounds')
      .select('*')
      .eq('status', 'crashed')
      .order('round_number', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map(normalizeRound);
  }

  async placeBet(userId, roundId, amount) {
    const { data, error } = await this.client.rpc('place_bet', {
      p_user_id: userId,
      p_round_id: roundId,
      p_amount: amount,
    });
    if (error) throw mapDbError(error);

    const bet = Array.isArray(data) ? data[0] : data;
    const profile = await this.getProfile(userId);
    return { bet: normalizeBet(bet), balance: Number(profile.balance) };
  }

  async cashoutBet(betId, multiplier) {
    const { data, error } = await this.client.rpc('cashout_bet', {
      p_bet_id: betId,
      p_multiplier: multiplier,
    });
    if (error) throw mapDbError(error);

    const bet = Array.isArray(data) ? data[0] : data;
    const profile = await this.getProfile(bet.user_id);
    return { bet: normalizeBet(bet), balance: Number(profile.balance) };
  }

  async getUserBets(userId, limit = 50) {
    const selectWithEdge =
      'id, user_id, round_id, amount, cashout_multiplier, status, payout, created_at, game_rounds(round_number, crash_point, server_seed, server_seed_hash, client_seed, nonce, house_edge)';
    const selectWithoutEdge =
      'id, user_id, round_id, amount, cashout_multiplier, status, payout, created_at, game_rounds(round_number, crash_point, server_seed, server_seed_hash, client_seed, nonce)';

    let { data, error } = await this.client
      .from('bets')
      .select(selectWithEdge)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error && /house_edge/i.test(error.message || '')) {
      ({ data, error } = await this.client
        .from('bets')
        .select(selectWithoutEdge)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit));
    }

    if (error) throw error;

    return (data || []).map((row) => ({
      ...normalizeBet(row),
      createdAt: row.created_at,
      roundNumber: row.game_rounds ? Number(row.game_rounds.round_number) : null,
      crashPoint: row.game_rounds ? Number(row.game_rounds.crash_point) : null,
      serverSeed: row.game_rounds ? row.game_rounds.server_seed : null,
      serverSeedHash: row.game_rounds ? row.game_rounds.server_seed_hash : null,
      clientSeed: row.game_rounds ? row.game_rounds.client_seed : null,
      nonce: row.game_rounds && row.game_rounds.nonce != null ? Number(row.game_rounds.nonce) : null,
      houseEdgePercent: row.game_rounds && row.game_rounds.house_edge != null
        ? Number(row.game_rounds.house_edge)
        : null,
    }));
  }

  async placeDiceBet({ userId, roundId, amount, target, nonce, roll, multiplier, serverSeedHash }) {
    const { data, error } = await this.client.rpc('place_dice_bet', {
      p_user_id: userId,
      p_round_id: roundId,
      p_amount: amount,
      p_target: target,
      p_nonce: nonce,
      p_roll: roll,
      p_multiplier: multiplier,
      p_server_seed_hash: serverSeedHash,
    });

    if (error) throw mapDbError(error);

    const row = Array.isArray(data) ? data[0] : data;
    const profile = await this.getProfile(userId);
    return { roll: normalizeDiceRoll(row), balance: Number(profile.balance) };
  }

  async getUserDiceRolls(userId, limit = 50) {
    const { data, error } = await this.client
      .from('dice_rolls')
      .select(
        'id, user_id, round_id, amount, target, roll, multiplier, payout, status, nonce, server_seed_hash, created_at, game_rounds(round_number, server_seed, server_seed_hash, client_seed, status, house_edge)'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return (data || []).map((row) => {
      const round = row.game_rounds || null;
      return {
        ...normalizeDiceRoll(row),
        roundNumber: round ? Number(round.round_number) : null,
        serverSeed: round && round.status === 'crashed' ? round.server_seed : null,
        clientSeed: round ? round.client_seed : null,
        houseEdgePercent:
          round && round.house_edge != null ? Number(round.house_edge) : null,
      };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory store (demo mode, used when Supabase env vars are missing)       */
/* -------------------------------------------------------------------------- */

class MemoryStore {
  mode = 'memory';

  constructor(startingBalance, houseEdgePercent = 1) {
    this.profiles = new Map();
    this.rounds = [];
    this.bets = new Map();
    this.diceRolls = new Map();
    this.roundSeq = 0;
    this.houseEdgePercent = Number(houseEdgePercent) || 0;

    this.demoUser = {
      id: DEMO_USER_ID,
      username: 'demo_player',
      balance: Number(startingBalance),
      created_at: new Date().toISOString(),
    };
    this.profiles.set(this.demoUser.id, this.demoUser);
  }

  async verifyToken() {
    return { id: DEMO_USER_ID };
  }

  async createUser() {
    throw new GameError('NOT_SUPPORTED', 'Registration is not available in demo mode.');
  }

  async getProfile(userId) {
    const profile = this.profiles.get(userId);
    if (!profile) throw new GameError('PROFILE_NOT_FOUND', ERROR_MESSAGES.PROFILE_NOT_FOUND);
    return profile;
  }

  async createRound({ serverSeed, serverSeedHash, clientSeed, nonce, crashPoint, houseEdgePercent }) {
    this.roundSeq += 1;
    const round = {
      id: crypto.randomUUID(),
      round_number: this.roundSeq,
      server_seed: serverSeed,
      server_seed_hash: serverSeedHash,
      client_seed: clientSeed,
      nonce,
      crash_point: crashPoint,
      house_edge: houseEdgePercent,
      status: 'waiting',
      started_at: null,
      ended_at: null,
    };
    this.rounds.push(round);
    return round;
  }

  async getHouseEdgePercent() {
    return this.houseEdgePercent;
  }

  async setHouseEdgePercent(percent) {
    this.houseEdgePercent = Number(percent) || 0;
    return this.houseEdgePercent;
  }

  async startRound(roundId) {
    const round = this.rounds.find((r) => r.id === roundId);
    if (round) {
      round.status = 'running';
      round.started_at = new Date().toISOString();
    }
  }

  async settleRound(roundId) {
    const round = this.rounds.find((r) => r.id === roundId);
    if (round) {
      round.status = 'crashed';
      round.ended_at = new Date().toISOString();
    }
    for (const bet of this.bets.values()) {
      if (bet.round_id === roundId && bet.status === 'active') {
        bet.status = 'lost';
      }
    }
  }

  async getRecentRounds(limit = 20) {
    return this.rounds
      .filter((r) => r.status === 'crashed')
      .slice()
      .reverse()
      .slice(0, limit)
      .map(normalizeRound);
  }

  async placeBet(userId, roundId, amount) {
    const profile = this.profiles.get(userId);
    if (!profile) throw new GameError('PROFILE_NOT_FOUND', ERROR_MESSAGES.PROFILE_NOT_FOUND);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new GameError('INVALID_AMOUNT', ERROR_MESSAGES.INVALID_AMOUNT);
    }
    if (profile.balance < amount) {
      throw new GameError('INSUFFICIENT_BALANCE', ERROR_MESSAGES.INSUFFICIENT_BALANCE);
    }

    const exists = [...this.bets.values()].some(
      (b) => b.user_id === userId && b.round_id === roundId && b.status === 'active'
    );
    if (exists) throw new GameError('BET_EXISTS', ERROR_MESSAGES.BET_EXISTS);

    profile.balance = Math.round((profile.balance - amount) * 100) / 100;

    const bet = {
      id: crypto.randomUUID(),
      user_id: userId,
      round_id: roundId,
      amount,
      cashout_multiplier: null,
      status: 'active',
      payout: 0,
      created_at: new Date().toISOString(),
    };
    this.bets.set(bet.id, bet);

    return { bet: normalizeBet(bet), balance: profile.balance };
  }

  async cashoutBet(betId, multiplier) {
    const bet = this.bets.get(betId);
    if (!bet) throw new GameError('BET_NOT_FOUND', ERROR_MESSAGES.BET_NOT_FOUND);
    if (bet.status !== 'active') {
      throw new GameError('BET_NOT_ACTIVE', ERROR_MESSAGES.BET_NOT_ACTIVE);
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new GameError('INVALID_MULTIPLIER', ERROR_MESSAGES.INVALID_MULTIPLIER);
    }

    const payout = Math.round(bet.amount * multiplier * 100) / 100;
    bet.status = 'won';
    bet.cashout_multiplier = multiplier;
    bet.payout = payout;

    const profile = this.profiles.get(bet.user_id);
    profile.balance = Math.round((profile.balance + payout) * 100) / 100;

    return { bet: normalizeBet(bet), balance: profile.balance };
  }

  async getUserBets(userId, limit = 50) {
    return [...this.bets.values()]
      .filter((bet) => bet.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((bet) => {
        const round = this.rounds.find((item) => item.id === bet.round_id);
        return {
          ...normalizeBet(bet),
          createdAt: bet.created_at,
          roundNumber: round ? Number(round.round_number) : null,
          crashPoint: round ? Number(round.crash_point) : null,
          serverSeed: round ? round.server_seed : null,
          serverSeedHash: round ? round.server_seed_hash : null,
          clientSeed: round ? round.client_seed : null,
          nonce: round && round.nonce != null ? Number(round.nonce) : null,
          houseEdgePercent: round && round.house_edge != null ? Number(round.house_edge) : null,
        };
      });
  }

  async placeDiceBet({ userId, roundId, amount, target, nonce, roll, multiplier, serverSeedHash }) {
    const profile = this.profiles.get(userId);
    if (!profile) throw new GameError('PROFILE_NOT_FOUND', ERROR_MESSAGES.PROFILE_NOT_FOUND);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new GameError('INVALID_AMOUNT', ERROR_MESSAGES.INVALID_AMOUNT);
    }
    if (!Number.isFinite(target) || target <= 0 || target >= 100) {
      throw new GameError('INVALID_TARGET', ERROR_MESSAGES.INVALID_TARGET);
    }
    if (!Number.isFinite(roll) || roll < 0 || roll >= 100) {
      throw new GameError('INVALID_ROLL', ERROR_MESSAGES.INVALID_ROLL);
    }
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new GameError('INVALID_MULTIPLIER', ERROR_MESSAGES.INVALID_MULTIPLIER);
    }
    if (profile.balance < amount) {
      throw new GameError('INSUFFICIENT_BALANCE', ERROR_MESSAGES.INSUFFICIENT_BALANCE);
    }

    const won = roll < target;
    const payout = won ? Math.round(amount * multiplier * 100) / 100 : 0;
    profile.balance = Math.round((profile.balance - amount + payout) * 100) / 100;

    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      round_id: roundId,
      amount,
      target,
      roll,
      multiplier,
      payout,
      status: won ? 'won' : 'lost',
      nonce,
      server_seed_hash: serverSeedHash,
      created_at: new Date().toISOString(),
    };
    this.diceRolls.set(row.id, row);

    return { roll: normalizeDiceRoll(row), balance: profile.balance };
  }

  async getUserDiceRolls(userId, limit = 50) {
    return [...this.diceRolls.values()]
      .filter((roll) => roll.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((roll) => {
        const round = this.rounds.find((item) => item.id === roll.round_id);
        return {
          ...normalizeDiceRoll(roll),
          roundNumber: round ? Number(round.round_number) : null,
          serverSeed:
            round && round.status === 'crashed' ? round.server_seed : null,
          clientSeed: round ? round.client_seed : null,
          houseEdgePercent:
            round && round.house_edge != null ? Number(round.house_edge) : null,
        };
      });
  }
}

export function createStore(config) {
  if (config.supabaseUrl && config.supabaseServiceKey) {
    return new SupabaseStore(config);
  }
  console.warn(
    '[db] Supabase env vars are missing -> running in DEMO mode with an in-memory database.'
  );
  return new MemoryStore(config.startingBalance, config.houseEdgePercent);
}
