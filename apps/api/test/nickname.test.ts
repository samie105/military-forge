import { describe, expect, it } from 'vitest';
import { cleanNickname, filterForm, skeleton, tokens } from '../src/nickname/normalize';
import { GUEST_NAME_PARTS, NicknamePolicy, nicknameVariants, randomGuestNickname, type NicknameReason } from '../src/nickname/rules';

const policy = new NicknamePolicy(['Richie']);
const reason = (name: string): NicknameReason | 'ok' => {
  const r = policy.check(name);
  return r.ok ? 'ok' : r.reason;
};

describe('normal forms', () => {
  it('display form: NFKC, collapsed whitespace, trimmed', () => {
    expect(cleanNickname('  Ｋｅｍｉ   the\tGreat ')).toBe('Kemi the Great');
    expect(cleanNickname('ﬁre')).toBe('fire');
  });

  it('skeleton folds case, accents, lookalikes, 0/o, 1/l/I and separators', () => {
    const same = ['Kemi_99', 'kemi99', 'KEMI.99', 'K e m i 9 9', 'Kémi99', 'Kеmi99' /* Cyrillic е */];
    expect(new Set(same.map(skeleton)).size).toBe(1);
    expect(skeleton('Bill')).toBe(skeleton('BiII'));
    expect(skeleton('B1ll')).toBe(skeleton('bill'));
    expect(skeleton('C00L')).toBe(skeleton('cool'));
    expect(skeleton('modern')).toBe(skeleton('modem'));
    expect(skeleton('Ade')).not.toBe(skeleton('Ada'));
  });

  it('keeps vowel signs of Indic scripts (they are letters, not accents)', () => {
    expect(skeleton('राम')).not.toBe(skeleton('रम'));
  });

  it('filter form folds leetspeak', () => {
    expect(filterForm('5n1p3r_K1ng')).toBe('sniperking');
    expect(filterForm('$h!t')).toBe('$h!t'); // symbols are rejected earlier, never folded
  });

  it('splits words at separators and camelCase', () => {
    expect(tokens('SuperMod_Guy 99')).toEqual(['Super', 'Mod', 'Guy', '99']);
    expect(tokens('xXAssXx')).toEqual(['x', 'X', 'Ass', 'Xx']);
  });
});

