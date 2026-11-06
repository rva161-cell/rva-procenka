"""Подтверждение артикула парсингом по наименованию.

Когда фото-распознавание (8B) сомневается в артикуле, бот ищет наименование детали
в поисковой выдаче и выписывает из неё пары «бренд + артикул». Найденное
проверяется по базам поставщиков (core/verify) — подтверждённое уходит в проценку.

Откуда брать выдачу:
1. PHOTO_SEARCH_PROXY (адрес поискового помощника на рабочем ПК,
   deploy/photo_search_helper.py) — домашний IP, поисковики не капчат. Пока
   переменная не задана, путь не используется.
2. Прямой запрос Bing с VPS — сейчас поисковики капчат датацентры, поэтому обычно
   пусто; оставить как запасной канал.
"""
import json
import os
import re
import urllib.parse

import httpx

TIMEOUT = 60
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
DEFAULT_SEARCH_URL = "https://www.bing.com/search?q={query}"

PROMPT = """Перед тобой текст поисковой выдачи интернета по запросу «{query}».
Найди артикулы (каталожные номера) автозапчастей, упомянутые в результатах.

Верни ТОЛЬКО JSON без пояснений и markdown:
{{"offers": [{{"brand": "бренд", "code": "артикул", "name": "наименование как в выдаче"}}]}}

Правила: только то, что реально написано в тексте, ничего не придумывай;
включай только строки, где различимы И бренд, И артикул; не больше 8."""


def _strip_html(html: str) -> str:
    html = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&[a-z#0-9]+;", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", text)


async def _ai_offers(cfg: dict, query: str, page_text: str) -> list[dict]:
    lm = cfg.get("lmstudio") or {}
    if not (lm.get("url") and (lm.get("modelFast") or lm.get("model"))):
        raise RuntimeError("не настроена модель для чтения выдачи (LMSTUDIO_*)")
    body = {"model": lm.get("modelFast") or lm.get("model"), "temperature": 0.1, "max_tokens": 800,
            "messages": [{"role": "user", "content": PROMPT.format(query=query)
                          + "\n\nТЕКСТ ВЫДАЧИ:\n" + page_text[:12000]}]}
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(lm["url"].rstrip("/") + "/chat/completions", json=body,
                         headers={"Authorization": "Bearer " + (lm.get("key") or "lm-studio")})
    if r.status_code != 200:
        raise RuntimeError(f"ИИ не ответил (HTTP {r.status_code})")
    content = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    m = re.search(r"\{[\s\S]*\}", re.sub(r"```(?:json)?", "", content))
    if not m:
        raise RuntimeError("ИИ вернул не JSON")
    offers = json.loads(m.group(0)).get("offers") or []
    return [o for o in offers if isinstance(o, dict)]


def _dedupe(offers: list[dict]) -> list[dict]:
    seen, rows = set(), []
    for o in offers:
        code, brand = (o.get("code") or "").strip(), (o.get("brand") or "").strip()
        if not code or not brand:
            continue
        k = (brand.lower(), code.upper())
        if k in seen:
            continue
        seen.add(k)
        rows.append({"brand": brand, "code": code, "name": (o.get("name") or "")[:120]})
        if len(rows) >= 8:
            break
    return rows


async def _via_proxy(query: str, cfg: dict, proxy: str) -> list[dict]:
    """Выдача с поискового помощника на рабочем ПК (домашний IP)."""
    key = os.environ.get("PHOTO_SEARCH_PROXY_KEY") or ""
    url = proxy.rstrip("/") + "/search?q=" + urllib.parse.quote_plus(query)
    if key:
        url += "&key=" + urllib.parse.quote_plus(key)
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    page = (r.json().get("text") or "").strip()
    if len(page) < 300:
        raise RuntimeError("выдача пустая")
    return _dedupe(await _ai_offers(cfg, query, page))


async def _direct(query: str, cfg: dict) -> list[dict]:
    """Прямой запрос Bing с VPS — сейчас поисковики капчат датацентры, обычно пусто."""
    tpl = os.environ.get("PHOTO_NAME_SEARCH_URL") or DEFAULT_SEARCH_URL
    url = tpl.format(query=urllib.parse.quote_plus(query))
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": UA,
                                                      "Accept-Language": "ru,en"}) as c:
        r = await c.get(url)
    if r.status_code != 200 or len(r.text) < 20000:
        raise RuntimeError("поисковик не отдал выдачу (проверка «вы не робот»?)")
    page = _strip_html(" ".join(re.findall(r'<li class="b_algo"[\s\S]*?</li>', r.text)) or r.text)
    if len(page) < 300:
        raise RuntimeError("выдача пустая")
    return _dedupe(await _ai_offers(cfg, query, page))


async def confirm(query: str, cfg: dict) -> list[dict]:
    """Парсинг выдачи по наименованию → [{brand, code, name}] (может быть пусто).

    Бросает исключение при полном сбое — вызывающий решает, что показать."""
    query = query.strip()
    if len(query) < 4:
        return []
    proxy = os.environ.get("PHOTO_SEARCH_PROXY") or ""
    if proxy:
        try:
            return await _via_proxy(query, cfg, proxy)
        except Exception as e:
            print(f"[web] поисковый помощник недоступен ({e}) — ищу напрямую")
    return await _direct(query, cfg)
