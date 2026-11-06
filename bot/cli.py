#!/usr/bin/env python3
"""Офлайн-проверка конвейера распознавания — без мессенджеров.

  venv/bin/python cli.py --all              # все *.jpg из папки бота
  venv/bin/python cli.py файл1.jpg ...      # конкретные файлы
  venv/bin/python cli.py --all --offers     # + топ-3 предложения по подтверждённому артикулу
  venv/bin/python cli.py --code 110800      # проверка поиска по коду (без vision-ключа)
  venv/bin/python cli.py --code 110800 --offers
  venv/bin/python cli.py --rules            # правила уровней доступа (гость/свой/близкий)
"""
import asyncio
import sys
from pathlib import Path

from core import verify, vision
from core.config import ROOT, load_config

cfg = load_config()


def fmt_candidate(c: dict) -> str:
    mark = "✅" if c.get("verified") else "⚠️"
    sup = f" [{','.join(c['suppliers'])}]" if c.get("suppliers") else ""
    name = f" — {str(c.get('name'))[:60]}" if c.get("name") else ""
    conf = (c.get("confidence") or 0)
    return f"  {mark} {c.get('brand') or '?'} {c['code']}{name}{sup}  (уверенность {conf:.2f}, {c.get('from') or c.get('source') or ''})"


def fmt_row(row: dict, i: int) -> str:
    bits = [f"  {i}. {row.get('price')} ₽", row.get("supplier") or ""]
    if row.get("term") is not None:
        bits.append(f"{row['term']} дн")
    if row.get("amount"):
        bits.append(f"{row['amount']} шт")
    if row.get("warehouse"):
        bits.append(str(row["warehouse"])[:40])
    return " — ".join(b for b in bits if b)


async def run_photo(file: Path, offers: bool) -> bool:
    print(f"\n📸 {file.name} ({file.stat().st_size} байт)")
    v = await vision.recognize_photo(file.read_bytes(), None, cfg)
    print(f"   Что на фото: {v['what_is_it']}")
    print(f"   Категория: {v['category']}; бренд: {v['brand'] or '—'}; продукт: {v['product_name'] or '—'}")
    if v["attributes"]:
        print("   Атрибуты: " + "; ".join(f"{k}={val}" for k, val in v["attributes"].items()))
    if v["barcode_digits"]:
        print("   Штрихкод: " + " | ".join(v["barcode_digits"]))
    if v["label_texts"]:
        print("   Коды на этикетке: " + " | ".join(v["label_texts"]))
    if v["not_sure_because"]:
        print("   Не уверен, потому что: " + v["not_sure_because"])

    ver = await verify.verify_candidates(v, cfg)
    codes = ", ".join(ver["checked_codes"]) or "—"
    print(f"   Проверка кодов ({ver['source']}): {codes}")
    if ver["verified"]:
        print("   Подтверждённые артикулы:")
        for c in ver["verified"]:
            print(fmt_candidate(c))
    else:
        print("   Подтверждённых артикулов нет.")
    if ver["unverified"]:
        print("   Не подтверждённые (предположения модели):")
        for c in ver["unverified"]:
            print(fmt_candidate(c))

    if offers and ver["verified"]:
        c = ver["verified"][0]
        r = await verify.search_offers(c["code"], c["brand"], c.get("pid"), c.get("name") or "", cfg)
        print(f"   💰 Проценка {c['brand']} {c['code']} ({r['source']}):")
        rows = [x for x in r["rows"] if (x.get("price") or 0) > 0]
        if not rows:
            print("     предложений нет")
        for i, row in enumerate(rows[:3]):
            print(fmt_row(row, i))
    return bool(ver["verified"])


async def run_code(code: str, offers: bool):
    print(f"\n🔎 Проверка кода «{code}» по базам:")
    r = await verify.lookup_brands(code, cfg)
    print(f"   Источник: {r['source']}; найдено брендов: {len(r.get('brands') or [])}")
    for b in (r.get("brands") or [])[:8]:
        print(f"   - {b['brand']} | {b['code']} | {str(b.get('name') or '')[:60]} | pid={b.get('pid') or '—'}")
    if offers and r.get("brands"):
        b = r["brands"][0]
        s = await verify.search_offers(b["code"] or code, b["brand"], b.get("pid"), b.get("name") or "", cfg)
        print(f"   💰 Проценка ({s['source']}):")
        rows = [x for x in s["rows"] if (x.get("price") or 0) > 0]
        for i, row in enumerate(rows[:3]):
            print(fmt_row(row, i))


