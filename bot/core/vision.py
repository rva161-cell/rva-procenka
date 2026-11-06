"""Распознавание запчасти по фотографии — GLM-4.6V через api.vision-ai.example (OpenAI-совместимый API).

Модель только ПРЕДЛАГАЕТ кандидатов (бренд, продукт, артикул, штрихкод, коды этикетки);
подтверждение артикула по базам поставщиков — в core/verify.py.
Без ключа (VISION_API_KEY) бросается DemoModeError — бот честно сообщает, что не настроено.
"""
import asyncio
import base64
import collections
import json
import re
import time

import httpx

# ---------- очередь распознавания ----------
# LM Studio обрабатывает по одной картинке; одновременные фото выстраиваются здесь.
# Диалог перед вызовом спрашивает queue_eta() и предупреждает пользователя об ожидании.
_VISION_LOCK = asyncio.Lock()
_VISION_WAITING = 0                       # сколько вызовов ждут очереди прямо сейчас
_VISION_TIMES = collections.deque(maxlen=8)   # длительности последних распознаваний, с


def _vision_eta_sec() -> float:
    """Средняя длительность одного распознавания (по последним; пока мало данных — 30 с)."""
    if len(_VISION_TIMES) < 2:
        return 30.0
    return sum(_VISION_TIMES) / len(_VISION_TIMES)


def queue_eta() -> tuple[int, int]:
    """(позиция, оценка ожидания в секундах). Позиция 0 — очередь свободна, начнём сразу."""
    if not _VISION_LOCK.locked():
        return 0, 0
    pos = _VISION_WAITING + 1
    return pos, int(pos * _vision_eta_sec())

SYSTEM_PROMPT = """Ты — опытный кладовщик магазина автозапчастей с 25-летним стажем.
Пользователь прислал фотографию товара: деталь, упаковка или этикетка.
Определи, что это за товар, и предложи артикулы (каталожные номера).

Верни ТОЛЬКО JSON-объект без markdown-разметки и пояснений, строго по схеме:
{
  "is_auto_part": true,
  "what_is_it": "что видно на фото, одна фраза",
  "category": "категория: моторное масло / фильтр / колодки / свеча / и т.п.",
  "brand": "бренд с этикетки или null",
  "product_name": "линейка/название продукта с этикетки или null",
  "attributes": { "произвольные ключи": "SAE-вязкость, объём в литрах, допуск, тип жидкости и т.п." },
  "label_texts": ["все читаемые коды и номера с этикетки, КРОМЕ цифр штрихкода"],
  "barcode_digits": ["цифры под штрихкодом, если различимы"],
  "candidates": [
    { "code": "артикул", "confidence": 0.85, "source": "на фото | из знаний модели" }
  ],
  "not_sure_because": "что мешает точному определению (мелкий текст, блик, ракурс) или null",
  "advice": "как сфотографировать лучше, если не уверен; иначе null"
}

ЖЁСТКИЕ ПРАВИЛА:
1. НЕ выдумывай артикул. Включай candidate только если код виден на фото ИЛИ ты действительно
   знаешь его по своей базе знаний. Честно ставь confidence: 0.9+ — точно уверен,
   0.6–0.9 — скорее всего, ниже 0.5 — не включай вовсе.
2. Кандидатов не больше 4. Для масел разные объёмы — это РАЗНЫЕ артикулы.
3. Если читаемы цифры под штрихкодом (EAN-13 и т.п.) — обязательно выпиши их в barcode_digits.
4. В поле code пиши артикул так, как его пишет производитель (с префиксами/суффиксами).
5. Если на фото НЕ автозапчасть/автотовар — is_auto_part: false и пустой candidates.
6. Отвечай на русском языке."""

TIMEOUT = httpx.Timeout(120.0)


class DemoModeError(Exception):
    """Ни один провайдер распознавания не настроен (LM Studio и VISION_API_KEY)."""

    def __init__(self):
        super().__init__("Распознавание фото не настроено: впишите в .env LMSTUDIO_URL и "
                         "LMSTUDIO_MODEL (LM Studio на своём ПК) или VISION_API_KEY (облачный GLM)")


def _mime(data: bytes) -> str:
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8].hex() == "89504e470d0a1a0a":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"GIF":
        return "image/gif"
    return "image/jpeg"


