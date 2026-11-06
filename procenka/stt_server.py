#!/usr/bin/env python3
"""Локальное распознавание речи (STT) — faster-whisper, без внешних сервисов.

Принимает POST /stt с аудио в теле (webm/ogg/m4a/wav — что даёт браузерный
MediaRecorder), возвращает {"text": "…"}. Модель держит в памяти, поэтому
распознавание после первого запроса занимает секунды.

Запуск: ../bot/venv/bin/python stt_server.py   (модель при первом старте
скачивается с HuggingFace — один раз, затем лежит в кэше).
Порт: STT_PORT из procenka/.env, по умолчанию 8767 (слушает только 127.0.0.1).
Размер модели: WHISPER_MODEL (small по умолчанию; tiny/base/small/medium).
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "bot"))

PORT = int(os.environ.get("STT_PORT") or 8767)
MODEL_NAME = os.environ.get("WHISPER_MODEL") or "small"

log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)

log(f"загружаю модель whisper «{MODEL_NAME}»…")
from faster_whisper import WhisperModel
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
log("модель готова")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # тише в логе
        pass

    def do_GET(self):
        if self.path == "/ping":
            return self._json(200, {"ok": True, "model": MODEL_NAME})
        self._json(404, {"error": "только POST /stt"})

    def do_POST(self):
        if self.path != "/stt":
            return self._json(404, {"error": "только POST /stt"})
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return self._json(400, {"error": "Пустое аудио"})
        data = self.rfile.read(length)
        mime = (self.headers.get("Content-Type") or "audio/webm").lower()
        ext = "ogg" if "ogg" in mime else "mp4" if ("mp4" in mime or "m4a" in mime) else \
              "wav" if "wav" in mime else "webm"
        tmp = Path("/tmp") / f"rva_stt_{int(time.time()*1000)}.{ext}"
        try:
            tmp.write_bytes(data)
            t0 = time.time()
            segments, info = model.transcribe(str(tmp), language="ru",
                                              beam_size=1, vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
            log(f"распознано {length} байт за {time.time()-t0:.1f} с: {text[:60]}")
            return self._json(200, {"text": text})
        except Exception as e:
            log(f"ОШИБКА: {type(e).__name__}: {e}")
            return self._json(502, {"error": f"{type(e).__name__}: {e}"})
        finally:
            tmp.unlink(missing_ok=True)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    log(f"STT-сервер: http://127.0.0.1:{PORT}/stt (модель {MODEL_NAME})")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
