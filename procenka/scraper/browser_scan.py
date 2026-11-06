#!/usr/bin/env python3
"""Проценка по сайту поставщика без API: браузер (Selenium + Chrome) → снимок и текст страницы → ИИ.

Для поставщиков, которые не дают API-ключ. Сервер проценки (server.js, адаптер «browser»)
запускает этот скрипт на каждый новый артикул (результат кэшируется на 10 минут).

  scan   — JSON на stdin: {"url": "...", "code": "...", "profile": "папка профиля", "wait": 4}
           → JSON на stdout: {"ok": true, "offers": [...], "page": "results"} или {"ok": false, "error": ...}
  login  — открыть обычное окно Chrome с профилем поставщика, чтобы один раз войти в его кабинет:
           venv/bin/python procenka/scraper/browser_scan.py login --profile ПАПКА --url https://сайт/
           Вход сохраняется в профиле; окно закройте, когда войдёте.

Браузер — настоящий Chrome с отдельным профилем на каждого поставщика: страницы открываются
так же, как у человека, с вашим входом в кабинет. Запросы редкие (один артикул — одно открытие
страницы, кэш 10 минут), обходить капчи и защиту сайтов скрипт не пытается: увидев проверку
«вы не робот», он возвращает page = "captcha", и сервер приостанавливает этого поставщика.

ИИ: OpenAI-совместимый chat/completions с картинкой. По умолчанию — DeepSeek (procenka/.env →
DEEPSEEK_API_KEY; в API модель зовётся deepseek-flash — это DeepSeek-V4.1-Flash, Marketing-имя
длиннее), затем тот же ключ распознавания, что у бота (bot/.env → VISION_API_KEY, GLM-4.6V на
api.vision-ai.example). Другой сервис — в procenka/.env: SCRAPER_AI_URL, SCRAPER_AI_KEY, SCRAPER_AI_MODEL.
Ошибка одного — пробуется следующий. Окно браузера видно — SCRAPER_HEADLESS=0.
"""
import argparse
import base64
import io
import json
import re
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent          # procenka/
BOT_ENV = ROOT.parent / "bot" / ".env"
MAX_TEXT = 15000      # символов текста страницы для ИИ
MAX_SHOT_H = 5000     # высота снимка (длинные страницы обрезаются)
CAPTCHA_WORDS = ("вы человек", "не робот", "captcha", "капча", "проверка браузера", "qrator",
                 "подтвердите, что вы", "access denied", "checking your browser")

PROMPT = """Ты помогаешь закупщику магазина автозапчастей. Перед тобой страница результатов поиска
на сайте поставщика по артикулу «{code}»: снимок экрана и текст страницы.

Верни ТОЛЬКО JSON без пояснений и markdown:
{{
  "page": "results | login | captcha | empty | error",
  "note": "коротко, что на странице, если это не результаты, иначе null",
  "offers": [
    {{"brand": "бренд", "code": "артикул как на сайте", "name": "наименование",
      "price": 1234.5, "amount": 3, "term_days": 2, "warehouse": "склад или пусто",
      "is_requested": true}}
  ]
}}

ПРАВИЛА:
1. Только то, что есть на странице. Ничего не придумывай; не уверен в цене — строку не включай.
2. price — цена за 1 шт в рублях числом (без пробелов и «₽»). Несколько цен у строки — бери цену покупки.
3. amount — количество числом: «>10», «10+», «много» → 10; «под заказ» / нет данных → 0.
4. term_days — срок поставки в днях числом: «сегодня», «в наличии» → 0; «2-3 дня» → 3; часы → дни
   (округляя вверх); дата поставки → дней от сегодняшней даты {today}; нет данных → null.
5. is_requested — true, если артикул строки совпадает с «{code}» без учёта пробелов, точек и дефисов;
   иначе это аналог (false).
6. Страница входа в кабинет → page "login"; проверка «вы не робот» → "captcha";
   «ничего не найдено» → "empty" и пустой offers.
7. Включи строки с ценами со страницы: искомый артикул и аналоги / замены / кроссы
   из отдельных таблиц и блоков (у них is_requested = false).
8. Не больше 30 строк: сначала искомый артикул, затем аналоги — самые дешёвые и в наличии;
   дальние склады и повторяющиеся строки выбрасывай. Ответ всегда укладывай в лимит."""
# Режим «ask: name» — подтверждение артикула по наименованию: поисковая выдача
# (без цен), из неё выписываем пары бренд + артикул для проверки по базам.
PROMPT_NAME = """Перед тобой поисковая выдача интернета по запросу «{code}»: снимок экрана и текст страницы.
Задача — найти артикулы (каталожные номера) автозапчастей, упомянутые в результатах.

Верни ТОЛЬКО JSON без пояснений и markdown:
{{
  "page": "results | captcha | empty | error",
  "note": "коротко, что на странице, если это не выдача, иначе null",
  "offers": [
    {{"brand": "бренд", "code": "артикул", "name": "наименование как на странице",
      "price": null, "amount": 0, "term_days": null, "warehouse": "", "is_requested": true}}
  ]
}}

ПРАВИЛА:
1. Только то, что реально написано на странице. Ничего не придумывай.
2. Выписывай только строки, где различимы И бренд, И артикул.
3. price/amount/term_days оставляй null/0 — в выдаче их нет."""