describe('NicknamePolicy', () => {
  it.each([
    'Ade', 'Kemi_99', 'xX_Sniper_Xx', 'Chukwuemeka', 'Zoë', 'José-Luis', 'Ølaf', 'Raj राज', 'राजकुमार', 'அருண்', 'محمد',
    '山田太郎', 'やまだ', '김민수', 'Иван', 'Νίκος', 'Ali', 'Mr.Ade', 'Big Ade',
  ])('accepts %s', (name) => {
    expect(reason(name)).toBe('ok');
  });

  it('returns the display form and its skeleton', () => {
    expect(policy.check('  Kemi   99 ')).toEqual({ ok: true, nickname: 'Kemi 99', norm: skeleton('Kemi 99') });
  });

  it('length is counted in characters people see (graphemes), with a byte cap', () => {
    expect(reason('Ab')).toBe('too_short');
    expect(reason('  Ab   ')).toBe('too_short');
    expect(reason('Abc')).toBe('ok');
    expect(reason('A'.repeat(16))).toBe('ok');
    expect(reason('A'.repeat(17))).toBe('too_long');
    expect(reason('नमस्ते')).toBe('ok'); // 6 code points, 3 graphemes
    expect(reason('क्षि'.repeat(5))).toBe('too_long'); // ≤ 10 graphemes but 60 bytes
  });

  it.each([
    ['Kemi😀', 'emoji'],
    ['Ad​min', 'zero-width space'],
    ['Ade‮evil', 'bidi override'],
    ['Ade\u0007', 'control character'],
    ['Ade!', 'punctuation'],
    ['Kemi__99', 'double separator'],
    ['Z̴̡̛a̷lgo', 'stacked marks'],
    ['́Ade', 'leading combining mark'],
  ])('rejects %s (%s) as invalid_characters', (name) => {
    expect(reason(name)).toBe('invalid_characters');
  });

  it('needs at least one letter', () => {
    expect(reason('12345')).toBe('no_letters');
    expect(reason('_-_')).toBe('invalid_characters');
  });

  it('rejects lookalike script mixing, allows Latin with one non-lookalike script', () => {
    expect(reason('Аdmin')).toBe('mixed_scripts'); // Cyrillic А + Latin
    expect(reason('Pαul')).toBe('mixed_scripts'); // Greek α + Latin
    expect(reason('Иван Ivan')).toBe('mixed_scripts');
    expect(reason('राज محمد')).toBe('mixed_scripts');
    expect(reason('Raj राज')).toBe('ok');
    expect(reason('山田やまだ')).toBe('ok');
  });

  it.each([
    // small capitals, IPA and Latin Extended-D letters that fancy-text generators use
    ['ᴀᴅᴍɪɴ', 'invalid_characters'],
    ['ɑdmin', 'invalid_characters'],
    ['ꜰuck', 'invalid_characters'],
    ['ʙɪᴛᴄʜ', 'invalid_characters'],
    ['ᴍᴏᴅᴇʀᴀᴛᴏʀ', 'invalid_characters'],
    ['ɴɪɢɢᴇʀ', 'invalid_characters'],
    ['niɡɡer', 'invalid_characters'],
    ['ꜱupport', 'invalid_characters'],
    ['fʊck', 'invalid_characters'],
    ['Kemɪ_99', 'invalid_characters'],
    ['ɡamer', 'invalid_characters'],
    // enclosing marks
    ['fu\u20DDck', 'invalid_characters'],
    ['ad\u20DDmin', 'invalid_characters'],
    // Latin mixed with Armenian lookalikes
    ['fսck', 'mixed_scripts'],
    ['SwiftFalcօn482', 'mixed_scripts'],
  ] as const)('closes the lookalike bypass %s → %s', (name, why) => {
    expect(reason(name)).toBe(why);
  });

  it('any mark on a Latin letter is folded away before filtering (spacing marks too)', () => {
    expect(filterForm('fu\u0903ck')).toBe('fuck');
    expect(reason('fu\u0903ck')).toBe('profanity');
  });

  it('keeps real-language Latin letters, folded for uniqueness', () => {
    for (const name of ['Ɓello', 'Ɗanjuma', 'Ƙasim', 'Ƴusuf', 'Ɛsi', 'Kɔfi', 'Ŋozi', 'Þórr', 'Ðani', 'Ọlá', 'Ṣẹgun', 'Nguyễn', 'Łukasz', 'Søren']) {
      expect(reason(name), name).toBe('ok');
    }
    expect(skeleton('Kɔfi')).toBe(skeleton('Kofi'));
    expect(skeleton('Ɓello')).toBe(skeleton('Bello'));
    expect(reason('Ասատուր')).toBe('ok'); // Armenian on its own is fine
  });

  it.each(['FuckYou', 'f.u.c.k', 'Fuuuuck', 'Sh1tHead', 'B1tch_99', 'xXAssXx', 'Big Ass', 'A55', 'Ass99', 'N1gg4', 'chutiya', 'Madarch0d', 'Ashawo', 'PornStar', 'Fück'])(
    'blocks profanity: %s',
    (name) => {
      expect(reason(name)).toBe('profanity');
    },
  );

  it.each(['Nigeria', 'Niger', 'Assassin', 'Classic', 'Kshitij', 'Scunthorpe', 'Therapist', 'Dickens', 'Pornchai', 'Titi', 'Shiitake', 'Bass', 'Cumberland', 'Sussex', 'Hancock'])(
    'does not block innocent names: %s',
    (name) => {
      expect(reason(name)).toBe('ok');
    },
  );

  it.each(['Admin', 'AdminJoe', 'Joe_Admin', 'xX_Mod_Xx', 'SuperModGuy', 'Moderator1', 'Official Ade', 'Military Forge', 'M1litaryF0rge', 'TheGameMaster', 'Support', 'Richie', 'RichieFan', 'R1chie'])(
    'blocks impersonation: %s',
    (name) => {
      expect(reason(name)).toBe('reserved');
    },
  );

  it.each(['Badminton', 'Modric', 'Dev', 'DevKumar', 'Admiral', 'Richmond'])('does not block %s', (name) => {
    expect(reason(name)).toBe('ok');
  });
});

describe('generated names', () => {
  it('every adjective + noun combination is valid, unique-looking and fits with 3 digits', () => {
    for (const a of GUEST_NAME_PARTS.adjectives) {
      for (const n of GUEST_NAME_PARTS.nouns) expect(reason(`${a}${n}999`), `${a}${n}999`).toBe('ok');
    }
    for (let i = 0; i < 50; i++) expect(randomGuestNickname()).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+[1-9][0-9]{2}$/);
  });

  it('variants keep the name, swap trailing digits and stay ≤ 16 characters', () => {
    expect(nicknameVariants('Kemi_99', 6).every((v) => /^Kemi_\d{2,3}$/.test(v))).toBe(true);
    for (const v of nicknameVariants('SixteenCharsLong', 6)) {
      expect(v.length).toBeLessThanOrEqual(16);
      expect(v.startsWith('SixteenChars')).toBe(true);
    }
  });
});
