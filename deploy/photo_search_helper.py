#!/usr/bin/env python3
"""Поисковый помощник RVA — ставится на РАБОЧИЙ ПК (рядом с LM Studio).

Зачем: поисковики (Bing/Google/Yandex) капчат датацентр VPS, а с домашнего/
магазинного IP — домашнего — отвечают нормально. Бот отправляет запрос сюда,
помощник ищет в Bing «с вашего адреса» и возвращает текст выдачи. Бот читает
его маленькой моделью и подтверждает артикул.

Запуск (нужен Python 3.9+ с python.org; галочка «Add to PATH» при установке):
    python photo_search_helper.py            # порт 1235
    set RVA_HELPER_KEY=секрет                # Windows (одинаковый с сервером)
    export RVA_HELPER_KEY=секрет             # Mac/Linux

Маршрутизатор: пробросить внешний порт 1235 → этот компьютер (как для LM
Studio 1234). На сервере в bot/.env тогда вписать:
    PHOTO_SEARCH_PROXY=http://95.31.196.64:1235
    PHOTO_SEARCH_PROXY_KEY=секрет
и перезапустить бота. Пока этих строк нет — сервер в интернет ходит напрямую,
помощник не используется.

Проверка с самого ПК:  http://127.0.0.1:1235/search?q=NGK+4477&key=секрет
"""
import json
import os
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("RVA_HELPER_PORT") or 1235)
KEY = os.environ.get("RVA_HELPER_KEY") or ""
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def fetch_bing_text(query: str) -> str:
    url = "https://www.bing.com/search?q=" + urllib.parse.quote_plus(query) + "&mkt=ru-RU"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    blocks = re.findall(r'<li class="b_algo"[\s\S]*?</li>', html)
    text = " ".join(blocks) if blocks else html
    text = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&[a-z#0-9]+;", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", text)[:20000]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/search":
            return self._code(404, {"error": "только /search?q=…"})
        q = (urllib.parse.parse_qs(u.query).get("q") or [""])[0].strip()
        key = (urllib.parse.parse_qs(u.query).get("key") or [""])[0]
        if KEY and key != KEY:
            return self._code(403, {"error": "неверный ключ"})
        if len(q) < 4:
            return self._code(400, {"error": "пустой запрос"})
        try:
            text = fetch_bing_text(q)
        except Exception as e:
            return self._code(502, {"error": f"поисковик не ответил: {e}"})
        if len(text) < 300:
            return self._code(502, {"error": "выдача пустая (капча?)"})
        self._code(200, {"text": text})

    def _code(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):   # журнал в одну строку
        print("запрос:", self.path[:120], flush=True)


if __name__ == "__main__":
    print(f"Поисковый помощник RVA на порту {PORT}"
          + (", с ключом" if KEY else ", БЕЗ ключа (задайте RVA_HELPER_KEY)"), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
