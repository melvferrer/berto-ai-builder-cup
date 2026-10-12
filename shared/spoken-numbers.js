// Turn spoken numbers in a speech transcript into digits so Berto's rules can read them:
//   "isang daan at apatnapu ang sugar ko" -> "140 ang sugar ko"
//   "one forty ang sugar ko" / "one hundred forty" -> "140 ..."
//   "isang daan at 80" (Whisper mixes words and digits) -> "180"
// Only sequences worth >= 10 or containing a tens/hundreds word are converted, so "isang tableta"
// stays as is. Also maps "milligrams per deciliter" -> "mg/dL". Pure function, used by the server.

const U_TL = { isa: 1, isang: 1, dalawa: 2, dalawang: 2, tatlo: 3, tatlong: 3, apat: 4, lima: 5, limang: 5,
  anim: 6, pito: 7, pitong: 7, walo: 8, walong: 8, siyam: 9 };
const U_EN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEEN_EN = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_EN = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const TL_STEM = { dalawa: 2, tatlu: 3, tatlo: 3, apatna: 4, apat: 4, lima: 5, animna: 6, anim: 6, pitu: 7, pito: 7,
  walu: 8, walo: 8, siyamna: 9, siyam: 9 };
const HUND_STEM = { isang: 1, san: 1, sang: 1, dalawang: 2, tatlong: 3, apatna: 4, apatnar: 4, limang: 5, animna: 6,
  pitong: 7, walong: 8, siyamna: 9 };
const LINK = new Set(['at', "'t", 't', 'na', 'ng', 'and', '-']);

