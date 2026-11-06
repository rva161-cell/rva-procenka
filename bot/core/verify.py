"""Подтверждение предложенных артикулов по базам поставщиков.

Уровни:
  1) программа проценки (../procenka, порт 8766) — GET /api/brands и /api/search
     с бот-ключом (X-Bot-Key): сервер отдаёт сырую выдачу, правила уровня применяет бот;
     без ключа сервер вернёт гостевую выдачу (наценка, 10 строк);
  2) фолбэк, если проценка не запущена: гостевые методы сайта Поставщик
     (search-by-code + get-group-offers) — те же эндпоинты, что в адаптере проценки.

Модель могла выдумать артикул — «подтверждённым» код считается только после того,
как база поставщиков вернула по нему совпадающий бренд.
"""
import json
import re
import time

import httpx

from .levels import api_headers

SUPWEB_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
SUPWEB_DEST = "    K7OLM"  # пункт выдачи по умолчанию — как в адаптере проценки

_brand_cache: dict[str, tuple[float, dict]] = {}  # norm(code) -> (ts, результат)


def norm_code(s) -> str:
    return re.sub(r"[\s\-./\\_]", "", str(s or "").upper())


def brand_matches(expected, found) -> bool:
    if not expected or not found:
        return False
    a = re.sub(r"[^a-zа-я0-9]", "", str(expected).lower())
    b = re.sub(r"[^a-zа-я0-9]", "", str(found).lower())
    if not a or not b:
        return False
    return a == b or a.startswith(b) or b.startswith(a)


async def _procenka_brands(code: str, cfg: dict, client: httpx.AsyncClient) -> list[dict]:
    base = (cfg.get("procenka") or {}).get("url") or "http://127.0.0.1:8766"
    r = await client.get(f"{base}/api/brands", params={"code": code},
                         headers={"Accept": "application/json", **api_headers(cfg)}, timeout=12.0)
    r.raise_for_status()
    brands = (r.json() or {}).get("brands") or []
    return [
        {"code": b.get("code") or code, "brand": b.get("brand"), "pid": b.get("pid"),
         "name": b.get("name") or "", "suppliers": b.get("suppliers") or []}
        for b in brands if b.get("brand")
    ]


async def _aeweb_brands(code: str, client: httpx.AsyncClient) -> list[dict]:
    r = await client.get(
        "https://sup01.example/api/products/v1/search-by-code",
        params={"code": code},
        headers={"Accept": "application/json", "User-Agent": SUPWEB_UA, "Referer": "https://sup01.example/"},
        timeout=15.0,
    )
    r.raise_for_status()
    data = r.json()
    lst = data.get("result") if isinstance(data, dict) else data
    if not isinstance(lst, list):
        raise RuntimeError("Поставщик: неожиданный формат ответа")
    return [
        {"code": b.get("code") or code, "brand": b.get("maker"), "pid": b.get("mega_id"),
         "name": b.get("name") or "", "suppliers": ["Поставщик"]}
        for b in lst
    ]


async def _aeweb_post(action: str, body: dict, client: httpx.AsyncClient) -> dict:
    r = await client.post(
        f"https://sup01.example/api/products/v1/{action}",
        headers={
            "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": SUPWEB_UA, "Origin": "https://sup01.example",
            "Referer": "https://sup01.example/search-result-products",
        },
        json=body, timeout=20.0,
    )
    r.raise_for_status()
    data = r.json()
    if not data:
        raise RuntimeError(f"Поставщик: пустой ответ {action}")
    return data


def _aeweb_map_item(it: dict, brand, code, name) -> dict:
    av, sh, of = it.get("availability") or {}, it.get("shipment") or {}, it.get("offer") or {}
    ret = True
    try:
        ref = json.loads(of.get("ref") or "{}")
        if ref.get("return_denied"):
            ret = False
    except Exception:
        pass
    delivery = re.sub(r"\s+", " ", sh.get("delivery_time_formatted") or "").strip()
    sd = sh.get("shipment_days")
    if av.get("daysFrom") is not None:
        term = int(av["daysFrom"])
    elif isinstance(sd, (int, float)) or (isinstance(sd, str) and sd.isdigit()):
        term = int(sd)
    else:
        term = None
    return {
        "supplier": "Поставщик", "brand": brand or "", "code": code or "",
        "name": (name or "")[:120],
        "term": term,
        "price": float(it.get("price") or 0),
        "amount": it.get("quantity") if it.get("quantity") is not None else of.get("amount_max", 0),
        "warehouse": ("доставка: " + delivery) if delivery else str(of.get("warehouse_id") or "").strip(),
        "dealer": False, "ret": ret, "isCross": False,
    }


