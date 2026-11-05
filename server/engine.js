import crypto from 'crypto';
import { GameError } from './errors.js';
import {
  generateServerSeed,
  sha256,
  crashPointFromSeed,
  multiplierAt,
  durationForCrashPoint,
} from './provablyFair.js';

const HISTORY_LIMIT = 20;
const BET_TYPES = new Set(['crash', 'red', 'green', 'moon']);
const DEFAULT_HOUSE_EDGE_PERCENT = 1;

function normalizeHouseEdgePercent(value, fallback = DEFAULT_HOUSE_EDGE_PERCENT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(99.99, Math.max(0, Math.round(parsed * 100) / 100));
}

function trenballOutcome(betType, crashPoint) {
  switch (betType) {
    case 'red':
      return { win: crashPoint < 2, multiplier: 1.96 };
    case 'green':
      return { win: crashPoint >= 2, multiplier: 2 };
    case 'moon':
      return { win: crashPoint >= 10, multiplier: 10 };
    default:
      return { win: false, multiplier: 0 };
  }
}

export class CrashGame {
  constructor({ store, io, config }) {
    this.store = store;
    this.io = io;
    this.config = config;

    this.phase = 'idle'; // idle | waiting | running | crashed
    this.round = null;
    this.multiplier = 1;
    this.startedAt = 0;
    this.startsAt = 0;

    this.roundBets = new Map();
    this.history = [];

    this.houseEdgePercent = normalizeHouseEdgePercent(config.houseEdgePercent);

    this.tickTimer = null;
    this.loopTimer = null;
  }

  async init() {
    this.history = await this.store.getRecentRounds(HISTORY_LIMIT);
    await this.refreshHouseEdge();
    await this.beginWaiting();
  }

  /* ------------------------------- house edge ------------------------------- */

  async refreshHouseEdge() {
    try {
      const stored = await this.store.getHouseEdgePercent();
      if (stored !== null && stored !== undefined && Number.isFinite(Number(stored))) {
        this.houseEdgePercent = normalizeHouseEdgePercent(stored);
      }
    } catch (error) {
      console.error('[engine] failed to load house edge, using last value:', error.message);
    }
    return this.houseEdgePercent;
  }

  getHouseEdgePercent() {
    return this.houseEdgePercent;
  }

  /**
   * Internal seed source shared by Crash and Dice. Never expose serverSeed to
   * clients before the round is revealed.
   */
  getCurrentSeedSource() {
    if (!this.round) return null;
    return {
      roundId: this.round.id,
      roundNumber: this.round.roundNumber,
      serverSeed: this.round.serverSeed,
      serverSeedHash: this.round.serverSeedHash,
      clientSeed: this.round.clientSeed,
      houseEdgePercent:
        this.round.houseEdgePercent ?? this.houseEdgePercent,
      revealed: this.phase === 'crashed',
    };
  }

  async setHouseEdgePercent(percent) {
    const parsed = Number(percent);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100) {
      throw new GameError('INVALID_HOUSE_EDGE', 'House edge must be between 0 and 99.99.');
    }

    const normalized = normalizeHouseEdgePercent(parsed, this.houseEdgePercent);
    const saved = await this.store.setHouseEdgePercent(normalized);

    this.houseEdgePercent = normalizeHouseEdgePercent(saved, normalized);
    this.io.emit('house-edge', { houseEdgePercent: this.houseEdgePercent });