/** Classify one lowercase token -> { kind: 'H'|'T'|'U'|'TEEN'|'D'|'HUNDRED', v } or null. */
function piece(tok) {
  if (/^\d{1,3}$/.test(tok)) return { kind: 'D', v: Number(tok) };
  if (tok === 'hundred') return { kind: 'HUNDRED', v: 100 };
  if (tok in U_EN) return { kind: 'U', v: U_EN[tok], en: true };
  if (tok in TEEN_EN) return { kind: 'TEEN', v: TEEN_EN[tok] };
  if (tok in TENS_EN) return { kind: 'T', v: TENS_EN[tok], en: true };
  if (tok in U_TL) return { kind: 'U', v: U_TL[tok] };
  let m = tok.match(/^(isang|san|sang|dalawang|tatlong|apatna|limang|animna|pitong|walong|siyamna)(?:daan|raan)$/);
  if (m) return { kind: 'H', v: HUND_STEM[m[1]] * 100 };
  if (/^sampu(?:ng|'?t)?$|^sampo$/.test(tok)) return { kind: 'T', v: 10 };
  m = tok.match(/^labin(?:g)?(isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam)$/);
  if (m) return { kind: 'TEEN', v: 10 + U_TL[m[1]] };
  m = tok.match(/^(dalawa|tatlu|tatlo|apatna|lima|animna|pitu|pito|walu|walo|siyamna)m?pu(?:ng|'?t|wang|ang)?$/);
  if (m) return { kind: 'T', v: TL_STEM[m[1]] * 10 };
  return null;
}

/** Join split spellings Whisper produces ("apat na pu", "isang daan", "labing apat") into single tokens. */
function joinSplits(s) {
  const H = ['', 'isang', 'dalawang', 'tatlong', 'apatna', 'limang', 'animna', 'pitong', 'walong', 'siyamna'];
  return s
    .replace(/\b([1-9])\s*(daan|raan)\b/gi, (_m, d) => `${H[d]}daan`)
    .replace(/\bat(apat|anim|siyam)(?=\s*na\s*pu)/gi, 'at $1')
    .replace(/\b(daan|raan) at (apat|anim|siyam) na po\b/gi, '$1 at $2napu')
    .replace(/\b([2-9])\s*(?:na|m)?\s*pu(?:wang|ang)\b/gi, '$10 ang')
    .replace(/\b([2-9])\s*(?:na|m)?\s*pu(?:ng|'?t)?\b/gi, '$10')
    .replace(/\b(apat|anim|siyam)\s*na\s*(pu|raan|daan)/gi, '$1na$2')
    .replace(/\b(dalawa|tatlu|tatlo|lima|pitu|pito|walu|walo)(m?)\s+pu/gi, '$1$2pu')
    .replace(/\b(isang|dalawang|tatlong|limang|pitong|walong|sang)\s+(daan|raan)\b/gi, '$1$2')
    .replace(/\blabing?[\s-]*(isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam)(?:ng)?\b/gi, 'labin$1')
    .replace(/\bmilli?grams?\s+(per|kada)\s+deci?lit(er|re)s?\b/gi, 'mg/dL');
}

function value(ps) {
  // English "one forty" (1 then a tens word, no 'hundred') -> 140; "two ten" is not handled.
  if (ps.length >= 2 && ps[0].kind === 'U' && ps[0].v <= 5 && (ps[1].kind === 'T' || ps[1].kind === 'TEEN') && ps[0].en && ps[1].kind !== 'HUNDRED')
    return ps[0].v * 100 + ps.slice(1).reduce((a, p) => a + p.v, 0);
  let total = 0, cur = 0;
  for (const p of ps) {
    if (p.kind === 'HUNDRED') { cur = (cur || 1) * 100; total += cur; cur = 0; }
    else if (p.kind === 'H') { total += cur + p.v; cur = 0; }
    else cur += p.v;
  }
  return total + cur;
}

export function spokenNumbersToDigits(text) {
  if (!text) return text;
  const src = joinSplits(String(text));
  const toks = src.split(/(\s+)/); // keep whitespace
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const raw = toks[i];
    const core = raw.toLowerCase().replace(/^[^\p{L}\d']+|[^\p{L}\d']+$/gu, '');
    const p = /\S/.test(raw) ? piece(core) : null;
    if (!p) { out.push(raw); i++; continue; }
    // greedily collect pieces (allowing linkers between them)
    const ps = [p]; let j = i + 1, end = i; let trail = raw.slice(raw.toLowerCase().lastIndexOf(core) + core.length);
    while (j < toks.length) {
      if (!/\S/.test(toks[j])) { j++; continue; }
      const c = toks[j].toLowerCase().replace(/^[^\p{L}\d']+|[^\p{L}\d']+$/gu, '');
      if (LINK.has(c)) {
        // linker must be followed by another number piece
        let k = j + 1; while (k < toks.length && !/\S/.test(toks[k])) k++;
        const nc = k < toks.length ? toks[k].toLowerCase().replace(/^[^\p{L}\d']+|[^\p{L}\d']+$/gu, '') : '';
        const np = piece(nc);
        if (np && np.kind !== 'H') { j = k; continue; }
        break;
      }
      const q = piece(c);
      if (!q) break;
      const last = ps[ps.length - 1];
      // a bare digit only continues a word number (e.g. "isang daan at 80"), never another digit
      if (q.kind === 'D' && (last.kind === 'D' || !['H', 'HUNDRED'].includes(last.kind))) break;
      if (last.kind === 'D') break;
      ps.push(q); end = j; trail = toks[j].slice(toks[j].toLowerCase().lastIndexOf(c) + c.length); j++;
    }
    const meaningful = ps.some((x) => ['H', 'T', 'TEEN', 'HUNDRED'].includes(x.kind)) && !(ps.length === 1 && ps[0].kind === 'D');
    if (!meaningful) { out.push(raw); i++; continue; }
    const lead = raw.slice(0, raw.toLowerCase().indexOf(core));
    const ate = /pu(?:w?ang)$/.test((toks[end] || '').toLowerCase().replace(/[^\p{L}']+$/gu, '')) ? ' ang' : '';
    out.push(`${lead}${value(ps)}${ate}${trail}`);
    i = end + 1;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
