"""Лента новостей и органайзер-файлы: procenka → боты.

news.json → GET /api/news (публично). Формат записи: {"date", "title", "text"}.
Файлы органайзера (сканы) → /api/bot/organizer/* — только с ключом бот-API.
"""
import httpx
from urllib.parse import unquote


async def fetch_news(cfg: dict, limit: int = 5) -> list[dict]:
    base = (cfg.get("procenka") or {}).get("url") or "http://127.0.0.1:8766"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{base}/api/news", timeout=8.0)
            r.raise_for_status()
            items = (r.json() or {}).get("news") or []
    except Exception:
        return []  # сервер новостей недоступен — показываем пустую ленту, а не ошибку
    return items[:limit]


# ---------- органайзер для директора (раздел 6.7 промта): сканы прямо в чате ----------
async def organizer_files(cfg: dict, limit: int = 6) -> list[dict]:
    """Последние файлы органайзера (сканы, фото, документы)."""
    c = cfg.get("procenka") or {}
    base, key = (c.get("url") or "http://127.0.0.1:8766").rstrip("/"), c.get("botKey") or ""
    if not key:
        return []
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{base}/api/bot/organizer/files",
                                 headers={"X-Bot-Key": key}, timeout=8.0)
            r.raise_for_status()
            return ((r.json() or {}).get("files") or [])[:limit]
    except Exception:
        return []


async def organizer_file(cfg: dict, file_id: int):
    """Байты файла + (имя, kind, ссылка на Диск). None — не удалось."""
    c = cfg.get("procenka") or {}
    base, key = (c.get("url") or "http://127.0.0.1:8766").rstrip("/"), c.get("botKey") or ""
    if not key:
        return None
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{base}/api/bot/organizer/file/{file_id}",
                                 headers={"X-Bot-Key": key}, timeout=20.0)
            r.raise_for_status()
            return (r.content, unquote(r.headers.get("x-file-name") or "файл"),
                    r.headers.get("x-file-kind") or "file", r.headers.get("x-file-yadisk") or "")
    except Exception:
        return None