def env_file(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                out[m.group(1)] = m.group(2).strip("\"'")
    except FileNotFoundError:
        pass
    return out


def ai_settings() -> dict:
    """Провайдеры ИИ по порядку: DeepSeek (DEEPSEEK_API_KEY в procenka/.env), свой сервис
    (SCRAPER_AI_*, если задан) и vision-ai.example бота (VISION_API_KEY, GLM-4.6V). Ошибка у одного
    (нет денег на балансе, ключ отклонён, модель не принимает картинку) — берётся следующий.
    ProxyAPI/OpenAI сами не подключаются (решение 21.10: их не используем) — только если явно
    указать их в SCRAPER_AI_URL / SCRAPER_AI_KEY."""
    pe, be = env_file(ROOT / ".env"), env_file(BOT_ENV)
    providers = []
    if pe.get("DEEPSEEK_API_KEY"):
        providers.append({"name": "DeepSeek", "url": pe.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",
                          "key": pe["DEEPSEEK_API_KEY"],
                          "model": pe.get("DEEPSEEK_MODEL") or "deepseek-flash"})
    if pe.get("SCRAPER_AI_KEY"):
        providers.append({"name": "SCRAPER_AI", "url": pe.get("SCRAPER_AI_URL") or "https://api.openai.com/v1",
                          "key": pe["SCRAPER_AI_KEY"], "model": pe.get("SCRAPER_AI_MODEL") or "gpt-4o-mini"})
    if be.get("VISION_API_KEY"):
        providers.append({"name": "vision-ai.example", "url": be.get("VISION_BASEURL") or "https://vision-ai.example/api/paas/v4",
                          "key": be["VISION_API_KEY"], "model": be.get("VISION_MODEL") or "glm-4.6v"})
    for p in providers:
        p["url"] = p["url"].rstrip("/")
    return {"providers": providers, "headless": (pe.get("SCRAPER_HEADLESS") or "1") != "0"}


def make_driver(profile: str, headless: bool, width: int = 1400, height: int = 1000):
    from selenium import webdriver
    opts = webdriver.ChromeOptions()
    opts.add_argument(f"--user-data-dir={profile}")
    opts.add_argument(f"--window-size={width},{height}")
    opts.add_argument("--lang=ru-RU")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    if headless:
        opts.add_argument("--headless=new")
    return webdriver.Chrome(options=opts)


def open_and_capture(url: str, profile: str, wait: float, headless: bool, click: str = "") -> tuple[bytes, str, str]:
    """Открыть страницу, дождаться подгрузки, прокрутить; → (JPEG-снимок, текст, заголовок).
    click — текст ссылки, которую нажать после загрузки (например, «Цены и аналоги»)."""
    from PIL import Image
    driver = make_driver(profile, headless)
    try:
        driver.set_page_load_timeout(45)
        driver.get(url)
        t0 = time.time()
        while time.time() - t0 < 15 and driver.execute_script("return document.readyState") != "complete":
            time.sleep(0.3)
        time.sleep(wait)                                   # цены часто догружаются скриптами
        if click:
            try:
                for el in driver.find_elements("tag name", "a"):
                    try:
                        if click.lower() in (el.text or "").lower() and el.is_displayed():
                            driver.execute_script("arguments[0].click();", el)
                            time.sleep(wait)               # цены догружаются скриптом
                            break
                    except Exception:
                        continue
            except Exception:
                pass
        h = int(driver.execute_script("return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)") or 1000)
        for y in range(0, min(h, MAX_SHOT_H), 800):         # прокрутка: подгрузить «ленивые» блоки
            driver.execute_script(f"window.scrollTo(0, {y})")
            time.sleep(0.25)
        driver.execute_script("window.scrollTo(0, 0)")
        h = int(driver.execute_script("return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)") or 1000)
        driver.set_window_size(1400, max(1000, min(h, MAX_SHOT_H)))
        time.sleep(0.5)
        png = driver.get_screenshot_as_png()
        text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
        title = driver.title or ""
    finally:
        driver.quit()
    img = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    text = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()
    return buf.getvalue(), text[:MAX_TEXT], title


def ask_ai(jpeg: bytes, text: str, code: str, cfg: dict, prompt: str = PROMPT) -> dict:
    if not cfg["providers"]:
        raise RuntimeError("не задан ключ ИИ (procenka/.env → DEEPSEEK_API_KEY или bot/.env → VISION_API_KEY)")
    errors = []
    for p in cfg["providers"]:
        try:
            d = ask_provider(p, jpeg, text, code, prompt)
            d["_ai"] = p["name"] + " · " + p["model"]
            return d
        except Exception as e:
            errors.append(f"{p['name']}: {e}")
    raise RuntimeError("; ".join(errors)[:400])


def ask_provider(p: dict, jpeg: bytes, text: str, code: str, prompt: str = PROMPT) -> dict:
    today = time.strftime("%Y-%m-%d")
    def call(with_image: bool) -> str:
        content = []
        if with_image:
            content.append({"type": "image_url",
                            "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}})
        content.append({"type": "text", "text": prompt.format(code=code, today=today) + "\n\nТЕКСТ СТРАНИЦЫ:\n" + text})
        body = {"model": p["model"], "temperature": 0.1, "max_tokens": 8000,
                "messages": [{"role": "user", "content": content}]}
        if "deepseek" in p["model"].lower():
            body["thinking"] = {"type": "disabled"}   # думающая модель тратит токены на рассуждения и молчит
        r = httpx.post(p["url"] + "/chat/completions", json=body, timeout=300,
                       headers={"Authorization": "Bearer " + p["key"]})
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
        return ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    # сначала со снимком; если ИИ вернул пустоту (некоторые модели молчат на больших картинках) —
    # повторяем по одному тексту страницы: весь прайс и так есть в тексте
    content = call(True)
    m = re.search(r"\{[\s\S]*\}", re.sub(r"```(?:json)?", "", content))
    if not m and not content.strip():
        content = call(False)
        m = re.search(r"\{[\s\S]*\}", re.sub(r"```(?:json)?", "", content))
    if not m:
        raise RuntimeError("ИИ вернул не JSON: " + content[:200])
    return json.loads(m.group(0))


def num(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(str(v).replace(" ", "").replace(",", ".").replace("₽", ""))
    except ValueError:
        return default


def clean_offers(raw: list, keep_no_price: bool = False) -> list:
    out = []
    for o in raw[:150] if isinstance(raw, list) else []:
        if not isinstance(o, dict):
            continue
        price = num(o.get("price"), 0)
        if (not price or price <= 0) and not keep_no_price:
            continue   # в поисковой выдаче по наименованию цен нет — keep_no_price их сохраняет
        term = num(o.get("term_days"))
        out.append({
            "brand": str(o.get("brand") or "")[:60], "code": str(o.get("code") or "")[:40],
            "name": str(o.get("name") or "")[:120], "price": round(price, 2),
            "amount": int(num(o.get("amount"), 0) or 0), "term": int(term) if term is not None else None,
            "warehouse": str(o.get("warehouse") or "")[:60], "is_requested": bool(o.get("is_requested")),
        })
    return out


def cmd_scan():
    req = json.loads(sys.stdin.read() or "{}")
    url, code, profile = req.get("url") or "", req.get("code") or "", req.get("profile") or ""
    if not url or not profile:
        raise RuntimeError("нужны url и profile")
    cfg = ai_settings()
    Path(profile).mkdir(parents=True, exist_ok=True)
    jpeg, text, title = open_and_capture(url, profile, float(req.get("wait") or 4), cfg["headless"],
                                         str(req.get("click") or "").strip())
    low = (text[:3000] + " " + title).lower()
    if any(w in low for w in CAPTCHA_WORDS) and len(text) < 3000:
        return {"ok": True, "page": "captcha", "note": title or "проверка «вы не робот»", "offers": []}
    if req.get("save_shot"):
        Path(req["save_shot"]).write_bytes(jpeg)
    name_mode = (req.get("ask") or "") == "name"   # поиск по наименованию: цен в выдаче нет
    d = ask_ai(jpeg, text, req.get("query") or code, cfg, PROMPT_NAME if name_mode else PROMPT)
    return {"ok": True, "page": d.get("page") or "results", "note": d.get("note"),
            "offers": clean_offers(d.get("offers") or [], keep_no_price=name_mode),
            "title": title[:120], "ai": d.get("_ai")}


def cmd_login(profile: str, url: str):
    Path(profile).mkdir(parents=True, exist_ok=True)
    driver = make_driver(profile, headless=False, height=900)
    driver.get(url)
    print("Окно открыто: войдите в кабинет поставщика и закройте окно — вход сохранится.", flush=True)
    try:
        while True:                       # ждём, пока окно закроют
            time.sleep(1)
            _ = driver.window_handles
    except Exception:
        pass
    finally:
        try:
            driver.quit()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scan", "login"])
    ap.add_argument("--profile")
    ap.add_argument("--url")
    a = ap.parse_args()
    if a.cmd == "login":
        return cmd_login(a.profile, a.url)
    try:
        res = cmd_scan()
    except Exception as e:
        res = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