    return this.houseEdgePercent;
  }

  /* ------------------------------ state helpers ----------------------------- */

  publicRound() {
    if (!this.round) return null;
    const revealed = this.phase === 'crashed';
    return {
      id: this.round.id,
      roundNumber: this.round.roundNumber,
      serverSeedHash: this.round.serverSeedHash,
      clientSeed: this.round.clientSeed,
      nonce: this.round.nonce,
      houseEdgePercent: this.round.houseEdgePercent,
      crashPoint: revealed ? this.round.crashPoint : undefined,
      serverSeed: revealed ? this.round.serverSeed : undefined,
    };
  }

  getBetsList() {
    return [...this.roundBets.values()]
      .map((bet) => ({ ...bet }))
      .sort((a, b) => b.amount - a.amount);
  }

  getState() {
    return {
      phase: this.phase,
      multiplier: Number(this.multiplier.toFixed(2)),
      round: this.publicRound(),
      history: this.history,
      bets: this.getBetsList(),
      startsAt: this.phase === 'waiting' ? this.startsAt : null,
      startedAt: this.phase === 'running' ? this.startedAt : null,
      waitingMs: this.config.waitingMs,
      crashedMs: this.config.crashedMs,
      growthRate: this.config.growthRate,
      tickIntervalMs: this.config.tickIntervalMs,
      houseEdgePercent: this.houseEdgePercent,
    };
  }

  /* -------------------------------- lifecycle ------------------------------- */

  async beginWaiting() {
    this.phase = 'waiting';
    this.multiplier = 1;
    this.round = null;
    this.roundBets.clear();

    await this.refreshHouseEdge();

    const serverSeed = generateServerSeed();
    const serverSeedHash = sha256(serverSeed);
    const clientSeed = crypto.randomBytes(8).toString('hex');
    const nonce = Date.now();
    const crashPoint = crashPointFromSeed(
      serverSeed,
      clientSeed,
      nonce,
      this.houseEdgePercent / 100
    );

    let saved;
    try {
      saved = await this.store.createRound({
        serverSeed,
        serverSeedHash,
        clientSeed,
        nonce,
        crashPoint,
        houseEdgePercent: this.houseEdgePercent,
      });
    } catch (error) {
      console.error('[engine] failed to create round:', error);
      this.loopTimer = setTimeout(() => this.beginWaiting(), 2000);
      return;
    }

    this.round = {
      id: saved.id,
      roundNumber: Number(saved.round_number),
      serverSeed,
      serverSeedHash,
      clientSeed,
      nonce,
      crashPoint,
      houseEdgePercent: this.houseEdgePercent,
    };

    this.startsAt = Date.now() + this.config.waitingMs;

    this.io.emit('round:waiting', {
      ...this.publicRound(),
      startsAt: this.startsAt,
      waitingMs: this.config.waitingMs,
    });
    this.io.emit('bets:list', []);

    this.loopTimer = setTimeout(() => this.beginRunning(), this.config.waitingMs);
  }

  async beginRunning() {
    if (this.phase !== 'waiting') return;

    this.phase = 'running';
    this.multiplier = 1;
    this.startedAt = Date.now();

    try {
      await this.store.startRound(this.round.id);
    } catch (error) {
      console.error('[engine] failed to start round:', error);
    }

    this.io.emit('round:running', {
      id: this.round.id,
      roundNumber: this.round.roundNumber,
      startedAt: this.startedAt,
      growthRate: this.config.growthRate,
    });

    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  tick() {
    if (this.phase !== 'running') return;

    const elapsed = Date.now() - this.startedAt;
    const multiplier = multiplierAt(elapsed, this.config.growthRate);

    if (multiplier >= this.round.crashPoint) {
      this.multiplier = this.round.crashPoint;
      this.crash();
      return;
    }

    this.multiplier = multiplier;
    this.io.emit('tick', {
      multiplier: Number(multiplier.toFixed(2)),
      elapsed,
    });
  }

  async crash() {
    if (this.phase !== 'running') return;

    this.phase = 'crashed';
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const round = this.round;

    // Settle Trenball bets before closing the round: winners are credited via
    // the same atomic cashout RPC used for Crash cashouts.
    for (const bet of this.roundBets.values()) {
      if (bet.status !== 'active' || bet.betType === 'crash') continue;

      const outcome = trenballOutcome(bet.betType, round.crashPoint);
      if (!outcome.win) continue;

      try {
        const { bet: settled } = await this.store.cashoutBet(bet.id, outcome.multiplier);
        bet.status = 'won';
        bet.cashoutMultiplier = outcome.multiplier;
        bet.payout = settled.payout;
      } catch (error) {
        console.error('[engine] failed to settle trenball bet:', error);
      }
    }

    try {
      await this.store.settleRound(round.id);
    } catch (error) {
      console.error('[engine] failed to settle round:', error);
    }

    for (const bet of this.roundBets.values()) {
      if (bet.status === 'active') bet.status = 'lost';
    }

    const historyItem = {
      id: round.id,
      roundNumber: round.roundNumber,
      crashPoint: round.crashPoint,
      serverSeed: round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      houseEdgePercent: round.houseEdgePercent,
      endedAt: new Date().toISOString(),
    };

    this.history = [historyItem, ...this.history].slice(0, HISTORY_LIMIT);

    this.io.emit('round:crashed', {
      ...historyItem,
      multiplier: round.crashPoint,
      durationMs: durationForCrashPoint(round.crashPoint, this.config.growthRate),
    });
    this.io.emit('bets:list', this.getBetsList());
    this.io.emit('history', this.history);

    this.loopTimer = setTimeout(() => this.beginWaiting(), this.config.crashedMs);
  }

  /* --------------------------------- actions -------------------------------- */

  async placeBet(userId, rawAmount, rawBetType = 'crash') {
    if (this.phase !== 'waiting' || !this.round) {
      throw new GameError('BETTING_CLOSED', 'Betting is closed for this round.');
    }

    const amount = Math.round(Number(rawAmount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new GameError('INVALID_AMOUNT', 'Invalid bet amount.');
    }

    const betType = BET_TYPES.has(rawBetType) ? rawBetType : 'crash';

    const alreadyBet = [...this.roundBets.values()].some(
      (bet) => bet.userId === userId && bet.status === 'active'
    );
    if (alreadyBet) {
      throw new GameError('BET_EXISTS', 'You already have a bet this round.');
    }

    const profile = await this.store.getProfile(userId);
    const { bet, balance } = await this.store.placeBet(
      userId,
      this.round.id,
      amount
    );

    const entry = {
      id: bet.id,
      userId,
      username: profile.username || 'player',
      amount: bet.amount,
      betType,
      status: 'active',
      cashoutMultiplier: null,
      payout: 0,
    };

    this.roundBets.set(entry.id, entry);
    this.io.emit('bet:placed', entry);
    this.io.emit('bets:list', this.getBetsList());

    return { bet: entry, balance };
  }

  async cashout(userId) {
    if (this.phase !== 'running' || !this.round) {
      throw new GameError('NOT_RUNNING', 'The round is not running.');
    }

    if (this.multiplier >= this.round.crashPoint) {
      throw new GameError('ROUND_CRASHED', 'The round already crashed.');
    }

    const entry = [...this.roundBets.values()].find(
      (bet) => bet.userId === userId && bet.status === 'active'
    );
    if (!entry) {
      throw new GameError('NO_ACTIVE_BET', 'You have no active bet to cash out.');
    }

    if (entry.betType !== 'crash') {
      throw new GameError('NOT_CASHABLE', 'Only Crash bets can be cashed out.');
    }

    // Server-side multiplier is authoritative (client cannot send a value).
    const multiplier = Math.max(1, Math.floor(this.multiplier * 100) / 100);
    const { bet, balance } = await this.store.cashoutBet(entry.id, multiplier);

    entry.status = 'won';
    entry.cashoutMultiplier = multiplier;
    entry.payout = bet.payout;

    this.io.emit('bet:cashout', { ...entry });
    this.io.emit('bets:list', this.getBetsList());

    return { bet: entry, balance };
  }

  async cancelBet(userId) {
    if (this.phase !== 'waiting' || !this.round) {
      throw new GameError('BETTING_CLOSED', 'Betting is closed for this round.');
    }

    const entry = [...this.roundBets.values()].find(
      (bet) => bet.userId === userId && bet.status === 'active'
    );
    if (!entry) {
      throw new GameError('NO_ACTIVE_BET', 'You have no active bet to cancel.');
    }

    // Refund the stake by settling the bet at 1.00x, then drop it from the
    // current round so it no longer appears in the live bets list.
    const { bet, balance } = await this.store.cashoutBet(entry.id, 1);

    entry.status = 'cancelled';
    entry.cashoutMultiplier = null;
    entry.payout = bet.payout;

    this.roundBets.delete(entry.id);

    this.io.emit('bet:cancelled', { ...entry });
    this.io.emit('bets:list', this.getBetsList());

    return { bet: entry, balance };
  }
}
