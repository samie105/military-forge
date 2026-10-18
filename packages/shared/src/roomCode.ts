/**
 * Custom room codes (docs/07 §5.1): 6 characters from the 23-letter unambiguous alphabet (no 0/O,
 * 1/I/L), 23⁶ ≈ 148 M codes. Shared by the API (mints them), the game server (rooms by code) and
 * the web client (links, the join box).
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

const VALID = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function isRoomCode(code: string): boolean {
  return VALID.test(code);
}

/**
 * What a player typed or pasted → a code, or null: case-insensitive, ignores spaces and dashes
 * ("kq7-mzp" style groupings) and accepts a pasted share link (…/r/CODE or ?room=CODE).
 */
export function normalizeRoomCode(input: string): string | null {
  const text = input.trim();
  const fromLink = /(?:\/r\/|[?&]room=)([A-Za-z\s-]{6,12})/.exec(text);
  const code = (fromLink ? fromLink[1]! : text).replace(/[\s-]/g, '').toUpperCase();
  return isRoomCode(code) ? code : null;
}

/**
 * A random code from uniformly random bytes (crypto.getRandomValues / randomBytes; pure packages
 * can't reach either, so the caller passes them in). Bytes ≥ 253 are skipped so every letter is
 * equally likely (253 = 11 × 23); 12 bytes all but never run out (a skip is a 1-in-85 event).
 */
export function roomCodeFromBytes(bytes: Uint8Array): string {
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let code = '';
  for (const b of bytes) {
    if (b >= limit) continue;
    code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
    if (code.length === ROOM_CODE_LENGTH) return code;
  }
  throw new Error('roomCodeFromBytes: not enough random bytes');
}