async def lookup_brands(code: str, cfg: dict) -> dict:
    """Поиск брендов по коду: проценка → фолбэк Поставщик. Кэш 10 минут."""
    key = norm_code(code)
    if not key:
        return {"brands": [], "source": "none"}
    cached = _brand_cache.get(key)
    if cached and time.time() - cached[0] < 600:
        return cached[1]

    out = None
    async with httpx.AsyncClient() as client:
        try:
            out = {"brands": await _procenka_brands(code, cfg, client), "source": "проценка"}
        except Exception as e:
            if (cfg.get("procenka") or {}).get("fallbackSupplierWeb") is False:
                raise
            try:
                out = {"brands": await _aeweb_brands(code, client), "source": "Поставщик"}
            except Exception as e2:
                out = {"brands": [], "source": "недоступно", "error": f"{e}; фолбэк: {e2}"}
    _brand_cache[key] = (time.time(), out)
    return out


async def verify_candidates(vision_result: dict, cfg: dict) -> dict:
    """Сверка кандидатов модели с базами. → {verified: [...], unverified: [...], checked_codes, source}."""
    to_check: list[dict] = []
    seen: set[str] = set()

    def push(code, conf, src):
        k = norm_code(code)
        if not k or len(k) < 4 or k in seen or len(to_check) >= 6:
            return
        seen.add(k)
        to_check.append({"code": str(code).strip(), "confidence": conf, "source": src})

    for c in vision_result.get("candidates", []):
        push(c["code"], c["confidence"], c.get("source"))
    for e in vision_result.get("barcode_digits", []):
        push(e, 0.5, "штрихкод")
    for l in vision_result.get("label_texts", []):
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-.\/]{3,19}", l.strip()):
            push(l, 0.4, "этикетка")

    verified, unverified = [], []
    last_source = "недоступно"
    exp_brand = vision_result.get("brand")

    for item in to_check:
        try:
            r = await lookup_brands(item["code"], cfg)
        except Exception:
            continue
        if r.get("source") and r["source"] != "none":
            last_source = r["source"]
        brands = r.get("brands") or []
        hit = next((b for b in brands if brand_matches(exp_brand, b["brand"])), None)
        if not hit and not exp_brand and len(brands) == 1:
            hit = brands[0]
        if hit and brands:
            verified.append({
                "code": hit["code"] or item["code"], "brand": hit["brand"], "name": hit["name"],
                "pid": hit["pid"], "suppliers": hit["suppliers"], "verified": True,
                "confidence": item["confidence"], "from": item["source"], "source": r["source"],
            })

    for c in vision_result.get("candidates", []):
        if any(norm_code(v["code"]) == norm_code(c["code"]) for v in verified):
            continue
        unverified.append({
            "code": c["code"], "brand": vision_result.get("brand"),
            "name": vision_result.get("product_name") or "", "verified": False,
            "confidence": c["confidence"], "from": c.get("source"), "source": "не проверен",
        })
    unverified.sort(key=lambda c: -(c["confidence"] or 0))

    seen_vb: set[str] = set()
    dedup = []
    for v in verified:
        k = norm_code(v["code"]) + "|" + str(v["brand"]).lower()
        if k in seen_vb:
            continue
        seen_vb.add(k)
        dedup.append(v)

    return {"verified": dedup, "unverified": unverified,
            "checked_codes": [t["code"] for t in to_check], "source": last_source}


async def search_offers(code: str, brand: str, pid, name: str, cfg: dict) -> dict:
    """Выдача предложений (проценка, crosses=0 — только точные). Фолбэк — Поставщик."""
    base = (cfg.get("procenka") or {}).get("url") or "http://127.0.0.1:8766"
    try:
        params = {"code": code, "brand": brand, "crosses": "0"}
        if pid:
            params["pid"] = str(pid)
        if name:
            params["name"] = str(name)[:120]
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{base}/api/search", params=params,
                                 headers={"Accept": "application/json", **api_headers(cfg)}, timeout=45.0)
            r.raise_for_status()
            return {"rows": (r.json() or {}).get("rows") or [], "source": "проценка"}
    except Exception as e:
        if (cfg.get("procenka") or {}).get("fallbackSupplierWeb") is False:
            raise
        p = pid
        if not p:
            r = await lookup_brands(code, cfg)
            hit = next((b for b in (r.get("brands") or []) if brand_matches(brand, b["brand"])), None)
            if not hit or not hit.get("pid"):
                return {"rows": [], "source": "Поставщик (нет данных)"}
            p = hit["pid"]
        async with httpx.AsyncClient() as client:
            d = await _aeweb_post("get-group-offers", {
                "section": "ElementDetails", "product_id": str(p),
                "obtain": {"method": "pickup", "destination": SUPWEB_DEST}, "filters": {},
                "group_id": int(p), "sort": "price", "full": True,
            }, client)
            rows = [_aeweb_map_item(it, brand, code, name) for it in (d.get("items") or [])]
            return {"rows": rows, "source": "Поставщик"}
