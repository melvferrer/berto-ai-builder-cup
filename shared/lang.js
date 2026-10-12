// Berto languages. One table shared by app (UI/voice), server (LLM prompt, TTS voice, STT hint).
// Voices verified with `edge-tts --list-voices` (male, to match Berto's existing fil-PH-AngeloNeural).
export const LANGS = {
  fil: { name: 'Filipino (Taglish)', native: 'Filipino (Taglish)', bcp47: 'fil-PH', whisper: 'tl', voice: 'fil-PH-AngeloNeural', english: 'Taglish (Filipino with English medical terms)' },
  en: { name: 'English', native: 'English', bcp47: 'en-PH', whisper: 'en', voice: 'en-PH-JamesNeural', english: 'English' },
  ja: { name: 'Japanese', native: '日本語', bcp47: 'ja-JP', whisper: 'ja', voice: 'ja-JP-KeitaNeural', english: 'Japanese' },
  ko: { name: 'Korean', native: '한국어', bcp47: 'ko-KR', whisper: 'ko', voice: 'ko-KR-InJoonNeural', english: 'Korean' },
  zh: { name: 'Mandarin', native: '中文（简体）', bcp47: 'zh-CN', whisper: 'zh', voice: 'zh-CN-YunxiNeural', english: 'Simplified Chinese (Mandarin)' },
  hi: { name: 'Hindi', native: 'हिन्दी', bcp47: 'hi-IN', whisper: 'hi', voice: 'hi-IN-MadhurNeural', english: 'Hindi (Devanagari script)' },
  id: { name: 'Bahasa Indonesia', native: 'Bahasa Indonesia', bcp47: 'id-ID', whisper: 'id', voice: 'id-ID-ArdiNeural', english: 'Bahasa Indonesia' },
  ms: { name: 'Malay', native: 'Bahasa Melayu', bcp47: 'ms-MY', whisper: 'ms', voice: 'ms-MY-OsmanNeural', english: 'Bahasa Melayu (Malaysian Malay)' },
  th: { name: 'Thai', native: 'ไทย', bcp47: 'th-TH', whisper: 'th', voice: 'th-TH-NiwatNeural', english: 'Thai' },
  vi: { name: 'Vietnamese', native: 'Tiếng Việt', bcp47: 'vi-VN', whisper: 'vi', voice: 'vi-VN-NamMinhNeural', english: 'Vietnamese' },
  bn: { name: 'Bengali', native: 'বাংলা', bcp47: 'bn-IN', whisper: 'bn', voice: 'bn-IN-BashkarNeural', english: 'Bengali (Bangla script)' },
  ta: { name: 'Tamil', native: 'தமிழ்', bcp47: 'ta-IN', whisper: 'ta', voice: 'ta-IN-ValluvarNeural', english: 'Tamil' },
};
export const LANG_CODES = Object.keys(LANGS);
export const normLang = (l) => (LANGS[l] ? l : 'fil');

/**
 * Best-effort language of a typed/spoken message. Script-based detection is reliable (ja/ko/zh/hi/th/bn/ta);
 * Latin-script languages need marker words, so short/ambiguous text returns null (keep the current language).
 */
export function detectLang(text) {
  const s = String(text ?? '');
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(s)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  if (/[\u0900-\u097f]/.test(s)) return 'hi';
  if (/[\u0e00-\u0e7f]/.test(s)) return 'th';
  if (/[\u0980-\u09ff]/.test(s)) return 'bn';
  if (/[\u0b80-\u0bff]/.test(s)) return 'ta';
  const l = s.toLowerCase();
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/.test(l)) return 'vi';
  const count = (re) => (l.match(re) || []).length;
  const fil = count(/\b(ako|ang|ng|ko|mo|ba|po|na|sa|kumusta|kamusta|ano|paano|nahihilo|gamot|asukal|pwede|hindi|oo)\b/g);
  const id = count(/\b(saya|tidak|apa|bagaimana|gula darah|obat|boleh|sudah|belum|dengan|untuk|yang|pusing|aku|bisa)\b/g);
  const ms = count(/\b(saya|tidak|tak|apa|bagaimana|gula dalam darah|ubat|boleh|sudah|dengan|untuk|yang|pening|awak|nak|macam mana)\b/g);
  const msOnly = count(/\b(ubat|tak|nak|awak|pening|macam mana|kenapa|sangat)\b/g);
  const idOnly = count(/\b(obat|tidak|bisa|pusing|banget|gimana|aku|kenapa|sangat)\b/g);
  const en = count(/\b(i|my|is|the|what|how|can|should|am|feel|blood|sugar|have|you|are|hello|thanks|good)\b/g);
  const best = [['fil', fil], ['id', id + idOnly], ['ms', ms + msOnly], ['en', en]].sort((a, b) => b[1] - a[1]);
  if (best[0][1] >= 2 && best[0][1] > best[1][1]) return best[0][0];
  return null;
}
