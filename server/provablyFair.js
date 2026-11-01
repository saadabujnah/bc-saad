import crypto from 'crypto';

/**
 * Provably fair crash point, compatible with the bustabit / BC.Game style:
 *
 *   hash = HMAC_SHA256(key = serverSeed, message = `${clientSeed}:${nonce}`)
 *   r    = first 52 bits of hash (13 hex chars)
 *   X    = r / 2^52              -> uniform in [0, 1)
 *   X    = 99 / (1 - X)
 *   bust = max(1, floor(X) / 100)
 *
 * The 99 constant gives the house a 1% edge:
 *   P(crash >= m) = 0.99 / m
 */

export function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256(serverSeed, message) {
  return crypto
    .createHmac('sha256', String(serverSeed))
    .update(String(message))
    .digest('hex');
}

export function crashPointFromSeed(serverSeed, clientSeed, nonce) {
  const hash = hmacSha256(serverSeed, `${clientSeed}:${nonce}`);
  const nBits = 52;

  const seed = hash.slice(0, nBits / 4);
  const r = parseInt(seed, 16);

  let X = r / Math.pow(2, nBits);
  X = 99 / (1 - X);

  const result = Math.floor(X);
  return Math.max(1, result / 100);
}

/** Exponential multiplier growth used by the live ticker. */
export function multiplierAt(elapsedMs, growthRate) {
  return Math.max(1, Math.exp(growthRate * (elapsedMs / 1000)));
}

/** How long (in ms) a round takes to reach its crash point. */
export function durationForCrashPoint(crashPoint, growthRate) {
  if (crashPoint <= 1) return 0;
  return (Math.log(crashPoint) / growthRate) * 1000;
}
