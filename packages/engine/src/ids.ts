/** SPEC §9 — seeds, game IDs (ULID) and human-friendly replay codes. */

export const REPLAY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomSeed(): number {
  const b = randomBytes(4);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

/** ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] & 31];
  return time + rand;
}

export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

export function generateReplayCode(): string {
  const rnd = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += REPLAY_ALPHABET[rnd[i] & 31];
  return formatReplayCode(s);
}

/** Upper-case and strip everything outside [A-Z0-9]; returns null if not a valid code. */
export function normalizeReplayCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 12) return null;
  for (const ch of s) if (!REPLAY_ALPHABET.includes(ch)) return null;
  return s;
}

export function formatReplayCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}

/** Accepts either a replay code or a game ID and says which one it is. */
export function classifyGameRef(input: string): { kind: 'code'; value: string } | { kind: 'id'; value: string } | null {
  const trimmed = input.trim();
  if (isUlid(trimmed.toUpperCase())) return { kind: 'id', value: trimmed.toUpperCase() };
  const code = normalizeReplayCode(trimmed);
  return code ? { kind: 'code', value: formatReplayCode(code) } : null;
}