async def recognize_photo(photo: bytes, user_caption: str | None, cfg: dict,
                          prefer_fast: bool = False) -> dict:
    """Распознавание фото через LM Studio (LMSTUDIO_*, на своём ПК); при её
    недоступности/ошибке — облачный GLM-4.6V (VISION_API_KEY).

    Распознаём маленькой быстрой моделью (LMSTUDIO_MODEL_FAST, qwen3-vl-8b);
    она одна — сомнения в артикуле решает не большая модель, а веб-подтверждение
    по наименованию (core/web_confirm) на стороне диалога. LMSTUDIO_MODEL —
    запасной id, если быстрый не настроен.

    Одновременные фото стоят в очереди (LM Studio работает по одной)."""
    v = cfg.get("vision", {})
    lm = cfg.get("lmstudio") or {}
    if not photo:
        raise ValueError("Пустое изображение")
    if len(photo) > 10 * 1024 * 1024:
        raise ValueError("Фото слишком большое (больше 10 МБ) — пришлите меньшее")

    global _VISION_WAITING
    model = lm.get("modelFast") or lm.get("model")
    if model:
        queued = _VISION_LOCK.locked()
        if queued:
            _VISION_WAITING += 1
        try:
            try:
                async with _VISION_LOCK:
                    t0 = time.monotonic()
                    try:
                        return await _recognize_openai(lm["url"], lm.get("key") or "lm-studio",
                                                       model, photo, user_caption, timeout=300.0)
                    finally:
                        _VISION_TIMES.append(time.monotonic() - t0)
            except Exception:
                if not v.get("apiKey"):   # запасного GLM нет — честно показываем сбой LM Studio
                    raise
                print("[vision] — пробую облачный GLM")
        finally:
            if queued:
                _VISION_WAITING -= 1
    if not v.get("apiKey"):
        raise DemoModeError()
    base = v.get("baseUrl") or "https://vision-ai.example/api/paas/v4"
    return await _recognize_openai(base, v["apiKey"], v.get("model") or "glm-4.6v",
                                   photo, user_caption, timeout=TIMEOUT)


async def _recognize_openai(base: str, key: str, model: str, photo: bytes,
                            user_caption: str | None, timeout: float) -> dict:
    data_url = f"data:{_mime(photo)};base64," + base64.b64encode(photo).decode()
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text",
                     "text": (user_caption + "\n\n" if user_caption else "") + "Что это за товар? Определи артикул."},
                ],
            },
        ],
        "temperature": 0.1,
        "max_tokens": 2000,
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
        )
        if r.status_code in (401, 403):
            raise RuntimeError("API распознавания: ключ отклонён — проверьте ключ в .env")
        if r.status_code != 200:
            raise RuntimeError(f"API распознавания: {r.status_code} {r.text[:300]}")

    content = (r.json().get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("API распознавания: пустой ответ модели")
    return parse_vision_json(content)


def parse_vision_json(content: str) -> dict:
    s = content.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.I)
    if fence:
        s = fence.group(1).strip()
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("Ответ модели не является JSON: " + s[:200])
    try:
        obj = json.loads(s[start:end + 1])
    except json.JSONDecodeError:
        raise ValueError("Не удалось разобрать JSON ответа модели: " + s[:200])

    candidates = [
        {
            "code": str(c["code"]).strip(),
            "confidence": max(0.0, min(1.0, float(c.get("confidence") or 0))),
            "source": c.get("source") or "",
        }
        for c in (obj.get("candidates") or [])
        if isinstance(c, dict) and c.get("code") and str(c["code"]).strip()
    ][:4]

    attrs = obj.get("attributes")
    attrs = attrs if isinstance(attrs, dict) else {}

    barcode = [re.sub(r"\D", "", str(x)) for x in (obj.get("barcode_digits") or [])]
    barcode = [x for x in barcode if len(x) >= 8][:3]

    labels = [str(x).strip()[:40] for x in (obj.get("label_texts") or []) if str(x).strip()][:10]

    return {
        "is_auto_part": obj.get("is_auto_part") is not False,
        "what_is_it": str(obj.get("what_is_it") or "")[:200],
        "category": str(obj.get("category") or "")[:100],
        "brand": str(obj["brand"])[:60] if obj.get("brand") else None,
        "product_name": str(obj["product_name"])[:120] if obj.get("product_name") else None,
        "attributes": attrs,
        "label_texts": labels,
        "barcode_digits": barcode,
        "candidates": candidates,
        "not_sure_because": str(obj["not_sure_because"])[:200] if obj.get("not_sure_because") else None,
        "advice": str(obj["advice"])[:250] if obj.get("advice") else None,
    }