def run_rules():
    """Офлайн-проверка правил уровней (core/levels.py) — без сервера и мессенджеров."""
    from core import levels

    rows = [
        {"supplier": f"Поставщик-{i}", "brand": "Total", "code": "110800", "name": f"Масло {i}",
         "price": 1000.0 + i * 111, "term": 1 + i, "amount": 3, "warehouse": f"Склад {i}"}
        for i in range(14)
    ]
    cfg = {"levels": {"guest_markup": 1.2, "guest_rows": 10}}
    for lvl in (1, 2, 3, 4):
        out, total = levels.apply_guest_rules(rows, lvl, cfg)
        print(f"Уровень {lvl}: показано {len(out)} из {total}; "
              f"цена №1 = {out[0]['price']}, поставщик = {out[0].get('supplier') or '—'}")

    g, t = levels.apply_guest_rules(rows, 1, cfg)
    assert len(g) == 10 and t == 14, "гость: топ-10 из 14"
    assert "supplier" not in g[0], "гость: поставщик скрыт"
    assert sup06(g[0]["price"] - rows[0]["price"] * 1.2) < 0.01, "гость: наценка +20%"
    f, tf = levels.apply_guest_rules(rows, 3, cfg)
    assert f == rows and tf == 14 and f[0].get("supplier"), "уровень 3+: выдача без изменений"
    assert levels.norm_phone("+7 (905) 123-45-67") == "79051234567"
    assert levels.norm_phone("89051234567") == "79051234567"
    assert levels.norm_phone("9051234567") == "79051234567"
    assert levels.norm_phone("110800") == ""          # артикул — не телефон
    assert phone_from_vcf("BEGIN:VCARD\r\nFN:Иван\r\nTEL;TYPE=CELL:+7 905 123-45-67\r\nEND:VCARD") == "79051234567"
    print("✅ Правила уровней: все проверки пройдены")


def phone_from_vcf(vcf: str) -> str:
    # дублирует max_bot.phone_from_vcf — cli.py не импортирует транспорт
    import re
    m = re.search(r"TEL[^:\r\n]*:\s*([+0-9][0-9 \-\(\)]{8,})", str(vcf or ""))
    from core import levels
    return levels.norm_phone(m.group(1)) if m else ""


class FakeChat:
    """Чат-заглушка для --dialog: запоминает ответы бота вместо отправки в мессенджер."""

    def __init__(self):
        self.out = []  # [(вид, текст, кнопки)]

    async def send(self, text, buttons, html=False):
        self.out.append(("text", text, buttons))

    async def send_image(self, data, caption, buttons):
        self.out.append(("image", caption, buttons))

    async def typing(self):
        pass

    def last(self):
        return self.out[-1]

    def actions(self):
        return [b.action for row in self.last()[2] for b in row]


