import 'dotenv/config';

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  waitingMs: num(process.env.WAITING_MS, 6000),
  crashedMs: num(process.env.CRASHED_MS, 2500),
  growthRate: num(process.env.GROWTH_RATE, 0.12),
  startingBalance: num(process.env.STARTING_BALANCE, 0),

  tickIntervalMs: 100,
};

export const supabaseEnabled = Boolean(
  config.supabaseUrl && config.supabaseServiceKey
);
