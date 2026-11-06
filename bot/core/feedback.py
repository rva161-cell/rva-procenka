"""Обратная связь и приглашения: бот → сервер проценки (questions.json, referrals.json)."""
import httpx


def _headers(cfg: dict) -> dict:
    key = (cfg.get("procenka") or {}).get("botKey") or ""
    return {"Content-Type": "application/json", **({"X-Bot-Key": key} if key else {})}


def _base(cfg: dict) -> str:
    return (cfg.get("procenka") or {}).get("url") or "http://127.0.0.1:8766"


async def post_question(cfg: dict, transport: str, tid, text: str) -> bool:
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(f"{_base(cfg)}/api/question",
                                  json={"transport": transport, "tid": str(tid), "text": text},
                                  headers=_headers(cfg), timeout=8.0)
            return r.status_code == 200
    except Exception:
        return False


async def post_referral(cfg: dict, transport: str, tid, inviter: str) -> bool:
    """Фиксация «кто кого пригласил»: inviter — id пригласившего в мессенджере."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(f"{_base(cfg)}/api/bot/referral",
                                  json={"transport": transport, "tid": str(tid), "inviter": str(inviter)},
                                  headers=_headers(cfg), timeout=8.0)
            return r.status_code == 200
    except Exception:
        return False