async def run_dialog():
    """Офлайн-проверка диалога (core/dialog.py) по сценариям — сеть и сервер заменены заглушками."""
    from core import dialog as D, feedback, lenta, levels, news, present, verify

    user = {"level": 1, "role": "", "found": False, "login": "", "discount": 0, "offline": False}
    calls = {"question": [], "link": [], "news": [], "loads": 0, "approval": [], "photo_used": []}
    rows = [{"supplier": "Поставщик", "brand": "Total", "code": "110800", "name": "Масло", "price": 1000.0,
             "term": 1, "amount": 5, "warehouse": "Склад"}]
    brands2 = [{"code": "110800", "brand": "Total", "name": "Rubia", "pid": "p1", "suppliers": ["Поставщик"]},
               {"code": "110800", "brand": "Elring", "name": "Прокладка", "pid": "p2", "suppliers": ["Поставщик"]}]

    async def resolve_user(transport, uid, c): return dict(user)
    async def link_by_phone(transport, uid, phone, c):
        calls["link"].append(phone)
        return {"found": True, "level": 3, "login": "user@t.ru", "offline": False}
    async def lookup_brands(code, c): return {"brands": brands2 if code == "110800" else [], "source": "проценка"}
    async def search_offers(code, brand, pid, name, c): return {"rows": [dict(r) for r in rows], "source": "проценка"}
    conf = {"v": 0.9}   # уверенность распознавания (для теста автопрохода меняется на слабую)
    async def recognize_photo(data, caption, c, prefer_fast=False):
        calls["fast"] = calls.get("fast", []) + [prefer_fast]
        return {"is_auto_part": True, "what_is_it": "канистра", "category": "масло", "brand": "Total",
                "product_name": "Rubia", "attributes": {}, "label_texts": [], "barcode_digits": [],
                "candidates": [{"code": "110800", "confidence": conf["v"], "source": "на фото"}],
                "not_sure_because": None, "advice": None}
    async def verify_candidates(v, c):
        return {"verified": [{**brands2[0], "verified": True, "confidence": 0.9}], "unverified": [],
                "checked_codes": ["110800"], "source": "проценка"}
    async def post_question(c, transport, uid, text):
        calls["question"].append(text)
        return True
    async def post_referral(c, transport, uid, inviter): return True
    async def fetch_news(c, limit=5): return []
    review = {}

    levels.resolve_user, levels.link_by_phone = resolve_user, link_by_phone
    async def approval_submit(cfg, transport, tid, info, ap):
        calls["approval"] = [ap.get("code", "")]
        return {"ok": True}
    levels.approval_submit = approval_submit
    async def photo_used_stub(cfg, transport, tid, info):
        calls["photo_used"].append(1)
        return {"ok": True}
    levels.photo_used = photo_used_stub
    web = {"items": []}   # что «нашёл интернет» при веб-подтверждении
    async def web_confirm_stub(q, c=None):
        calls.setdefault("web_q", []).append(q)
        return list(web["items"])
    D.web_confirm.confirm = web_confirm_stub
    verify.lookup_brands, verify.search_offers, verify.verify_candidates = lookup_brands, search_offers, verify_candidates
    D.vision.recognize_photo = recognize_photo
    feedback.post_question, feedback.post_referral = post_question, post_referral
    news.fetch_news, lenta.news_add = fetch_news, lambda e: calls["news"].append(e)
    lenta.edit_card = lambda data, prompt: (b"edited", None)
    lenta.card_prompt = lambda: "промт"
    lenta.save_card = lambda data: ("/lenta/test.jpg", Path("/nonexistent"), "sha-new")
    lenta.last_card_hash, lenta.set_last_card_hash = lambda: "sha-old", lambda sha: None
    lenta.story_draft = lambda *a: "Черновик истории"
    lenta.set_review, lenta.get_review = lambda r: review.update(r), lambda: dict(review)
    lenta.clear_review = review.clear

    async def photo():
        calls["loads"] += 1
        return b"jpeg"

    d = D.Dialog("max", {"levels": {"guest_markup": 1.2, "guest_rows": 10}, "site": {}},
                 messenger="MAX", director_ids={"7"}, invite_link=lambda uid: f"https://max.ru/bot?start=i{uid}")
    ch, uid = FakeChat(), 100
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))
        print(("  ✅ " if cond else "  ❌ ") + name)

    await d.handle_start(ch, uid, payload="i55")
    check("старт по приглашению: приветствие и «ПРИСОЕДИНИТЬСЯ»",
          present.REFERRAL_NOTE in ch.last()[1] and "join" in ch.actions())
    await d.handle_action(ch, uid, "menu")
    check("МЕНЮ 1 уровня: две кнопки — оценка и регистрация",
          "input_code" in ch.actions()
          and not {"invite", "join", "photo_help"} & set(ch.actions()))
    await d.handle_text(ch, uid, "110800")
    check("артикул текстом → выбор бренда", "найдено брендов: 2" in ch.last()[1] and "brand:1" in ch.actions())
    await d.handle_text(ch, uid, "1")
    text = ch.last()[1]
    check("выбор цифрой → проценка гостю (наценка, без поставщика)", "1 200" in text and "Поставщик" not in text)
    await d.handle_action(ch, uid, "input_code")
    await d.handle_text(ch, uid, "!!")
    check("неверный артикул → подсказка", ch.last()[1] == present.CODE_BAD)
    await d.handle_text(ch, uid, "отмена")
    check("«отмена» → меню", ch.last()[1] == present.MENU_GREETING)
    await d.handle_action(ch, uid, "ask")
    await d.handle_text(ch, uid, "Есть фильтр на Камаз?")
    check("вопрос уходит специалисту", calls["question"] == ["Есть фильтр на Камаз?"]
          and ch.last()[1] == present.QUESTION_ACCEPTED)
    user.update(photos=2, photo_used=0, role="admin", found=True)   # фото-поиск — только директор
    await d.handle_photo(ch, uid, photo, "")
    check("чёткое фото директора → сразу проценка (без «верно/не то»), квота не тратится",
          calls["loads"] == 1 and calls["photo_used"] == [] and calls["fast"] == [False]
          and any("Артикул считан" in t for _, t, _ in ch.out)
          and "1 200" in ch.last()[1] and "Поставщик" not in ch.last()[1])
    conf["v"] = 0.6   # слабая уверенность → веб-подтверждение; интернет пуст → кнопки
    user.update(level=3, role="admin", found=True)   # админ/директор — фото без лимита
    await d.handle_photo(ch, uid, photo, "")
    check("неуверенное фото, интернет пуст → кандидат с кнопками",
          calls["loads"] == 2 and calls["web_q"] and {"ok", "no"} <= set(ch.actions()))
    await d.handle_action(ch, uid, "ok")
    check("«Верно» → проценка уровню 3 без наценки", "1 000" in ch.last()[1] and "1 200" not in ch.last()[1])
    conf["v"] = 0.6
    web["items"] = [{"brand": "Total", "code": "110800", "name": "Масло Rubia"}]
    await d.handle_photo(ch, uid, photo, "")
    check("сомнения → интернет подтвердил артикул → сразу проценка",
          calls["loads"] == 3 and any("Подтверждено по интернету" in t for _, t, _ in ch.out)
          and "1 000" in ch.last()[1])
    conf["v"] = 0.9
    web["items"] = []
    await d.handle_action(ch, uid, "menu")
    check("МЕНЮ полного доступа: оценка", "input_code" in ch.actions())
    dt = D.Dialog("telegram", {"levels": {"guest_markup": 1.2, "guest_rows": 10}, "site": {}},
                  messenger="Telegram", director_ids={"7"})
    dt.vision, dt.levels, dt.verify, dt.web_confirm = D.vision, D.levels, D.verify, D.web_confirm
    cht, uidt = FakeChat(), 100
    user.update(role="", found=True, level=3)   # клиент без админ-роли
    loads_before = calls["loads"]
    await dt.handle_photo(cht, uidt, photo, "")
    check("фото в Telegram у клиента → отказ, без распознавания",
          calls["loads"] == loads_before and "только у владельца" in cht.last()[1])
    user.update(role="", found=True, level=3)   # клиент без админ-роли
    c2, uid2 = FakeChat(), 200   # клиент (не директор) в MAX
    await d.handle_photo(c2, uid2, photo, "")
    check("фото клиента в MAX → отказ, без распознавания",
          calls["loads"] == loads_before and "только у владельца" in c2.last()[1])
    # (квоты фото больше нет: функция — личный инструмент директора, безлимит)
    user.update(role="")                 # дальше сценарий идёт как не-админ («Мысль дня» — отказ)
    await d.handle_action(ch, uid, "link")
    await d.handle_text(ch, uid, "+79050000001")
    check("номер текстом не привязывается", not calls["link"] and ch.last()[1] == present.LINK_PROMPT)
    await d.handle_contact(ch, uid, "79050000001", own=False)
    check("чужой контакт отклонён", not calls["link"] and ch.last()[1] == present.LINK_NOT_OWN)
    await d.handle_contact(ch, uid, "+7 905 000-00-01", own=True)
    check("свой контакт → привязка", calls["link"] == ["79050000001"] and "user@t.ru" in ch.last()[1])
    await d.handle_voice(ch, uid, None, transcription="110800")
    check("голос с расшифровкой → поиск", "найдено брендов" in ch.last()[1])
    await d.handle_action(ch, uid, "thought")
    check("«Мысль дня» не админу — отказ", ch.last()[1] == present.THOUGHT_DENIED)
    user.update(role="admin")
    await d.handle_action(ch, uid, "thought")
    await d.handle_photo(ch, uid, photo, "")
    check("карточка обработана → черновик и «Разместить»",
          "Черновик истории" in ch.last()[1] and "publish_lenta" in ch.actions())
    await d.handle_text(ch, uid, "Своя история")
    check("текст истории принимается", review.get("story") == "Своя история")
    await d.handle_action(ch, uid, "publish_lenta")
    check("публикация в ленту", calls["news"] and calls["news"][0]["text"] == "Своя история")
    user.update(role="", found=True, level=2)   # 2 уровень: зарегистрировался на сайте
    await d.handle_action(ch, uid, "menu")
    check("МЕНЮ 2 уровня: оценка, приглашение, лента — без фото-поиска (он только у директора)",
          "input_code" in ch.actions() and "reg_locked" not in ch.actions()
          and {"invite", "join"} <= set(ch.actions()) and "photo_help" not in ch.actions())
    await d.handle_text(ch, uid, "110800")
    await d.handle_text(ch, uid, "1")
    check("2 уровень: после оценки — «Отправить на согласование»",
          "request_approval" in ch.actions())
    await d.handle_action(ch, uid, "request_approval")
    check("заявка на согласование ушла директору", calls["approval"] == ["110800"])
    await d.handle_action(ch, uid, "invite")
    check("приглашение: QR с ссылкой и названием мессенджера",
          ch.last()[0] == "image" and "start=i100" in ch.last()[1] and "в MAX" in ch.last()[1])
    await d.handle_text(ch, uid, "привет как дела")
    check("непонятный текст → помощь и меню", ch.last()[1].startswith("Не понял") and "input_code" in ch.actions())

    async def broken(c, limit=5): raise RuntimeError("сбой")
    news.fetch_news = broken
    await d.handle_action(ch, uid, "join")
    check("ошибка внутри → ответ пользователю, а не тишина", ch.last()[1] == D.ERROR_TEXT)
    check("под каждым сообщением есть «МЕНЮ»",
          all(any(b.action == "menu" for row in btns for b in row) for kind, _, btns in ch.out))

    # кнопки транспортов
    import max_bot
    import bot as tg
    kb = d._with_menu(d._link_kb())
    mk = [[max_bot.max_button(b) for b in row] for row in kb]
    check("MAX: запрос контакта и callback", mk[0][1]["type"] == "request_contact" and mk[1][0]["payload"] == "menu")
    rk = tg.tg_markup(kb)
    check("Telegram: запрос контакта — на нижней клавиатуре",
          type(rk).__name__ == "ReplyKeyboardMarkup" and any(b.request_contact for b in rk.keyboard[0]))
    ik = tg.tg_markup(d._with_menu([[D.Button("Сайт", url="https://x.ru")]]))
    check("Telegram: ссылка и «МЕНЮ» — инлайн", ik.inline_keyboard[0][0].url == "https://x.ru"
          and ik.inline_keyboard[1][0].callback_data == "menu")

    failed = [n for n, ok in checks if not ok]
    if failed:
        sys.exit(f"❌ Диалог: не прошло {len(failed)} из {len(checks)}")
    print(f"✅ Диалог: все {len(checks)} проверок пройдены")


