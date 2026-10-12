"""Berto local speech-to-text worker (faster-whisper, CPU int8). pm2 'berto-stt' via scripts/stt.sh.

POST /transcribe  body = raw audio bytes (audio/mp4 AAC from iPhone, audio/webm Opus from Chrome, wav, ogg...)
  -> {"text": "...", "language": "tl", "ms": 812, "audio_s": 3.4}
GET  /health      -> {"ok": true, "model": "small"}

Privacy: audio is decoded in memory (piped through ffmpeg stdin -> 16 kHz PCM) and never written to disk or logged.
Bound to 127.0.0.1 only. One request at a time (the model is not shared across threads).
"""
import json, os, subprocess, sys, time, threading
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from faster_whisper import WhisperModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.environ.get("STT_MODEL", "small")
MODEL_DIR = os.environ.get("STT_MODEL_DIR", os.path.join(ROOT, "models", f"faster-whisper-{MODEL}"))
PORT = int(os.environ.get("STT_PORT", "8789"))
THREADS = int(os.environ.get("STT_THREADS", "4"))
LANG = os.environ.get("STT_LANG", "tl") or None  # 'tl' beat auto-detect on Taglish (auto drifts to id/vi)
BEAM = int(os.environ.get("STT_BEAM", "5"))
MAX_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 20
# Biases spelling toward Taglish diabetes vocabulary and digits for readings.
PROMPT = os.environ.get("STT_PROMPT", (
    "Taglish na usapan tungkol sa diabetes. 140 ang blood sugar ko, 95 mg/dL fasting. "
    "Nainom ko na ang metformin at losartan. Ano ang gamot ko ngayon? Insulin, glucose, HbA1c, "
    "Pwede ba akong kumain ng saging? Pagkatapos kumain, kanin, mangga, nahihilo, nanginginig, naglakad ako ng 30 minutes. Berto."
))

model = WhisperModel(MODEL_DIR, device="cpu", compute_type="int8", cpu_threads=THREADS, num_workers=1)
lock = threading.Lock()
print(f"[berto-stt] model={MODEL} lang={LANG or 'auto'} beam={BEAM} threads={THREADS} on 127.0.0.1:{PORT}", flush=True)


def decode(raw: bytes) -> np.ndarray:
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-t", str(MAX_SECONDS),
         "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        input=raw, capture_output=True, timeout=20)
    if p.returncode != 0 or not p.stdout:
        raise ValueError("could not decode audio")
    return np.frombuffer(p.stdout, np.int16).astype(np.float32) / 32768.0


ALLOWED = {"tl", "en", "ja", "ko", "zh", "hi", "id", "ms", "th", "vi", "bn", "ta"}
# Short per-language vocabulary prompts (the Taglish PROMPT would bias other languages toward Tagalog).
PROMPTS = {
    "en": "Diabetes chat. My blood sugar is 140 mg/dL. I took my metformin.",
    "ja": "糖尿病の相談です。血糖値は140です。メトホルミンを飲みました。",
    "ko": "당뇨 상담입니다. 혈당은 140이에요. 메트포르민을 먹었어요.",
    "zh": "糖尿病咨询。我的血糖是140。我吃了二甲双胍。",
    "hi": "डायबिटीज़ के बारे में बातचीत। मेरी शुगर 140 है। मैंने मेटफॉर्मिन ली।",
    "id": "Percakapan tentang diabetes. Gula darah saya 140. Saya sudah minum metformin.",
    "ms": "Perbualan tentang diabetes. Gula dalam darah saya 140. Saya sudah makan ubat metformin.",
    "th": "คุยเรื่องเบาหวาน น้ำตาลในเลือด 140 ผมกินยาเมตฟอร์มินแล้ว",
    "vi": "Trò chuyện về tiểu đường. Đường huyết của tôi là 140. Tôi đã uống metformin.",
    "bn": "ডায়াবেটিস নিয়ে কথা। আমার সুগার 140। আমি মেটফরমিন খেয়েছি।",
    "ta": "நீரிழிவு பற்றிய உரையாடல். என் சர்க்கரை 140. நான் மெட்ஃபார்மின் சாப்பிட்டேன்.",
}


def run(audio: np.ndarray, lang):
    segs, info = model.transcribe(audio, language=lang, initial_prompt=PROMPTS.get(lang, PROMPT), beam_size=BEAM,
                                  vad_filter=False, condition_on_previous_text=False, without_timestamps=True)
    return " ".join(s.text.strip() for s in segs).strip(), info.language


def transcribe(raw: bytes, hint=None):
    audio = decode(raw)
    dur = len(audio) / 16000
    if dur < 0.3 or float(np.abs(audio).max(initial=0)) < 0.003:
        return {"text": "", "language": None, "audio_s": round(dur, 2)}
    with lock:
        forced = hint if hint in ALLOWED else LANG
        text, lang = run(audio, forced)
        if not text and forced:  # rare empty result with a forced language: retry with auto-detect
            text, lang = run(audio, None)
    return {"text": text, "language": lang, "audio_s": round(dur, 2)}


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": MODEL, "lang": LANG or "auto"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        hint = (parse_qs(u.query).get("lang") or [None])[0]
        if u.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, {"error": "bad size"})
        raw = self.rfile.read(n)
        t = time.time()
        try:
            out = transcribe(raw, hint)
        except Exception as e:  # never echo audio; message only
            return self._json(422, {"error": str(e)[:120]})
        finally:
            del raw
        out["ms"] = int((time.time() - t) * 1000)
        print(f"[berto-stt] {out['audio_s']}s audio -> {out['ms']} ms, {len(out['text'])} chars", flush=True)  # no transcript in logs
        self._json(200, out)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