async def main():
    args = sys.argv[1:]
    offers = "--offers" in args
    if "--rules" in args:
        run_rules()
        return
    if "--dialog" in args:
        await run_dialog()
        return
    if "--code" in args:
        idx = args.index("--code")
        if idx + 1 >= len(args):
            sys.exit("Укажите код: venv/bin/python cli.py --code 110800")
        await run_code(args[idx + 1], offers)
        return

    files = [Path(a) for a in args if not a.startswith("--")]
    if "--all" in args or not files:
        files = sorted(p for p in ROOT.glob("*.jpg"))
    if not files:
        sys.exit("Фото (.jpg) не найдены.")

    has_key = bool((cfg.get("vision") or {}).get("apiKey"))
    print(f"Конвейер: {len(files)} фото, vision={(cfg.get('vision') or {}).get('model') or 'glm-4.6v'}, "
          f"ключ={'есть' if has_key else 'НЕТ'}")
    ok = 0
    for f in files:
        try:
            if await run_photo(f, offers):
                ok += 1
        except vision.DemoModeError as e:
            print(f"   ❌ ДЕМО-РЕЖИМ: {e}")
        except Exception as e:
            print(f"   ❌ {e}")
    print(f"\nИтог: подтверждён артикул на {ok} из {len(files)} фото.")


if __name__ == "__main__":
    asyncio.run(main())
