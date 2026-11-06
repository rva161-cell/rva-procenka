// Проценка поставщиков — локальная программа директора магазина запчастей.
// Запуск: node server.js  →  http://127.0.0.1:8766
// Поставщики хранятся в suppliers.json (кнопка «Добавить поставщика» в интерфейсе).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const SUP_FILE = path.join(ROOT, "suppliers.json");
const PORT = process.env.PORT || 8766;

// .env рядом с server.js: переменные из файла применяются, если не заданы в окружении
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {}

// ---------- поставщики ----------
function loadSups() {
  try { return JSON.parse(fs.readFileSync(SUP_FILE, "utf8")); }
  catch (e) { return []; }
}
function saveSups(s) { writeJsonAtomic(SUP_FILE, s); }
let suppliers = loadSups();

// Личные списки поставщиков: у каждого пользователя с полным доступом — свой (файл на пользователя).
// Директор (admin) владеет общим списком suppliers.json; 4-й уровень («моя Проценка») смотрит
// общий список без права менять. Чужие данные друг другу не видны — файл выбирается по id сессии.
const SUPS_USERS_DIR = path.join(ROOT, "suppliers_users");
function loadUserSups(uid) {
  try { return JSON.parse(fs.readFileSync(path.join(SUPS_USERS_DIR, uid + ".json"), "utf8")) || []; }
  catch (e) { return []; }
}
function saveUserSups(uid, list) {
  fs.mkdirSync(SUPS_USERS_DIR, { recursive: true });
  writeJsonAtomic(path.join(SUPS_USERS_DIR, uid + ".json"), list);
}
// Пространство поставщиков запроса: по какому списку идёт проценка (key попадает в ключ кэша —
// у пользователей с личными списками цены свои, чужие ответы к ним не попадают).
function supSpaceOf(req) {
  if (process.env.BOT_API_KEY && req.headers["x-bot-key"] === process.env.BOT_API_KEY)
    return { mode: "global", key: "global", list: () => suppliers };
  const u1 = currentUser(req);
  if (u1 && u1.role === "admin") return { mode: "global", key: "global", list: () => suppliers };
  if (u1 && isLevel4(u1)) return { mode: "global", key: "global", list: () => suppliers };
  if (u1 && isFull(u1)) return { mode: "own", key: "own:" + u1.id, userId: u1.id, list: () => loadUserSups(u1.id) };
  return { mode: "global", key: "global", list: () => suppliers };   // гости — общая база (выдача с наценкой)
}

function pubSup(s) { // для отдачи в UI: ключ маскируется, логин — только админу (adminSup)
  return { id: s.id, name: s.name, site: s.site,
    apiKey: s.apiKey ? s.apiKey.slice(0, 4) + "…" + s.apiKey.slice(-4) : "",
    hasKey: !!s.apiKey, keyPair: String(s.apiKey || "").includes(":"), adapter: s.adapter, onDemand: !!s.onDemand,
    orderUrl: orderLink(s), ownOrderUrl: s.orderUrl || "", enabled: s.enabled, pricePath: s.priceFile ? s.priceFile.path : "" };
}
function adminSup(s) { return { ...pubSup(s), login: s.login || "", searchUrl: s.searchUrl || "", publicUrl: s.publicUrl || "" }; }
// главная страница магазина поставщика (без путей и наших логинов): publicUrl или начало адреса site
function shopHome(s) {
  const raw = String(s.publicUrl || s.site || "").trim();
  if (!raw) return "";
  try { return new URL(/^https?:\/\//.test(raw) ? raw : "https://" + raw).origin + "/"; } catch (e) { return ""; }
}
// ссылка «корзины»: поиск артикула на сайте поставщика (orderUrl / searchUrl с {code}) или главная
function orderLink(s) { return s.orderUrl || s.searchUrl || shopHome(s); }
// «Проверенные поставщики» — подключение работает: отмечены «для гостей», адаптер настоящий
const VERIFIED_SKIP = new Set(["none", "demo", "pricelist"]);
function verifiedSuppliers() {
  return suppliers.filter(s => s.enabled && !VERIFIED_SKIP.has(s.adapter) && shopHome(s))
    .map(s => ({ name: s.name, url: shopHome(s) }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

// ---------- адаптеры ----------
async function fetchJSON(url, headers, method = "GET", body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: headers || {},
      method: method === "POST_RAW" ? "POST" : method || "GET",   // POST_RAW — сырое тело, на проводе обычный POST
      body: method === "POST_RAW" ? body : (method === "POST" && body !== undefined ? JSON.stringify(body) : undefined),
      signal: ac.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    return { status: res.status, data, text };
  } finally { clearTimeout(t); }
}

// --- Поставщик, API v2 (https://api.sup01.example/doc/v2): договорные цены по ключу ---
// Ответ: { META: { result: "DATA" | "EMPTY" | ошибка }, DATA: [...] }. Ключ — в заголовке key.
// Способ получения (delivery_key) обязателен: от него зависят сроки. Выбирается по подстроке
// названия из поля поставщика delivery (suppliers.json) или SUP01_DELIVERY (.env),
// по умолчанию — адрес магазина в Ростове-на-Дону.
const aeDeliveries = {}; // id поставщика -> {ts, key, name}
const AE_DELIVERY_DEFAULT = "Немировича-Данченко";
async function aeCall(sup, action, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const r = await fetchJSON(`https://api.sup01.example/api/v2/json/${action}/?${qs}`, { key: sup.apiKey });
  if (r.status === 401) throw new Error("API Поставщик: ключ отклонён (Unauthorized) — проверьте ключ в личном кабинете sup01.example");
  if (!r.data || typeof r.data !== "object") throw new Error("API Поставщик: неожиданный ответ: " + (r.text || "").slice(0, 120));
  const meta = r.data.META || {};
  if (meta.result === "EMPTY") return [];
  if (meta.result !== "DATA") throw new Error("API Поставщик: " + (meta.message || meta.result || JSON.stringify(r.data).slice(0, 120)));
  return Array.isArray(r.data.DATA) ? r.data.DATA : [];
}
// «ГГГГ-ММ-ДД ЧЧ:ММ» → дней от сегодня; NULL — товар на складе выбранного пункта (0 дней)
function daysUntil(s) {
  if (s === null || s === undefined || s === "") return 0;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((new Date(+m[1], m[2] - 1, +m[3]) - today) / 86400e3));
}
const sup01 = {
  async brands(sup, code) {
    const d = await aeCall(sup, "search_brands", { code });
    return d.map(b => ({ code: b.code || code, brand: b.brand || "", name: b.name || "", pid: null }));
  },
  async deliveryKey(sup) {
    const c = aeDeliveries[sup.id];
    if (c && Date.now() - c.ts < 86400e3) return c.key;
    const d = await aeCall(sup, "get_deliveries", {});
    if (!d.length) throw new Error("API Поставщик: нет вариантов доставки");
    const want = String(sup.delivery || process.env.SUP01_DELIVERY || AE_DELIVERY_DEFAULT).toLowerCase();
    const pick = d.find(x => String(x.delivery_name || "").toLowerCase().includes(want)) || d[0];
    if (!c || c.key !== pick.delivery_key) console.log(`Поставщик (${sup.name}): способ получения — ${pick.delivery_name}`);
    aeDeliveries[sup.id] = { ts: Date.now(), key: pick.delivery_key, name: pick.delivery_name };
    return pick.delivery_key;
  },
  async search(sup, code, brandInfo, crosses) {
    const d = await aeCall(sup, "search_items", {
      code, brand: brandInfo.brand, delivery_key: await this.deliveryKey(sup),
      with_crosses: crosses ? 1 : 0, with_offers: 1
    });
    return d.map(it => ({
      supplier: sup.name, brand: it.brand || "", code: it.code || "",
      name: String(it.name || "").slice(0, 120),
      term: daysUntil(it.delivery_time),
      price: parseFloat(it.price) || 0, amount: parseInt(it.amount, 10) || 0,
      warehouse: it.warehouse_name || (it.stock ? "склад Поставщик" : "под заказ"),
      dealer: String(it.dealer) === "1", ret: String(it.return) === "1",
      isCross: it.cross !== null && it.cross !== undefined
    })).filter(r => r.price > 0);
  }
};

// --- Поставщика, API v1.0 (api.sup03.example): ключ параметром key ---
// GET /v1.0/ordering/get_stock.json?items[0][resource_article]=…&items[0][brand_name]=…&analogs=1
// → { resources: [{ id, article, brand: {id, name}, name, offers: [{ warehouse: {name}, price,
//   quantity, average_period, assured_period, reliability, is_transit }] }] }.
// Неверный ключ — HTTP 401 { errors: [{ code: "ERR_API_KEY_INVALID" }] }.
async function sup03Stock(sup, params) {
  const qs = new URLSearchParams({ ...params, key: sup.apiKey }).toString();
  const r = await fetchJSON(`https://api.sup03.example/v1.0/ordering/get_stock.json?${qs}`);
  const err = r.data && Array.isArray(r.data.errors) && r.data.errors[0];
  if (r.status === 401 || err) throw new Error("API Поставщика: " + (err ? (err.text || err.code) : "ключ отклонён") + " — проверьте ключ в личном кабинете sup03.example");
  if (r.status !== 200 || !r.data) throw new Error("API Поставщика: HTTP " + r.status + " " + String(r.text || "").slice(0, 100));
  return Array.isArray(r.data.resources) ? r.data.resources : [];
}
const sup03 = {
  async brands(sup, code) {
    const res = await sup03Stock(sup, { "items[0][resource_article]": code });
    return res.map(x => ({ code: x.article || code, brand: (x.brand && x.brand.name) || "", name: x.name || "", pid: String(x.id || "") }));
  },
  async search(sup, code, brandInfo, crosses) {
    const params = { "items[0][resource_article]": brandInfo.code || code, "items[0][brand_name]": brandInfo.brand };
    if (crosses) params.analogs = 1;
    const res = await sup03Stock(sup, params);
    const main = brandKey(brandInfo.brand);
    const rows = [];
    for (const x of res) {
      const isCross = !(brandKey(x.brand && x.brand.name) === main && normCode(x.article) === normCode(brandInfo.code || code));
      for (const o of (x.offers || [])) rows.push({
        supplier: sup.name, brand: (x.brand && x.brand.name) || "", code: x.article || "",
        name: String(x.name || "").slice(0, 120),
        term: o.average_period != null ? +o.average_period : null,
        price: +o.price || 0, amount: +o.quantity || 0,
        warehouse: ((o.warehouse && o.warehouse.name) || "") + (o.is_transit ? " · в пути" : ""),
        dealer: false, ret: false, isCross
      });
    }
    return rows.filter(r => r.price > 0);
  }
};

// --- SUP02: публичный SOAP API v2.1 (api.sup02.example) ---
// Ключи: в поле apiKey в формате "KEY1:KEY2" (пара выдаётся в личном кабинете Поставщик).
// Схема: GetCheckoutDetails (типы доставки; GetDeliveryDetails без адреса отвечает ошибкой)
// + GetSearch (поиск). Кроссы вложены: PartsList > Part > crosses > Part > stocks > stock.
function sup02XmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// блоки <ns1:tag> верхнего уровня внутри xml — с учётом вложенных одноимённых тегов
function sup02Tags(xml, tag) {
  const out = [];
  const re = new RegExp("<(/?)ns1:" + tag + ">", "g");
  let depth = 0, start = -1, m;
  while ((m = re.exec(xml)) !== null) {
    if (!m[1]) { if (depth++ === 0) start = re.lastIndex; }
    else if (depth > 0 && --depth === 0) out.push(xml.slice(start, m.index));
  }
  return out;
}
function sup02Inner(block, tag) {
  return sup02Tags(block, tag)[0] || "";
}
function sup02Part(block) {
  const crossesXml = sup02Inner(block, "crosses");
  const own = crossesXml ? block.replace("<ns1:crosses>" + crossesXml + "</ns1:crosses>", "") : block;
  return {
    guid: sup02Inner(own, "guid"), brand: sup02Inner(own, "brand"),
    partnumber: sup02Inner(own, "partnumber"), name: sup02Inner(own, "name"),
    stocks: sup02Tags(sup02Inner(own, "stocks"), "stock").map(s => ({
      id: sup02Inner(s, "id"), price: sup02Inner(s, "price"), count: parseInt(sup02Inner(s, "count")) || 0,
      delivery: Number.isFinite(parseInt(sup02Inner(s, "delivery"))) ? parseInt(sup02Inner(s, "delivery")) : null,
      description: sup02Inner(s, "description")
    })),
    crosses: sup02Tags(crossesXml, "Part").map(sup02Part)
  };
}
const sup02 = {
  keys(sup) {
    const parts = (sup.apiKey || "").split(":");
    return { k1: (parts[0] || "").trim(), k2: (parts[1] || "").trim() };
  },
  async soap(action, bodyInner) {
    const xml = '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="https://api.sup02.example/">' +
      '<soap:Body>' + bodyInner + '</soap:Body></soap:Envelope>';
    const r = await fetchJSON("https://api.sup02.example/service/v2.1/" + action, {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "https://api.sup02.example/service/v2.1/" + action
    }, "POST_RAW", xml);
    return r.text || "";
  },
  async deliveryId(sup) {
    const c = sup02Deliveries[sup.id];
    if (c && Date.now() - c.ts < 86400e3) return c.id;
    const { k1, k2 } = this.keys(sup);
    const xml = await this.soap("GetCheckoutDetails",
      `<tns:GetCheckoutDetails><tns:KEY1>${sup02XmlEsc(k1)}</tns:KEY1><tns:KEY2>${sup02XmlEsc(k2)}</tns:KEY2></tns:GetCheckoutDetails>`);
    const ids = sup02Tags(sup02Inner(xml, "DeliveryType"), "delivery")
      .map(b => ({ id: sup02Inner(b, "id"), name: sup02Inner(b, "name") })).filter(d => d.id);
    if (!ids.length) {
      const msg = sup02Inner(xml, "message");
      throw new Error("Не получен список типов доставки" + (msg ? ": " + msg : " — проверьте ключи KEY1:KEY2"));
    }
    // самовывоз не требует адреса доставки — им и считаем цены
    const pick = ids.find(d => /самовывоз/i.test(d.name)) || ids[0];
    sup02Deliveries[sup.id] = { ts: Date.now(), id: pick.id };
    return pick.id;
  },
  async searchRaw(sup, text) {
    const { k1, k2 } = this.keys(sup);
    if (!k1 || !k2) throw new Error("Укажите ОБА ключа API в формате KEY1:KEY2 — пара выдаётся в личном кабинете Поставщик");
    const did = await this.deliveryId(sup);
    return await this.soap("GetSearch",
      `<tns:GetSearch><tns:KEY1>${sup02XmlEsc(k1)}</tns:KEY1><tns:KEY2>${sup02XmlEsc(k2)}</tns:KEY2><tns:text>${sup02XmlEsc(text)}</tns:text><tns:delivery_id>${sup02XmlEsc(did)}</tns:delivery_id></tns:GetSearch>`);
  },
  parseParts(xml) {
    const msg = (xml.match(/<ns1:message>([\s\S]*?)<\/ns1:message>/) || [])[1] || "";
    const parts = sup02Tags(sup02Inner(xml, "PartsList"), "Part").map(sup02Part);
    return { message: msg.replace(/<!\[CDATA\[|\]\]>/g, ""), parts };
  },
  async brands(sup, code) {
    const xml = await this.searchRaw(sup, code);
    const ok = /<ns1:success>true<\/ns1:success>/.test(xml);
    const d = this.parseParts(xml);
    if (!ok) throw new Error(d.message || "ошибка запроса");
    return d.parts.map(p => ({ code: p.partnumber, brand: p.brand, pid: p.guid, name: p.name }));
  },
  async search(sup, code, brandInfo, crosses) {
    const xml = await this.searchRaw(sup, code);
    const ok = /<ns1:success>true<\/ns1:success>/.test(xml);
    const d = this.parseParts(xml);
    if (!ok) throw new Error(d.message || "ошибка запроса");
    const bl = brandInfo.brand.toLowerCase();
    const main = d.parts.filter(p => p.brand.toLowerCase() === bl || (brandInfo.pid && p.guid === brandInfo.pid));
    const rows = [];
    const push = (p, isCross) => (p.stocks || []).forEach(s => rows.push({
      supplier: sup.name, brand: p.brand, code: p.partnumber, name: (p.name || "").slice(0, 120),
      term: s.delivery, price: parseFloat(String(s.price).replace(",", ".")) || 0, amount: s.count,
      warehouse: s.description || (s.id ? "склад " + s.id : ""),
      dealer: false, ret: false, isCross: !!isCross
    }));
    main.forEach(p => push(p, false));
    if (crosses) main.forEach(p => p.crosses.forEach(c => push(c, true)));
    return rows;
  }
};
const sup02Deliveries = {};

// --- Поставщик (сайт): проценка БЕЗ ключа, как гость сайта sup01.example ---
// Найденные гостевые методы (те же, что использует сам сайт):
//   GET  /api/products/v1/search-by-code?code=          — «Возможные запросы» (бренды)
//   POST /api/products/v1/get-group-offers              — предложения по выбранному бренду
//   POST /api/products/v1/get-section-groups            — группы: кроссы (ElementKrosses) и замены номера (ElementDetails)
// Цены — розничные (без входа в личный кабинет).
const SUPWEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SUPWEB_DEST = "    K7OLM"; // пункт выдачи по умолчанию
async function aeWebPost(action, body) {
  const r = await fetchJSON(`https://sup01.example/api/products/v1/${action}`, {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": SUPWEB_UA,
    "Origin": "https://sup01.example",
    "Referer": "https://sup01.example/search-result-products"
  }, "POST", body);
  if (!r.data) throw new Error("Поставщик (сайт): пустой ответ от " + action);
  return r.data;
}
function aeWebMapItem(it, supName, brand, code, name, isCross) {
  const av = it.availability || {}, sh = it.shipment || {}, of = it.offer || {};
  let ret = true;
  try { const ref = JSON.parse(of.ref || "{}"); if (ref.return_denied) ret = false; } catch (e) {}
  const delivery = (sh.delivery_time_formatted || "").replace(/\s+/g, " ").trim();
  return {
    supplier: supName, brand: brand || "", code: code || "", name: (name || "").slice(0, 120),
    term: av.daysFrom != null ? +av.daysFrom : (parseInt(sh.shipment_days) || null),
    price: +it.price, amount: it.quantity != null ? +it.quantity : (of.amount_max != null ? +of.amount_max : 0),
    warehouse: delivery ? "доставка: " + delivery : (of.warehouse_id || "").trim(),
    dealer: false, ret, isCross: !!isCross
  };
}
const sup01Web = {
  async brands(sup, code) {
    const r = await fetchJSON(`https://sup01.example/api/products/v1/search-by-code?code=${encodeURIComponent(code)}`, {
      "Accept": "application/json", "User-Agent": SUPWEB_UA, "Referer": "https://sup01.example/"
    });
    if (!r.data) throw new Error("Поставщик (сайт): нет ответа по артикулу");
    const list = r.data.result || r.data;
    if (!Array.isArray(list)) throw new Error("Поставщик (сайт): неожиданный формат ответа");
    return list.map(b => ({ code: b.code, brand: b.maker, pid: b.mega_id, name: b.name || "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const pid = String(brandInfo.pid || "");
    if (!pid) throw new Error("Не найден идентификатор продукта — выполните поиск заново");
    const obtain = { method: "pickup", destination: SUPWEB_DEST };
    const exact = await aeWebPost("get-group-offers", {
      section: "ElementDetails", product_id: pid, obtain, filters: {},
      group_id: Number(pid), sort: "price", full: true
    });
    const rows = (exact.items || []).map(it => aeWebMapItem(it, sup.name, brandInfo.brand, brandInfo.code, brandInfo.name, false));
    if (!crosses) return rows;
    for (const section of ["ElementKrosses", "ElementDetails"]) {
      const g = await aeWebPost("get-section-groups", {
        section, product_id: pid, obtain, filters: {}, page: 0,
        group_id: Number(pid), sort: "price", search_source_id: "1"
      });
      for (const grp of (g.groups || [])) {
        // пропускаем сам исходный товар (иначе «замена номера» дублирует выдачу)
        if (String(grp.group_id) === pid) continue;
        for (const it of (grp.best_items || [])) {
          rows.push(aeWebMapItem(it, sup.name, grp.brand && grp.brand.value, grp.brand && grp.brand.code, grp.brand && grp.brand.title, true));
        }
      }
    }
    return rows;
  }
};

// --- Демо-поставщик (офлайн): данные по мотивам скриншотов, для проверки программы ---
const DEMO_EXACT_110800 = [
  { supplier: "Демо-поставщик (офлайн)", brand: "Total", code: "110800", name: "Rubia TIR 8600 10W-40, 208 л", term: 1, price: 141100, amount: 4,  warehouse: "Основной склад",   dealer: 1, ret: 1, isCross: false },
  { supplier: "Демо-поставщик (офлайн)", brand: "Total", code: "110800", name: "Rubia TIR 8600 10W-40, 208 л", term: 3, price: 152400, amount: 2,  warehouse: "Склад Санкт-Петербург", dealer: 0, ret: 0, isCross: false },
  { supplier: "Демо-поставщик (офлайн)", brand: "Total", code: "110800", name: "Rubia TIR 8600 10W-40, 208 л", term: 7, price: 163600, amount: 12, warehouse: "Склад поставщика",      dealer: 0, ret: 1, isCross: false }
];
const DEMO_CROSSES_110800 = [
  { supplier: "Демо-поставщик (офлайн)", brand: "Volga-Oil",    code: "800444",     name: "Масло моторное 10W-40, 1 л", term: 2, price: 338, amount: 60, warehouse: "Основной склад", dealer: 0, ret: 1, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "Takayama",     code: "5131006",   name: "Масло моторное 10W-40, 1 л", term: 1, price: 489, amount: 24, warehouse: "Основной склад", dealer: 1, ret: 1, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "Luxe",         code: "19370",     name: "Масло моторное 10W-40, 1 л", term: 3, price: 527, amount: 40, warehouse: "Склад Москва",   dealer: 0, ret: 0, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "Sintec",       code: "922475",    name: "Масло моторное 10W-40, 1 л", term: 2, price: 571, amount: 8,  warehouse: "Основной склад", dealer: 1, ret: 0, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "Teboil",       code: "153401",    name: "Масло моторное 10W-40, 1 л", term: 4, price: 604, amount: 16, warehouse: "Склад поставщика", dealer: 0, ret: 1, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "S-Oil",        code: "21C1AW12",  name: "Масло моторное 10W-40, 1 л", term: 5, price: 655, amount: 30, warehouse: "Склад поставщика", dealer: 0, ret: 0, isCross: true },
  { supplier: "Демо-поставщик (офлайн)", brand: "Hyundai Xteer",code: "0510000A70",name: "Масло моторное 10W-40, 1 л", term: 2, price: 712, amount: 5,  warehouse: "Основной склад", dealer: 0, ret: 1, isCross: true }
];
const demo = {
  async brands(sup, code) {
    if (String(code).trim() !== "110800") return [];
    return [
      { code: "110800", brand: "Total" }, { code: "110800", brand: "AM Point" },
      { code: "110800", brand: "Auger" }, { code: "110800", brand: "Elring" },
      { code: "110800", brand: "Hyundai" }
    ];
  },
  async search(sup, code, brandInfo, crosses) {
    const brand = brandInfo.brand;
    if (String(code).trim() !== "110800" || String(brand).toLowerCase() !== "total") return [];
    return (crosses ? [...DEMO_EXACT_110800, ...DEMO_CROSSES_110800] : DEMO_EXACT_110800).map(r => ({ ...r, supplier: sup.name }));
  }
};

// ---------- обработчики API ----------
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const BODY_LIMIT = 1024 * 1024; // 1 МБ: больше JSON-запросам не нужно
async function readBody(req) {
  let b = "";
  for await (const ch of req) {
    b += ch;
    if (b.length > BODY_LIMIT) throw new HttpError(413, "Слишком большой запрос");
  }
  if (!b) return {};
  try { return JSON.parse(b); }
  catch (e) { throw new HttpError(400, "Некорректный JSON в запросе"); }
}
// сырое тело (загрузка файлов и сканов): до 25 МБ, возвращается Buffer
const FILE_LIMIT = 25 * 1024 * 1024;
async function readRaw(req) {
  const chunks = [];
  let n = 0;
  for await (const ch of req) {
    chunks.push(ch); n += ch.length;
    if (n > FILE_LIMIT) throw new HttpError(413, "Файл больше 25 МБ");
  }
  return Buffer.concat(chunks);
}

// ---------- ограничение частоты: ключ → отметки времени за окно ----------
const RATE = new Map();
function rateHit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (RATE.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  RATE.set(key, arr);
  if (RATE.size > 5000) for (const [k, v] of RATE) if (!v.length || now - v[v.length - 1] > windowMs) RATE.delete(k);
  return arr.length <= limit;
}
// за nginx реальный адрес клиента — в X-Real-IP (TRUST_PROXY=1 в .env)
function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const h = req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0];
    if (h) return String(h).trim().replace(/^::ffff:/, "");
  }
  return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

// ---------- кто спрашивает выдачу: бот, полный доступ или гость ----------
// Гость видит то же, что в боте: первые GUEST_ROWS строк, цена × GUEST_MARKUP, без поставщиков.
// Бот получает сырую выдачу и сам применяет правила уровня своего пользователя (bot/core/levels.py).
// наценка гостя в процентах — задаётся админом на странице проценки (поле «Наценка»), хранится
// в базе (settings.guestMarkupPct); по умолчанию 20 % (или GUEST_MARKUP=1.2 из .env)
const GUEST_MARKUP_DEFAULT_PCT = Math.round(((Number(process.env.GUEST_MARKUP) || 1.2) - 1) * 100);
function guestMarkupPct() { return Number(DB.settings.get("guestMarkupPct", GUEST_MARKUP_DEFAULT_PCT)); }
function guestMarkup() { return 1 + guestMarkupPct() / 100; }
const GUEST_ROWS = Number(process.env.GUEST_ROWS) || 10;
const GUEST_SEARCHES = Number(process.env.GUEST_SEARCHES) || 30; // запросов за 10 минут с одного адреса
function searchAccess(req) {
  if (process.env.BOT_API_KEY && req.headers["x-bot-key"] === process.env.BOT_API_KEY) return "bot";
  const u1 = currentUser(req);
  if (u1 && (u1.role === "admin" || isLevel4(u1))) return "full";   // моя проценка: директор и 4-й уровень
  if (u1 && isFull(u1)) return "full";   // своя проценка: свои поставщики, свои цены
  return "guest";   // 1–2 уровни — гостевая выдача
}
function guestStatus(status) { // имена поставщиков и тексты их ошибок гостю не показываем
  return status.map((s, i) => ({ supplier: "Поставщик " + (i + 1), ok: s.ok, count: s.count || 0 }));
}

// ---------- кэш ответов поставщиков ----------
// Одинаковый запрос в течение SEARCH_CACHE_MIN минут (по умолчанию 10) не идёт к поставщикам
// повторно: быстрее и не тратит квоту (у Поставщика каждый запрос — «пробой»). Одновременные
// одинаковые запросы ждут один общий ответ. Если кто-то из поставщиков ответил ошибкой —
// результат живёт только минуту. Кэш сбрасывается при любом изменении списка поставщиков.
const SEARCH_CACHE = new Map(); // ключ -> { ts, ttl, value: Promise }
const SEARCH_TTL = (Number(process.env.SEARCH_CACHE_MIN) || 10) * 60e3;
const SEARCH_CACHE_MAX = 500;
async function cached(key, fn) {
  const hit = SEARCH_CACHE.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.value;
  const entry = { ts: Date.now(), ttl: SEARCH_TTL, value: fn() };
  SEARCH_CACHE.set(key, entry);
  if (SEARCH_CACHE.size > SEARCH_CACHE_MAX) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
  try {
    const v = await entry.value;
    if (!v.status.every(s => s.ok)) entry.ttl = 60e3;
    return v;
  } catch (e) {
    SEARCH_CACHE.delete(key);
    throw e;
  }
}
function clearSearchCache() { SEARCH_CACHE.clear(); }

// опрос поставщиков: fn(sup, adapter) → результат; ошибки — в status.
// extra (галочки фильтра вошедшего) — опрашиваем ровно отмеченных, независимо от «участвует»:
// это личный набор пользователя. Без extra (гость, бот, массовая проценка) — набор «для гостей»:
// включённые без «по запросу» (у тех лимит запросов, гостям не тратится).
async function askSuppliers(fn, countOf, extra, list) {
  const src = list || suppliers;
  const enabled = extra ? src.filter(s => extra.has(s.id)) : src.filter(s => s.enabled && !s.onDemand);
  const results = await Promise.allSettled(enabled.map(async sup => {
    const ad = adapterOf(sup);
    // имя поставщика в статусе уже есть — в тексте ошибки его не повторяем
    if (!ad) throw new Error("подключение к этому поставщику ещё не сделано");
    if (!NO_KEY_NEEDED(sup.adapter) && !sup.apiKey) throw new Error("не задан API-ключ — автопроценка недоступна");
    return await fn(sup, ad);
  }));
  const status = [], ok = [];
  results.forEach((r, idx) => {
    const name = enabled[idx].name;
    if (r.status === "fulfilled") { status.push({ supplier: name, ok: true, count: countOf(r.value) }); ok.push({ name, value: r.value }); }
    else {
      const entry = { supplier: name, ok: false, error: String(r.reason && r.reason.message || r.reason) };
      if (r.reason && r.reason.noBrands) entry.noBrands = true;   // штатный отказ в подборе бренда (Поставщик) — UI покажет серым
      status.push(entry);
    }
  });
  return { status, ok };
}

// Один бренд поставщики пишут по-разному: «Mann» у Поставщик, «MANN-FILTER» у Поставщик, «MANN» у Поставщика.
// brandKey приводит название к ключу сравнения: регистр, пробелы и знаки не важны, а родовые
// хвосты («-FILTER», «GROUP», «GMBH»…) отбрасываются. Список хвостов — осторожный, чтобы не
// склеить разные бренды; при необходимости дополнить BRAND_ALIASES.
const BRAND_SUFFIXES = ["filters", "filter", "group", "gmbh", "automotive"];
const BRAND_ALIASES = {};  // ключ → ключ: явные синонимы, например { lemforder: "lemfoerder" }
function brandKey(b) {
  let k = String(b || "").toLowerCase().replace(/ё/g, "е").replace(/ö/g, "o").replace(/[^a-z0-9а-я]/g, "");
  for (const s of BRAND_SUFFIXES) if (k.length > s.length + 2 && k.endsWith(s)) { k = k.slice(0, -s.length); break; }
  return BRAND_ALIASES[k] || k;
}

// «Возможные запросы»: бренды по артикулу, сгруппированные по всем поставщикам.
// У группы bySup — как бренд записан у каждого поставщика: { имя поставщика: { brand, code, pid, name } }.
// Поиск предложений берёт отсюда написание бренда и pid своего поставщика (pid одного поставщика
// другому не подходит: у Поставщик это guid, у Поставщик (сайт) — mega_id, у Поставщика — id ресурса).
function collectBrands(code, extra, space) {
  const sp = space || { key: "global", list: () => suppliers };
  return cached("brands|" + sp.key + "|" + normCode(code) + "|" + extraKey(extra), async () => {
    const { status, ok } = await askSuppliers((sup, ad) => ad.brands(sup, code), v => v.length, extra, sp.list());
    const byBrand = new Map();
    for (const { name, value } of ok) for (const b of value) {
      const k = brandKey(b.brand);
      if (!k) continue;
      if (!byBrand.has(k)) byBrand.set(k, { code: b.code, brand: b.brand, suppliers: [], pid: b.pid || null, name: b.name || "", bySup: {} });
      const g = byBrand.get(k);
      if (!g.suppliers.includes(name)) g.suppliers.push(name);
      if (!g.bySup[name]) g.bySup[name] = { brand: b.brand, code: b.code || code, pid: b.pid || "", name: b.name || "" };
      if (!g.pid && b.pid) g.pid = b.pid;
      if (!g.name && b.name) g.name = b.name;
      if (!g.code && b.code) g.code = b.code;
    }
    const brands = [...byBrand.values()].sort((a, b) => b.suppliers.length - a.suppliers.length);
    return { brands, status };
  });
}

// выдача по артикулу и бренду, отсортированная по цене.
// group — группа бренда из collectBrands: каждый поставщик ищет по своему написанию бренда и pid;
// поставщик, который ответил на поиск брендов, но такого бренда не знает, не опрашивается.
// Без группы (бренд не найден в «возможных запросах») — у всех ищем по brandInfo как есть.
function collectOffers(code, brandInfo, crosses, group, brandsStatus, extra, space) {
  const sp = space || { key: "global", list: () => suppliers };
  const failed = new Set((brandsStatus || []).filter(s => !s.ok).map(s => s.supplier));
  const key = ["search", sp.key, normCode(code), brandKey(brandInfo.brand), group ? "g" : brandInfo.pid, crosses ? 1 : 0, extraKey(extra)].join("|");
  return cached(key, async () => {
    const { status, ok } = await askSuppliers((sup, ad) => {
      if (!group) return ad.search(sup, code, brandInfo, crosses);
      const own = group.bySup[sup.name];
      if (own) return ad.search(sup, own.code || code, { ...brandInfo, ...own, name: own.name || brandInfo.name }, crosses);
      // поиск брендов у этого поставщика упал — пробуем с общим написанием бренда
      if (failed.has(sup.name)) return ad.search(sup, code, { ...brandInfo, pid: "" }, crosses);
      return [];
    }, v => v.length, extra, sp.list());
    const rows = ok.flatMap(x => x.value).sort((a, b) => a.price - b.price);
    return { rows, status };
  });
}

// extra=<id,id> — галочки фильтра «Поставщики» вошедшего: опрашиваем ровно отмеченных,
// «участвует» (набор для гостей) не важна. Параметр без id — не опрашивать никого,
// без параметра (старый клиент, массовая проценка) — включённых, как раньше. Гость и бот
// extra не передают: у них свой набор — «для гостей».
function extraOf(req, q) {
  if (searchAccess(req) !== "full") return null;
  const raw = q.get("extra");
  if (raw === null) return null;
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}
function extraKey(extra) { return extra ? "x:" + [...extra].sort().join(",") : ""; }

// GET /api/brands?code=110800
async function apiBrands(req, res, q) {
  const code = q.get("code") || "";
  if (!code.trim()) return json(res, 400, { error: "Укажите артикул" });
  const { brands: groups, status } = await collectBrands(code, extraOf(req, q), supSpaceOf(req));
  const brands = groups.map(({ bySup, ...b }) => b);  // написания по поставщикам — только для поиска
  if (searchAccess(req) === "guest") {
    return json(res, 200, { brands: brands.map(b => ({ ...b, suppliers: [] })), status: guestStatus(status) });
  }
  json(res, 200, { brands, status });
}
// гость: лимит частоты (каждый запрос тратит квоту поставщиков, у Поставщика — «пробои»)
function guestLimited(req, res) {
  if (searchAccess(req) !== "guest") return false;
  if (rateHit("search:" + clientIp(req), GUEST_SEARCHES, 10 * 60 * 1000)) return false;
  json(res, 429, { error: "Слишком много запросов — повторите через несколько минут или войдите в аккаунт" });
  return true;
}

// GET /api/search?code=&brand=&crosses=0|1&pid=&name=
async function apiSearch(req, res, q) {
  const code = q.get("code") || "", brand = q.get("brand") || "";
  const crosses = q.get("crosses") === "1";
  if (!code.trim() || !brand.trim()) return json(res, 400, { error: "Укажите артикул и бренд" });
  try {   // счётчик проценок для отчёта в 9:00 (кольцо на 7 дней; сайт и бот — один путь)
    const s = DB.settings.get("procenka_days", { d: [], c: [] });
    const today = new Date().toISOString().slice(0, 10);
    if (s.d[0] === today) s.c[0] += 1;
    else { s.d.unshift(today); s.c.unshift(1); }
    while (s.d.length > 7) { s.d.pop(); s.c.pop(); }
    DB.settings.set("procenka_days", s);
  } catch (_) {}
  const brandInfo = { brand, pid: q.get("pid") || "", code, name: q.get("name") || "" };
  // группа бренда из «возможных запросов» (они в кэше): у каждого поставщика своё написание и pid
  const space = supSpaceOf(req);   // чей список опрашиваем: общий у директора/гостей, личный — у полного доступа
  const extra = extraOf(req, q);
  const found = await collectBrands(code, extra, space);
  const group = found.brands.find(b => brandKey(b.brand) === brandKey(brand)) || null;
  let { rows, status } = await collectOffers(code, brandInfo, crosses, group, found.status, extra, space);
  if (searchAccess(req) === "guest") {
    const markup = guestMarkup();
    rows = rows.slice(0, GUEST_ROWS).map(({ supplier, ...r }) => ({ ...r, price: Math.round(r.price * markup * 100) / 100 }));
    return json(res, 200, { rows, status: guestStatus(status), guest: { markup, rows: GUEST_ROWS } });
  }
  json(res, 200, { rows, status });
}

// ---------- массовая проценка: список артикулов файлом (XLSX/CSV) ----------
// Только полный доступ (isFull — одобренный пользователь, «свои поставщики»). Позиции
// ищутся по очереди тем же конвейером, что обычный поиск (collectBrands → collectOffers),
// результат каждой — лучшее предложение; отчёт одним файлом CSV/XLSX с суммой корзины.
// Задание живёт в памяти 2 часа; у пользователя одновременно одно задание.
const bulkJobs = new Map();          // id → { actor, items, rows, done, total, finished, created }
const BULK_MAX = 200;

function bulkGrid(buf, name) {       // файл → строки-колонки (как у прайс-листов поставщиков)
  const ext = path.extname(name || "").toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buf, { codepage: 1251 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("в файле нет листов");
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }).map(r => (r || []).map(x => String(x == null ? "" : x).trim()));
  }
  const text = decodeBuf(buf);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error("файл пуст");
  const d = detectDelim(lines[0]);
  return lines.map(l => splitLine(l, d));
}

function bulkCols(head) {            // колонки «артикул / бренд / комментарий» по заголовкам
  const h = head.map(s => String(s || "").toLowerCase());
  const find = (...words) => h.findIndex(x => words.some(w => x.includes(w)));
  const code = find("артикул", "код", "арт");
  const header = code >= 0;
  if (!header) return { header: false, code: 0, brand: 1, note: 2 };
  const brand = find("бренд", "производител");
  const note = find("коммент", "наименован", "назван", "примеч");
  return { header: true, code, brand: brand >= 0 ? brand : undefined, note: note >= 0 ? note : undefined };
}

async function bulkParse(req, res, q) {   // шаг 1: разобрать файл, собрать кандидатов бренда
  const u1 = currentUser(req);
  if (!isFull(u1)) return json(res, 403, { error: "Массовая проценка — после подтверждения регистрации" });
  const space = supSpaceOf(req);
  const buf = await readRaw(req);
  if (!buf.length) return json(res, 400, { error: "Пустой файл" });
  if (buf.length > 5 * 1024 * 1024) return json(res, 400, { error: "Файл больше 5 МБ" });
  let grid;
  try { grid = bulkGrid(buf, q.get("name") || ""); }
  catch (e) { return json(res, 400, { error: "Не удалось прочитать файл: " + e.message }); }
  const cols = bulkCols(grid[0] || []);
  const g = (r, k) => (cols[k] !== undefined ? String(r[cols[k]] == null ? "" : r[cols[k]]).trim() : "");
  const items = [], seen = new Set();
  for (const r of grid.slice(cols.header ? 1 : 0)) {
    const code = g(r, "code").replace(/\s+/g, "");
    if (!code) continue;
    const key = normCode(code) + "|" + brandKey(g(r, "brand"));
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ code: code.slice(0, 30), brand: g(r, "brand").slice(0, 60), note: g(r, "note").slice(0, 120) });
    if (items.length >= BULK_MAX) break;
  }
  if (!items.length) return json(res, 400, { error: "В файле не нашлось строк с артикулами" });
  // позиции без бренда: заранее спрашиваем у поставщиков варианты — хозяин уточнит до запуска
  const need = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].brand) continue;
    let candidates = [];
    try {
      candidates = (await collectBrands(items[i].code, null, space)).brands.slice(0, 6)
        .map(b => ({ brand: b.brand, name: b.name || "", suppliers: b.suppliers.length }));
    } catch (e) { /* поставщики не ответили — оставляем пустой список, позицию можно пропустить */ }
    need.push({ i, code: items[i].code, candidates });
  }
  return json(res, 200, { items, need });
}

async function bulkStart(req, res) {     // шаг 2: бренды уточнены — запускаем очередь
  const u1 = currentUser(req);
  if (!isFull(u1)) return json(res, 403, { error: "Массовая проценка — после подтверждения регистрации" });
  const b = await readBody(req);
  const items = (Array.isArray(b.items) ? b.items : [])
    .map(x => ({ code: String(x.code || "").replace(/\s+/g, "").slice(0, 30),
                 brand: String(x.brand || "").trim().slice(0, 60),
                 note: String(x.note || "").trim().slice(0, 120) }))
    .filter(x => x.code && x.brand);
  if (!items.length) return json(res, 400, { error: "Нет позиций: у каждой должны быть артикул и бренд" });
  if (items.length > BULK_MAX) return json(res, 400, { error: `Максимум ${BULK_MAX} позиций за раз` });
  for (const [, j] of bulkJobs)
    if (j.actor === u1.login && !j.finished) return json(res, 409, { error: "Уже идёт другая массовая проценка — дождитесь окончания" });
  for (const [id, j] of bulkJobs)
    if (Date.now() - (j.finished || j.created) > 2 * 3600e3) bulkJobs.delete(id);
  const id = crypto.randomBytes(8).toString("hex");
  const job = { actor: u1.login, items, rows: [], done: 0, total: items.length, finished: 0, created: Date.now(), space: supSpaceOf(req) };
  bulkJobs.set(id, job);
  runBulk(job);
  return json(res, 200, { id, total: items.length });
}

async function runBulk(job) {            // по одной позиции за раз, чтобы не заваливать поставщиков
  for (const it of job.items) {
    try {
      const found = await collectBrands(it.code, null, job.space);
      const group = found.brands.find(b => brandKey(b.brand) === brandKey(it.brand)) || null;
      const brandInfo = { brand: it.brand, pid: (group && group.pid) || "",
                          code: (group && group.code) || it.code, name: it.note || (group && group.name) || "" };
      const { rows } = await collectOffers(it.code, brandInfo, false, group, found.status, null, job.space);
      const live = rows.filter(r => (r.price || 0) > 0).sort((a, b) => a.price - b.price);
      job.rows.push({ ...it, ok: live.length > 0, count: live.length,
        best: live[0] ? { price: live[0].price, supplier: live[0].supplier || "",
                          amount: live[0].amount ?? null, term: live[0].term ?? null } : null });
    } catch (e) {
      job.rows.push({ ...it, ok: false, count: 0, best: null, error: String(e.message || e).slice(0, 150) });
    }
    job.done++;
  }
  job.finished = Date.now();
}

function bulkJobOf(req, q) {
  const u1 = currentUser(req);
  const job = bulkJobs.get(String(q.get("id") || ""));
  if (!job || !u1 || (job.actor !== u1.login && !isAdmin(u1))) return null;
  return job;
}

function bulkStatus(req, res, q) {
  const job = bulkJobOf(req, q);
  if (!job) return json(res, 404, { error: "Задание не найдено" });
  return json(res, 200, { done: job.done, total: job.total, finished: !!job.finished, rows: job.rows });
}

function bulkReport(req, res, q) {       // отчёт одним файлом: CSV (Excel открывает сразу) или XLSX
  const job = bulkJobOf(req, q);
  if (!job) return json(res, 404, { error: "Задание не найдено" });
  const head = ["Артикул", "Бренд", "Комментарий", "Лучшая цена", "Поставщик", "Наличие, шт", "Срок, дн", "Предложений"];
  const rows = job.rows.map(r => [
    r.code, r.brand, r.note || "",
    r.ok && r.best ? Math.round(r.best.price * 100) / 100 : "не найдено",
    r.ok && r.best ? r.best.supplier : "",
    r.ok && r.best && r.best.amount != null ? r.best.amount : "",
    r.ok && r.best && r.best.term != null ? r.best.term : "",
    r.count]);
  const total = job.rows.reduce((s, r) => s + (r.ok && r.best ? r.best.price : 0), 0);
  rows.push([], ["ИТОГО по минимальным ценам", "", "", Math.round(total * 100) / 100, "", "", "", ""]);
  if (q.get("format") === "csv") {
    const cell = v => { const s = String(v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bulkcenka.csv"' });
    return res.end("\ufeff" + [head, ...rows].map(r => r.map(cell).join(";")).join("\r\n"));
  }
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), "Проценка");
  res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="bulkcenka.xlsx"' });
  return res.end(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// ---------- авторизация ----------
// пользователи, сессии, заявки, приглашения и вопросы — в SQLite (db.js, файл data.db).
// Список пользователей держится в памяти (их единицы–сотни), каждое изменение сразу пишется в базу.
const { openDb } = require("./db");
const DB = openDb(ROOT);
let users = DB.users.all();
function saveUser(u) { DB.users.save(u); }
function removeUser(id) { DB.users.remove(id); users = users.filter(x => x.id !== id); }
// пароли: scrypt со своей солью у каждого — "scrypt$соль$хеш".
// Старые хеши (sha256 с общей солью) ещё принимаются и при входе пересчитываются в scrypt.
const LEGACY_SALT = "rva-procenka-2026";
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + salt + "$" + crypto.scryptSync(String(p), salt, 32).toString("hex");
}
function checkPass(stored, p) {
  stored = String(stored || "");
  if (stored.startsWith("scrypt$")) {
    const [, salt, hash] = stored.split("$");
    const got = crypto.scryptSync(String(p), salt, 32);
    const want = Buffer.from(hash || "", "hex");
    return want.length === got.length && crypto.timingSafeEqual(got, want);
  }
  const legacy = crypto.createHash("sha256").update(LEGACY_SALT + p).digest("hex");
  return stored.length === legacy.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(legacy));
}
const isLegacyHash = h => !String(h || "").startsWith("scrypt$");
if (!users.length) {
  // первый администратор: логин и пароль из .env (ADMIN_LOGIN / ADMIN_PASSWORD),
  // иначе пароль генерируется и один раз печатается в консоль — смените его после входа
  const login = process.env.ADMIN_LOGIN || "admin";
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  users = [{ id: "admin", login, pass: hashPass(pass), role: "admin", approved: true, created: Date.now() }];
  saveUser(users[0]);
  if (!process.env.ADMIN_PASSWORD) console.log(`Создан администратор: ${login} / ${pass} — смените пароль в кабинете`);
}
// Регистрация с 26.10.2026 сразу активирует учётку (approved: true), а полный доступ к
// проценке определяется только сроком access_until, который выдаёт администратор.
// Разовый перенос «одобренным до 23.10 — бессрочно» выполнен ранее и убран: он делал бы
// каждого нового зарегистрированного бессрочно полноправным при первом же рестарте.
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const uid = DB.sessions.userId(parseCookies(req).sid, clientIp(req));
  return uid ? users.find(u => u.id === uid) || null : null;
}
const isFull = u => !!(u && u.approved && hasAccess(u));   // полный доступ: одобрен и срок доступа не кончился
const isAdmin = u => !!(u && u.approved && u.role === "admin");

// ---------- email: письмо с кодом подтверждения (SMTP или тестовый режим) ----------
// SMTP не задан (SMTP_HOST/SMTP_USER/SMTP_PASS в .env рядом с server.js) → письма пишутся
// в email_outbox.json и в консоль, а код показывается прямо на странице (тестовый режим).
function loadJsonFile(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } }
// запись через временный файл: при сбое посреди записи старый файл остаётся целым
function writeJsonAtomic(f, data) {
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}
const OUTBOX_FILE = path.join(ROOT, "email_outbox.json");

async function sendEmail(to, subject, text) {
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    const nodemailer = require("nodemailer");
    const tr = nodemailer.createTransport({
      host, port: Number(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_SECURE || "1") === "1",
      auth: { user, pass },
      connectionTimeout: 10_000,   // не держим страницу: почтовый сервер может быть недоступен
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    await tr.sendMail({ from: process.env.SMTP_FROM || user, to, subject, text, replyTo: process.env.SMTP_REPLYTO || undefined });
    return { sent: true };
  }
  const outbox = loadJsonFile(OUTBOX_FILE, []);
  outbox.push({ to, subject, text, created: Date.now() });
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox.slice(-100), null, 2));
  console.log(`[письмо → тестовый режим] ${to}: ${subject} — ${text}`);
  return { sent: false };
}

// ---------- уровни доступа (единая база: сайт, проценка, боты MAX/Telegram) ----------
// 1 гость · 2 зарегистрирован на сайте (этап 4) · 3 «свой поставщик» (одобрен здесь) ·
// 4 «близкий» (close_people.json или админ). Бот спрашивает уровень через /api/bot/*.
const CLOSE_FILE = path.join(ROOT, "close_people.json");
// читается при каждом обращении: правки файла действуют сразу, без перезапуска сервера
function loadClose() { try { return JSON.parse(fs.readFileSync(CLOSE_FILE, "utf8")) || []; } catch (e) { return []; } }

function normPhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d.length === 11 && d[0] === "7" ? d : "";
}

function isClose(u) {
  return !!u && loadClose().some(c =>
    (u.phone && c.phone && normPhone(c.phone) === normPhone(u.phone)) ||
    (u.max_id && String(c.max_id) === String(u.max_id)) ||
    (u.telegram_id && String(c.telegram_id) === String(u.telegram_id)));
}
function levelOf(u) {
  if (!u) return 1;
  if (u.role === "admin") return 4;   // директор — полная проценка
  if (u.l3) return 3;                 // подал заявку на Проценку — своя страница (свои поставщики)
  if (isLevel4(u)) return 4;          // близкий с галочкой «Четвёртый уровень» — моя проценка
  if (u.approved) return 2;
  return 1;
}
// 4-й уровень: близкий (5-й уровень) с галочкой «Четвёртый уровень» в кабинете
// или из прежнего списка близких (close_people.json)
function isLevel4(u) {
  if (!u) return false;
  if (isClose(u)) return true;
  const p = loadOrgPeople().find(p =>
    (p.login && String(p.login).toLowerCase() === String(u.login).toLowerCase()) ||
    (u.phone && p.phone && normPhone(p.phone) === normPhone(u.phone)) ||
    (u.max_id && p.max_id && String(u.max_id) === String(u.max_id)) ||
    (u.telegram_id && p.telegram_id && String(u.telegram_id) === String(u.telegram_id)));
  return !!(p && p.level4);
}

// ---------- платный доступ к проценке: срок в днях ----------
// users.access_until: время окончания (мс; последний день — до 23:59) или "unlimited" — бессрочно.
// Дни считаются календарные: выставили 30 → сегодня «30», завтра «29»… Админ и «близкие» — без срока.
const DAY_MS = 86400e3;
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function accessUntilFor(days) { return startOfDay(Date.now()) + Math.max(0, days) * DAY_MS - 1; }  // 0 → вчера, закрыт
function accessInfo(u) {
  if (!u) return { unlimited: false, days: 0, until: null };
  if (u.role === "admin" || isClose(u)) return { unlimited: true, days: null, until: null, auto: true };
  if (u.access_until === "unlimited") return { unlimited: true, days: null, until: null };
  const until = Number(u.access_until) || 0;
  const days = until >= Date.now() ? Math.floor((until - startOfDay(Date.now())) / DAY_MS) + 1 : 0;
  return { unlimited: false, days, until: until || null };
}
function hasAccess(u) { const a = accessInfo(u); return a.unlimited || a.days > 0; }
const accessText = a => a.unlimited ? "бессрочно" : String(a.days);

// ---------- органайзер: доступ только у «5-го уровня» (organizer_people.json) ----------
// Файл правится руками, читается при каждом обращении — состав действует сразу, без перезапуска.
// Запись: { "имя": "…", "login": "…", "phone": "+7…", "max_id": "…", "telegram_id": "…" } —
// совпадения по любому из полей; пустой список = органайзер закрыт для всех.
const ORG_FILE = path.join(ROOT, "organizer_people.json");
function loadOrgPeople() {
  try { return JSON.parse(fs.readFileSync(ORG_FILE, "utf8")) || []; }
  catch (e) { return []; }
}
function orgAccess(u) {
  if (!u) return false;
  return loadOrgPeople().some(p =>
    (p.login && String(p.login).toLowerCase() === String(u.login).toLowerCase()) ||
    (u.phone && p.phone && normPhone(p.phone) === normPhone(u.phone)) ||
    (u.max_id && p.max_id && String(p.max_id) === String(u.max_id)) ||
    (u.telegram_id && p.telegram_id && String(p.telegram_id) === String(u.telegram_id)));
}
// локальная дата «ГГГГ-ММ-ДД» (автоперенос и «сегодня» считаются по ней)
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// бот-API только с ключом: без BOT_API_KEY любой мог бы привязать себя к чужому аккаунту.
// Для локальной отладки без ключа — BOT_API_OPEN=1 (на VPS не включать).
function botKeyOk(req) {
  const k = process.env.BOT_API_KEY || "";
  if (!k) return process.env.BOT_API_OPEN === "1";
  const got = String(req.headers["x-bot-key"] || "");
  return got.length === k.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(k));
}
if (!process.env.BOT_API_KEY) console.warn("⚠️  BOT_API_KEY не задан — бот-API (/api/bot/*, /api/question) закрыто");
const COOKIE_SECURE = /^https:/.test(process.env.BASE_URL || "") ? "; Secure" : "";

// скидка за приглашения: каждые 10 приглашённых → 2%, максимум 10%
function invitedCountFor(tid, transport) { return DB.referrals.countBy(tid, transport); }

// ---------- поставщик по локальному прайс-листу (CSV/TSV/TXT/XLSX) ----------
const PL_CACHE = new Map(); // path -> {mtime, rows}
function normCode(s) { return String(s || "").toUpperCase().replace(/[\s\-\./]/g, ""); }
function decodeBuf(buf) {
  let s = buf.toString("utf8");
  if (/\uFFFD/.test(s)) { try { s = new TextDecoder("windows-1251").decode(buf); } catch (e) {} }
  return s;
}
function detectDelim(line) {
  const cands = [";", "\t", ",", "|"];
  let best = ";", bestN = -1;
  for (const d of cands) { const n = line.split(d).length; if (n > bestN) { bestN = n; best = d; } }
  return best === "\\t" ? "\t" : best;
}
function splitLine(line, d) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === d && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
const COL_HINTS = {
  code: ["артикул", "арт", "код", "номер", "code", "part", "oem", "кат"],
  brand: ["бренд", "производ", "brand", "maker", "фирм", "марка"],
  name: ["наимен", "назван", "описан", "name", "опис", "товар", "desc"],
  price: ["цена", "price", "стоим"],
  amount: ["кол", "налич", "ост", "шт", "qty", "остат"],
  term: ["срок", "достав", "дн", "day"],
  warehouse: ["склад", "warehouse", "город"]
};
function guessCols(cells) {
  const cols = {};
  cells.forEach((h, i) => {
    const lo = String(h).toLowerCase().trim();
    for (const [k, hints] of Object.entries(COL_HINTS)) {
      if (cols[k] === undefined && hints.some(x => lo.includes(x))) cols[k] = i;
    }
  });
  return cols;
}
// Прайс-листы лежат только в procenka/prices/: путь из интерфейса считается от этой папки,
// выйти за её пределы нельзя (иначе через «прайс» читались бы любые файлы сервера).
const PRICES_DIR = path.join(ROOT, "prices");
const PRICE_EXT = [".csv", ".tsv", ".txt", ".xlsx", ".xls"];
function pricePath(p) {
  const rel = String(p || "").trim().replace(/^prices[\/\\]/, "");
  const full = path.resolve(PRICES_DIR, rel);
  if (!rel || !full.startsWith(PRICES_DIR + path.sep)) throw new Error("Прайс должен лежать в папке procenka/prices — укажите имя файла");
  if (!PRICE_EXT.includes(path.extname(full).toLowerCase())) throw new Error("Формат прайса: " + PRICE_EXT.join(", "));
  return full;
}
function parsePriceFile(p) {
  p = pricePath(p);
  if (!fs.existsSync(p)) throw new Error("Прайс-файл не найден в procenka/prices: " + path.basename(p));
  const st = fs.statSync(p);
  const c = PL_CACHE.get(p);
  if (c && c.mtime === st.mtimeMs) return c;
  const buf = fs.readFileSync(p);
  let grid = [];
  const ext = path.extname(p).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buf, { codepage: 1251 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }).map(r => (r || []).map(x => String(x == null ? "" : x).trim()));
  } else {
    const text = decodeBuf(buf);
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) throw new Error("Прайс-файл пуст: " + p);
    const d = detectDelim(lines[0]);
    grid = lines.map(l => splitLine(l, d));
  }
  let cols = guessCols(grid[0] || []);
  let header = cols.code !== undefined;
  if (!header) cols = { code: 0, brand: 1, name: 2, price: 3, amount: 4, term: 5, warehouse: 6 };
  const g = (r, k) => (cols[k] !== undefined ? String(r[cols[k]] == null ? "" : r[cols[k]]).trim() : "");
  const rows = grid.slice(header ? 1 : 0).filter(r => g(r, "code")).map(r => ({
    brand: g(r, "brand"), code: g(r, "code"), name: g(r, "name"),
    price: parseFloat(String(g(r, "price")).replace(/\s/g, "").replace(",", ".")) || 0,
    amount: parseInt(String(g(r, "amount")).replace(/\D/g, ""), 10) || 0,
    term: parseInt(String(g(r, "term")).replace(/\D/g, ""), 10) || null,
    warehouse: g(r, "warehouse"), nc: normCode(g(r, "code"))
  }));
  if (!rows.length) throw new Error("В прайсе не найдено строк с артикулом (колонки определены: " + JSON.stringify(cols) + ")");
  const entry = { mtime: st.mtimeMs, rows, cols, header, total: rows.length };
  PL_CACHE.set(p, entry);
  return entry;
}
const pricelist = {
  async brands(sup, code) {
    const e = parsePriceFile(sup.priceFile.path);
    const nc = normCode(code);
    const seen = new Map();
    for (const r of e.rows.filter(r => r.nc === nc)) {
      const k = r.brand.toLowerCase();
      if (k && !seen.has(k)) seen.set(k, { code: r.code, brand: r.brand, pid: null, name: r.name });
    }
    return [...seen.values()];
  },
  async search(sup, code, brandInfo) {
    const e = parsePriceFile(sup.priceFile.path);
    const nc = normCode(code);
    let rows = e.rows.filter(r => r.nc === nc);
    if (brandInfo.brand) rows = rows.filter(r => r.brand.toLowerCase() === brandInfo.brand.toLowerCase());
    return rows.map(r => ({
      supplier: sup.name, brand: r.brand, code: r.code, name: r.name,
      term: r.term, price: r.price, amount: r.amount,
      warehouse: r.warehouse || "по прайсу", dealer: false, ret: false, isCross: false
    }));
  }
};

// --- Поставщика (api.sup04.example): поиск в 2 этапа PreProboy (бренды) → Proboy (предложения) ---
// Доступы: логин/пароль от online.sup04.example в полях «Логин»/«Пароль» поставщика.
// Каждый запрос списывает «пробой» из квоты партнёра (как на online.sup04.example).
// OS: 1 — склад Поставщика, 2 — в пути, 3 — склад партнёрской сети (ПС).
const SUP04_OS = { 1: "Склад Поставщика", 2: "В пути", 3: "Склад ПС" };
function sup04Call(action, sup, body) {
  return fetchJSON(`https://api.sup04.example/API.asmx/${action}`, {
    "Content-Type": "application/json",
    login: sup.login || "", password: sup.password || ""
  }, "POST", body);
}
const sup04 = {
  async brands(sup, code) {
    const r = await sup04Call("PreProboy", sup, { article: code });
    if (r.status !== 200 || !Array.isArray(r.data)) {
      throw new Error("Поставщика: " + String(r.text || "нет ответа").slice(0, 80));
    }
    return r.data.map(b => ({
      code: b.article || code, brand: b.brand || "", name: b.name || "",
      pid: [b.brand, b.article].filter(Boolean).join("|")
    }));
  },
  async search(sup, code, brandInfo, crosses) {   // API возвращает и замены других брендов — фильтруем по режиму
    const r = await sup04Call("Proboy", sup, { article: code, brand: brandInfo.brand || "" });
    if (r.status !== 200 || !Array.isArray(r.data)) {
      throw new Error("Поставщика: " + String(r.text || "нет ответа").slice(0, 80));
    }
    const want = brandKey(brandInfo.brand || ""), wantCode = normCode(code);
    return r.data.map(o => ({
      supplier: sup.name,
      brand: o.Producer || brandInfo.brand || "",
      code: o.Article || code,
      name: String(o.Nomenclature || "").slice(0, 200),
      price: parseFloat(o.Price) || 0,
      amount: parseInt(o.ShowedQuantity, 10) || 0,
      term: parseInt(o.DeliveryPeriod, 10) || 0,
      warehouse: [SUP04_OS[o.OS] || "", o.StockName || ""].filter(Boolean).join(" · "),
      isCross: brandKey(o.Producer || "") !== want || normCode(o.Article || "") !== wantCode
    })).filter(x => x.price > 0 && (crosses || !x.isCross));
  }
};

// --- Поставщик SOAP v2 (описание и адрес сервиса — в записи поставщика) ---
// Два сервиса из их набора: Security2 (вход по логину/паролю кабинета → HashSession) и PartsRemains2
// («Остатки на складах» — цены, количества, склады, бренды-замены). Каталог (Search2) для проценки
// не используется — в нём нет цен. Сессия кэшируется; при протухании — повторный вход (один раз).
// Грабли: в корне их сервера лежит старая версия сервисов — работаем только с /v2; у их «поиска»
// код 301 может означать обычное «нет позиций» — см. документацию поставщика.
const SUP15_BASE = process.env.SUP15_API_URL || "https://sup15.example/v2";
const sup15Ns = "xmlns:tem=\"http://tempuri.org/\" xmlns:req=\"http://schemas.datacontract.org/2004/07/Omega.Service.Infrastructure.Requests\"";
let sup15Session = { hash: "", ts: 0 };
function sup15Esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function sup15Val(block, tag) {
  const m = block.match(new RegExp("<a:" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</a:" + tag + ">"));
  return m ? m[1].trim() : "";
}
async function sup15Call(svc, action, inner) {
  const body = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ${sup15Ns}><soap:Header/><soap:Body><tem:${action}><tem:request>${inner}</tem:request></tem:${action}></soap:Body></soap:Envelope>`;   // БЕЗ XML-декларации: их сервис на неё отвечает пустотой
  return fetchJSON(`${SUP15_BASE}/${svc}`, { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"http://tempuri.org/I${svc.replace(".svc", "")}2/${action}"` }, "POST_RAW", body);   // интерфейсы v2 оканчиваются на «2» (ISecurity2, ISearch2, IPartsRemains2)
}
async function sup15Logon(sup) {   // вход: логин/пароль кабинета → HashSession
  const inner = `<req:Login>${sup15Esc(sup.login)}</req:Login><req:Password>${sup15Esc(sup.password)}</req:Password>`;
  const r = await sup15Call("Security.svc", "Logon", inner);
  const ok = (r.text.match(/<a:Success>([^<]*)</) || [])[1] === "true";
  const hash = (r.text.match(/<a:Data>([^<]*)</) || [])[1] || "";
  if (!ok || !hash) throw new Error("Поставщик: не удалось войти — проверьте логин и пароль от поставщика");
  sup15Session = { hash, ts: Date.now() };
  return hash;
}
async function sup15SessionHash(sup) {
  if (sup15Session.hash && Date.now() - sup15Session.ts < 20 * 60e3) return sup15Session.hash;
  return sup15Logon(sup);
}
// остатки по артикулу (+бренду): Remains (свои склады) + OutsideRemains (под заказ) — цены, количества, склады
async function sup15Remains(sup, opts) {
  const attempt = async hash => {
    // порядок полей — строго как в их схеме (сервис читает последовательно)
    const inner = `<req:HashSession>${hash}</req:HashSession>` +
      (opts.excludeAnalogs ? "<req:ExcludeAnalogs>true</req:ExcludeAnalogs>" : "") +
      (opts.brand ? `<req:ManufacturerName>${sup15Esc(opts.brand)}</req:ManufacturerName>` : "") +
      `<req:ManufacturerNumber>${sup15Esc(opts.number)}</req:ManufacturerNumber>` +
      `<req:ShowOutsideRemains>true</req:ShowOutsideRemains><req:ShowRetailRemains>true</req:ShowRetailRemains>`;
    return sup15Call("PartsRemains.svc", "GetPartsRemainsByManufacturerNumber", inner);
  };
  let hash = await sup15SessionHash(sup);
  let r = await attempt(hash);
  if (r.status !== 200 || !/<a:Success>true</.test(r.text || "")) {   // сессия могла протухнуть — повторный вход
    hash = await sup15Logon(sup);
    r = await attempt(hash);
  }
  if (r.status !== 200 || !/<a:Success>true</.test(r.text || "")) {
    const err = (r.text.match(/<b:string>([^<]*)</) || [])[1];
    throw new Error("Поставщик: " + (err || ("сервис не ответил (HTTP " + r.status + ")")).slice(0, 100));
  }
  const want = brandKey(opts.brand || ""), wantCode = normCode(opts.number);
  const rows = [];
  const push = (b, isOut) => {
    const price = parseFloat(sup15Val(b, "Price")) || 0;
    if (price <= 0) return;
    const brand = sup15Val(b, "ManufacturerName") || opts.brand || "";
    rows.push({
      supplier: sup.name, brand, code: sup15Val(b, "ManufacturerNumber") || opts.number,
      name: (sup15Val(b, "GoodsComment") || "").slice(0, 120),
      price, amount: parseInt(sup15Val(b, "Quantity")) || 0,
      term: isOut ? (Math.ceil(parseInt(sup15Val(b, "DeliveryTime"), 10) / 24) || null)
                  : (() => { const d = sup15Val(b, "ApproximateIncomeDateInFreeStatus"); return d ? Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400e3)) || 1 : 0; })(),
      warehouse: [sup15Val(b, "StorageName"), sup15Val(b, "StoragePosition")].filter(Boolean).join(" · "),
      dealer: false, ret: sup15Val(b, "IsNotRefundable") !== "true",
      isCross: brandKey(brand) !== want || normCode(sup15Val(b, "ManufacturerNumber")) !== wantCode
    });
  };
  for (const b of (r.text.match(/<a:GoodsUnitRemains>[\s\S]*?<\/a:GoodsUnitRemains>/g) || [])) push(b, false);
  for (const b of (r.text.match(/<a:OutsideGoodsUnitRemains>[\s\S]*?<\/a:OutsideGoodsUnitRemains>/g) || [])) push(b, true);
  return rows;
}
const sup15 = {
  async brands(sup, code) {   // их сервис требует бренд в запросе — подбор бренда по артикулу не делает (как некоторые другие поставщики)
    const e = new Error("цены и остатки по коду и бренду, подбор бренда не используется");
    e.noBrands = true;
    throw e;
  },
  async search(sup, code, brandInfo, crosses) {   // ExcludeAnalogs — только искомый бренд в точном режиме
    const rows = await sup15Remains(sup, { number: brandInfo.code || code, brand: brandInfo.brand || "", excludeAnalogs: !crosses });
    return rows.filter(r => crosses || !r.isCross);
  }
};

// --- Поставщика, новый API v1  ---
// Ключ — поле apiKey целиком, «префикс:ключ», в заголовке X-API-Key. Договор и филиал
// (X-Agreement-ID / X-Filial-ID) по умолчанию берутся из API-доступа; при необходимости —
// поля agreementId / filialId поставщика в suppliers.json. Лимит портала — 60 запросов в минуту.
// На подозрительный поток запросов портал отвечает HTML-страницей «Вы человек?» (капча):
// тогда запросы к нему приостанавливаются на MV_PAUSE_MIN минут, чтобы не продлевать блокировку.
const MV_BASE = process.env.SUP05_API_URL || "https://api.sup05.example/v1";
const MV_PAUSE_MIN = 15;
let mvPausedUntil = 0;
async function mvGet(sup, path, params) {
  if (Date.now() < mvPausedUntil) {
    const t = new Date(mvPausedUntil).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    throw new Error(`запросы приостановлены до ${t}: портал попросил пройти проверку «Вы человек?»`);
  }
  const qs = new URLSearchParams(params).toString();
  const headers = { "X-API-Key": sup.apiKey, "Accept": "application/json" };
  if (sup.agreementId) headers["X-Agreement-ID"] = sup.agreementId;
  if (sup.filialId) headers["X-Filial-ID"] = sup.filialId;
  const r = await fetchJSON(`${MV_BASE}${path}?${qs}`, headers);
  if (!r.data) {
    if (/Вы человек|captcha/i.test(r.text || "")) {
      mvPausedUntil = Date.now() + MV_PAUSE_MIN * 60e3;
      console.warn(`Поставщика: проверка «Вы человек?» — запросы приостановлены на ${MV_PAUSE_MIN} минут`);
      throw new Error(`портал попросил пройти проверку «Вы человек?» — запросы приостановлены на ${MV_PAUSE_MIN} минут`);
    }
    throw new Error("неожиданный ответ портала (HTTP " + r.status + ")");
  }
  if (r.status === 429) throw new Error("превышен лимит портала — 60 запросов в минуту, повторите позже");
  if (r.data.error) throw new Error((r.data.error.message || r.data.error.code || "ошибка") + (r.status === 401 ? " — проверьте ключ в «Доступах API» портала" : ""));
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  return r.data.data;
}
function mvRow(sup, it, isCross) {
  const flags = Array.isArray(it.flags) ? it.flags : [];
  return {
    supplier: sup.name, brand: it.brand || "", code: it.number || "",
    name: String(it.description || "").slice(0, 120),
    term: it.delivery_period != null ? Math.ceil(+it.delivery_period / 24) : null,  // часы → дни
    price: +it.price || 0, amount: +it.availability || 0,
    warehouse: it.stock_name || "",
    dealer: flags.includes("oesupl"), ret: !flags.includes("noreturn"), isCross
  };
}
const sup05 = {
  async brands(sup, code) {
    const d = await mvGet(sup, "/search/brands", { number: code, avail: 0 });
    return (Array.isArray(d) ? d : []).flatMap(x => x.positions || [])
      .map(p => ({ code: p.number || code, brand: p.brand || "", name: p.description || "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const d = await mvGet(sup, "/search/articles", { number: brandInfo.code || code, brand: brandInfo.brand, without_analogs: crosses ? 0 : 1, hide_certif: 1 }) || {};
    const rows = (d.src || []).map(it => mvRow(sup, it, false));
    if (crosses) for (const it of [...(d.trust || []), ...(d.cross || [])]) rows.push(mvRow(sup, it, true));
    return rows.filter(r => r.price > 0);
  }
};

// --- Сайт без API — «через браузер»: scraper/browser_scan.py (Selenium + Chrome → снимок и текст → ИИ) ---
// Поставщик: adapter "browser", searchUrl — адрес страницы поиска с {code} на месте артикула.
// Профиль Chrome — свой у каждого поставщика (browser_profiles/<id>): в него один раз входят
// в кабинет кнопкой «Войти на сайт» в «Мои поставщики», вход сохраняется.
// Открытия страниц идут по одному; результат по артикулу держится BROWSER_TTL — и для «возможных
// запросов», и для выдачи используется одно открытие. Капча на сайте → поставщик на паузе 30 минут.
const { spawn } = require("child_process");
const SCRAPER_PY = process.env.SCRAPER_PYTHON || path.join(ROOT, "..", "bot", "venv", "bin", "python");
const SCRAPER_SCRIPT = path.join(ROOT, "scraper", "browser_scan.py");
const PROFILES_DIR = path.join(ROOT, "browser_profiles");
const BROWSER_TTL = 10 * 60e3, BROWSER_PAUSE = 30 * 60e3, BROWSER_TIMEOUT = 300e3;   // запасной ИИ (домашний LM Studio) отвечает медленно
const browserCache = new Map();   // id|артикул → { ts, value: Promise<{offers, page, note}> }
const browserPaused = {};         // id → до какого времени не открывать сайт
let browserQueue = Promise.resolve();
function profileOf(sup) { return path.join(PROFILES_DIR, String(sup.id).replace(/[^\w-]/g, "")); }
function runScraper(sup, code) {
  return new Promise((resolve, reject) => {
    const url = sup.searchUrl.replace(/\{code\}/g, encodeURIComponent(code));
    const p = spawn(SCRAPER_PY, ["-I", SCRAPER_SCRIPT, "scan"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("сайт не ответил за 3 минуты")); }, BROWSER_TIMEOUT);
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("error", e => { clearTimeout(timer); reject(new Error("не запускается Python для браузера: " + e.message)); });
    p.on("close", () => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(out.trim().split("\n").pop()); } catch (e) {}
      if (!r) return reject(new Error("браузер не вернул результат: " + (err || out).trim().slice(-200)));
      if (!r.ok) return reject(new Error(r.error || "ошибка браузера"));
      resolve(r);
    });
    p.stdin.end(JSON.stringify({ url, code, profile: profileOf(sup), wait: sup.wait || 4,
      click: String(sup.clickAfter || "").slice(0, 80) }));
  });
}
function browserScan(sup, code) {
  if (!sup.searchUrl) return Promise.reject(new Error("не задан адрес страницы поиска (с {code})"));
  if (Date.now() < (browserPaused[sup.id] || 0)) {
    const t = new Date(browserPaused[sup.id]).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return Promise.reject(new Error(`сайт попросил пройти проверку «вы не робот» — пауза до ${t}`));
  }
  const key = sup.id + "|" + normCode(code);
  const hit = browserCache.get(key);
  if (hit && Date.now() - hit.ts < BROWSER_TTL) return hit.value;
  const value = (browserQueue = browserQueue.catch(() => {}).then(() => runScraper(sup, code))).then(r => {
    if (r.page === "captcha") {
      browserPaused[sup.id] = Date.now() + BROWSER_PAUSE;
      console.warn(`${sup.name}: сайт показал проверку «вы не робот» — пауза 30 минут`);
      throw new Error("сайт попросил пройти проверку «вы не робот» — пауза 30 минут");
    }
    if (r.page === "login") throw new Error("нужен вход в кабинет поставщика — «Мои поставщики» → «Войти на сайт»");
    return r;
  });
  browserCache.set(key, { ts: Date.now(), value });
  value.catch(() => browserCache.delete(key));
  if (browserCache.size > 300) browserCache.delete(browserCache.keys().next().value);
  return value;
}
function browserLogin(sup) {
  const site = /^https?:/.test(sup.site || "") ? sup.site : new URL(sup.searchUrl.replace("{code}", "x")).origin;
  const p = spawn(SCRAPER_PY, ["-I", SCRAPER_SCRIPT, "login", "--profile", profileOf(sup), "--url", site], { detached: true, stdio: "ignore" });
  p.unref();
}
// искомый артикул или аналог — решаем сами по номеру (без пробелов и знаков), пометке ИИ не доверяем
const browserIsReq = (o, code) => o.code ? normCode(o.code) === normCode(code) : !!o.is_requested;
const browser = {
  async brands(sup, code) {
    const r = await browserScan(sup, code);
    const seen = new Map();
    for (const o of r.offers) {
      const k = brandKey(o.brand);
      if (browserIsReq(o, code) && k && !seen.has(k)) seen.set(k, { code: o.code || code, brand: o.brand, name: o.name, pid: "" });
    }
    return [...seen.values()];
  },
  async search(sup, code, brandInfo, crosses) {
    const r = await browserScan(sup, code);
    const want = brandKey(brandInfo.brand);
    return r.offers
      .map(o => ({ o, req: browserIsReq(o, code) && brandKey(o.brand) === want }))
      .filter(x => x.req || (crosses && !browserIsReq(x.o, code)))
      .map(({ o, req }) => ({ supplier: sup.name, brand: o.brand, code: o.code, name: o.name, term: o.term, price: o.price,
                              amount: o.amount, warehouse: o.warehouse, dealer: false, ret: false, isCross: !req }));
  }
};

// --- SUP06: API по логину и паролю (sup06.example) ---
// auth = md5(логин + md5(пароль)) в GET-параметре; цены — по договору agreement_id: берётся из
// api-get_user_context (первый договор) или из поля agreementId поставщика; запоминается на сутки.
// Кроссы — api-search_crosses: работает, только если в кабинете включено «Разрешить поиск кроссов».
const ABS_BASE = process.env.SUP06_API_URL || "https://sup06.example";
const sup06Agreements = {};  // id поставщика → { ts, id }
function sup06Auth(sup) {
  const md5 = s => crypto.createHash("md5").update(String(s), "utf8").digest("hex").toLowerCase();
  return md5(String(sup.login || "") + md5(sup.password || ""));
}
async function sup06Get(sup, method, params) {
  const qs = new URLSearchParams({ auth: sup06Auth(sup), ...params }).toString();
  const r = await fetchJSON(`${ABS_BASE}/api-${method}?${qs}`, { Accept: "application/json" });
  if (r.status === 403) throw new Error("ошибка авторизации — проверьте логин и пароль от sup06.example");
  if (!r.data) throw new Error("неожиданный ответ (HTTP " + r.status + ")");
  return r.data;
}
async function sup06Agreement(sup) {
  if (sup.agreementId) return sup.agreementId;
  const c = sup06Agreements[sup.id];
  if (c && Date.now() - c.ts < 86400e3) return c.id;
  const d = await sup06Get(sup, "get_user_context", {});
  const list = Array.isArray(d.user_agreements) ? d.user_agreements : Object.values(d.user_agreements || {});
  if (!list.length) throw new Error("у пользователя нет договоров (get_user_context)");
  sup06Agreements[sup.id] = { ts: Date.now(), id: list[0].ua_id };
  return list[0].ua_id;
}
function sup06Rows(sup, d, forceCross) {
  if (d.status && d.status !== "OK") throw new Error(String(d.status).slice(0, 150));
  const list = Array.isArray(d.data) ? d.data : Object.values(d.data || {});
  return list.filter(it => +it.price > 0).map(it => {
    const dur = String(it.delivery_duration ?? "").match(/\d+/g);   // «2» или «1-3» рабочих дня → верхняя граница
    const ret = it.return_type && String(it.return_type.name || "");
    return {
      supplier: sup.name, brand: it.brand || "", code: it.article || "",
      name: String(it.product_name || "").slice(0, 120),
      term: dur ? +dur[dur.length - 1] : null,
      price: +it.price, amount: +it.quantity || 0,
      warehouse: (it.warehouse_name || "") + (+it.by_request ? " · под заказ" : ""),
      dealer: false, ret: ret ? !/невозможен/i.test(ret) : false,
      isCross: forceCross || String(it.is_cross) === "1"
    };
  });
}
const sup06 = {
  async brands(sup, code) {
    const d = await sup06Get(sup, "brands", { article: code });
    const list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : Object.values(d.data || {}));
    if (d.status && d.status !== "OK" && !list.length) throw new Error(String(d.status).slice(0, 150));
    return list.map(b => typeof b === "string" ? b : (b && (b.brand || b.name)) || "")
      .filter(Boolean).map(brand => ({ code, brand, name: "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const agreement_id = await sup06Agreement(sup);
    const p = { article: brandInfo.code || code, brand: brandInfo.brand, agreement_id, show_unavailable: 0, discounted: "include" };
    const rows = sup06Rows(sup, await sup06Get(sup, "search", p), false);
    if (crosses) {
      try { rows.push(...sup06Rows(sup, await sup06Get(sup, "search_crosses", p), true)); }
      catch (e) { console.warn(`${sup.name}: аналоги недоступны — ${e.message} (включите «Разрешить поиск кроссов» в настройках API кабинета)`); }
    }
    return rows;
  }
};

// --- SUP07: API v1.4 (api.sup07.example)  ---
// Ключ — GET-параметр secret. Бренды — /search/products?article; предложения — /search/crosses
// ?article&brand&replaces=0|1 (с заменами — аналоги одним запросом); остатки по складам — в products[].
const SUP07_BASE = process.env.SUP07_API_URL || "https://api.sup07.example";
async function sup07Get(sup, path, params) {
  const qs = new URLSearchParams({ secret: sup.apiKey, ...params }).toString();
  const r = await fetchJSON(`${SUP07_BASE}${path}?${qs}`, { Accept: "application/json" });
  if (r.status === 401 || r.status === 403) throw new Error("ключ API отклонён — проверьте API-ключ в «Разделе разработчика» кабинета");
  if (!r.data) throw new Error(/ddos|проверк|captcha/i.test(r.text || "") ? "защита сайта (DDoS-Guard) не пропустила запрос" : "неожиданный ответ (HTTP " + r.status + ")");
  const d = r.data;
  if (d && !Array.isArray(d) && (d.error || d.status === "error")) throw new Error(String(d.error || d.err || d.message || "ошибка").slice(0, 150));
  return Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (d.data ? Object.values(d.data) : Object.values(d)));
}
const sup07 = {
  async brands(sup, code) {
    const list = await sup07Get(sup, "/search/products", { article: code });
    return list.filter(x => x && x.brand)
      .map(x => ({ code: x.article || code, brand: x.brand, name: x.description || "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const want = { code: normCode(brandInfo.code || code), brand: brandKey(brandInfo.brand) };
    const list = await sup07Get(sup, "/search/crosses", { article: brandInfo.code || code, brand: brandInfo.brand, replaces: crosses ? 1 : 0 });
    const rows = [];
    for (const it of list) {
      // products — по документации массив, на деле объект { хеш: товар } — читаем оба вида
      const prods = it && it.products ? (Array.isArray(it.products) ? it.products : Object.values(it.products)) : [];
      if (!prods.length) continue;
      const isCross = !(normCode(it.article) === want.code && brandKey(it.brand) === want.brand);
      if (isCross && !crosses) continue;
      for (const p of prods) {
        if (!(+p.price > 0)) continue;
        rows.push({
          supplier: sup.name, brand: it.brand || "", code: it.article || "",
          name: String(it.description || p.description || "").slice(0, 120),
          term: p.delivery_time != null && p.delivery_time !== "" ? Math.ceil(+p.delivery_time / 24) : null,  // часы → дни
          price: +p.price, amount: +p.quantity || 0,
          warehouse: String(p.custom_warehouse_name || "") + (+p.sale ? " · уценка" : ""),
          dealer: !!+it.original, ret: String(p.allow_return) === "1", isCross
        });
      }
    }
    return rows;
  }
};

// --- SUP08: API v1 (sup08.example, описание — sup08.example/help-portal/api/v1) ---
// Ключ — заголовок Authorization. Бренды — /brands/?search_by_code; товары и остатки по складам —
// /items/?brand_id&search_by_code. Цена — cp (договорная), rrp — рекомендованная розница (запасная).
// Срока поставки в ответе нет. Метод кросс-товаров описан, но страница описания недоступна (404) —
// аналоги пока не запрашиваются.
const P24_BASE = process.env.SUP08_API_URL || "https://sup08.example/api/v1";
async function p24Get(sup, path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetchJSON(`${P24_BASE}${path}?${qs}`, { Authorization: sup.apiKey, Accept: "application/json" });
  if (r.status === 401 || r.status === 403) throw new Error("ключ API отклонён — проверьте ключ в кабинете sup08.example");
  if (!r.data) throw new Error("неожиданный ответ (HTTP " + r.status + ")");
  if (r.data.status && String(r.data.status).toLowerCase() !== "ok") throw new Error(String(r.data.message || r.data.error || r.data.status).slice(0, 150));
  return Array.isArray(r.data.data) ? r.data.data : [];
}
const sup08 = {
  async brands(sup, code) {
    const list = await p24Get(sup, "/brands/", { search_by_code: code });
    return list.filter(b => b && b.brand_name).map(b => ({ code, brand: b.brand_name, name: "", pid: String(b.brand_id) }));
  },
  async search(sup, code, brandInfo) {
    let brandId = brandInfo.pid;
    if (!brandId) {  // pid своего поставщика не пришёл — ищем бренд заново
      const b = (await this.brands(sup, code)).find(x => brandKey(x.brand) === brandKey(brandInfo.brand));
      if (!b) return [];
      brandId = b.pid;
    }
    const list = await p24Get(sup, "/items/", { brand_id: brandId, search_by_code: brandInfo.code || code });
    const rows = [];
    for (const it of list) {
      const item = it.item || {};
      for (const st of (it.stocks || [])) {
        const pr = st.prices || {};
        const price = +pr.cp || +pr.rrp || 0;
        if (!(price > 0)) continue;
        rows.push({
          supplier: sup.name, brand: (item.brand && item.brand.brand_name) || brandInfo.brand, code: item.item_vendor_code || code,
          name: String(item.item_title || "").slice(0, 120), term: null,
          price, amount: +st.quantity || 0, warehouse: st.stock_title || "",
          dealer: false, ret: false, isCross: normCode(item.item_vendor_code || code) !== normCode(brandInfo.code || code)
        });
      }
    }
    return rows;
  }
};

// --- SUP09 (sup09.example), шлюз api-gate.sup09.example v0.3.12  ---
// Ключ — заголовок ApiKey. Бренды — /v1/articleBrands?f&ac=1; предложения — /v1/filter?f&br&ac=1
// (склад, цена, остаток, срок в днях). Маска f — только цифры и заглавные латиница/кириллица.
// /v1/filter может вернуть и близкие позиции других брендов (аналоги) — точный артикул отделяем сами.
// Поле ошибки на деле — errorsText (в описании — errorText): читаем оба.
const SUP09_BASE = process.env.SUP09_API_URL || "https://api-gate.sup09.example";
const sup09Mask = s => String(s || "").toUpperCase().replace(/[^0-9A-ZА-Я]/g, "");
async function sup09Get(sup, path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetchJSON(`${SUP09_BASE}${path}?${qs}`, { ApiKey: sup.apiKey, "Content-Type": "application/json", Accept: "application/json" });
  if (r.status === 401) throw new Error("ключ API отклонён — проверьте ключ в кабинете sup09.example");
  if (!r.data) throw new Error("неожиданный ответ (HTTP " + r.status + ")");
  if (r.data.error) throw new Error(String(r.data.errorsText || r.data.errorText || "ошибка").replace(/\s+/g, " ").slice(0, 150));
  return Array.isArray(r.data.data) ? r.data.data : [];
}
const sup09 = {
  async brands(sup, code) {
    const list = await sup09Get(sup, "/v1/articleBrands", { f: sup09Mask(code), ac: 1 });
    return list.filter(b => typeof b === "string" && b.trim()).map(brand => ({ code, brand: brand.trim(), name: "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const want = { code: normCode(brandInfo.code || code), brand: brandKey(brandInfo.brand) };
    const list = await sup09Get(sup, "/v1/filter", { f: sup09Mask(brandInfo.code || code), br: brandInfo.brand, ac: 1 });
    return list.map(it => {
      const isCross = !(normCode(it.vendorcode) === want.code && brandKey(it.brand) === want.brand);
      return {
        supplier: sup.name, brand: it.brand || "", code: it.vendorcode || "",
        name: String(it.note || "").replace(/\s*\|\s*/g, " — ").replace(/\\/g, "").slice(0, 120),
        term: it.deliverytime !== undefined && it.deliverytime !== "" ? parseInt(it.deliverytime, 10) : null,
        price: parseFloat(it.price) || 0, amount: Math.floor(parseFloat(it.amount) || 0),
        warehouse: it.storeName || "", dealer: false, ret: false, isCross
      };
    }).filter(r => r.price > 0 && (crosses || !r.isCross));
  }
};

// --- SUP10: WebService ws1/service.asmx (наличие по коду и бренду)  ---
// Только наличие по коду + бренду: CodeBrandStockInfo — быстрая и без лимитов; аналоги и заказные
// позиции сервис принципиально не отдаёт. Логин = клиентский номер (sup.login), пароль = sup.password.
// Ответ XML: <Message>Ok|ошибка</Message> + <List><CodeBrandLine>… (StockQTY бывает «4+», «10+»).
const SUP10_BASE = process.env.SUP10_API_URL || "https://sup10.example/ws1/service.asmx";
function xmlVal(block, tag) {
  const m = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  return m ? m[1].trim() : "";
}
const sup10 = {
  async brands(sup, code) {
    // подбор бренда по коду — только через лимитируемый Code_Search (2000/сут), его не тратим:
    // отказ здесь ШТАТНЫЙ (флаг noBrands — в статусе строка серая, не красная), поиск всё равно идёт
    // с написанием от пользователя (Поставщик сам понимает синонимы брендов — см. описание API).
    const e = new Error("наличие по коду и бренду, подбор бренда не используется");
    e.noBrands = true;
    throw e;
  },
  async search(sup, code, brandInfo, crosses) {
    const body = new URLSearchParams({
      Code: normCode(brandInfo.code || code), Brand: (brandInfo.brand || "").trim(),
      ClientID: sup.login || "", Password: sup.password || "",
    }).toString();
    const r = await fetchJSON(`${SUP10_BASE}/CodeBrandStockInfo`,
      { "Content-Type": "application/x-www-form-urlencoded" }, "POST_RAW", body);
    if (r.status !== 200 || !r.text) throw new Error("сервис не ответил (HTTP " + r.status + ")");
    const msg = xmlVal(r.text, "Message");
    if (msg && !/^ok\b/i.test(msg)) throw new Error(msg.replace(/;\s*$/, "").slice(0, 150));
    const rows = [];
    for (const block of (r.text.match(/<CodeBrandLine>[\s\S]*?<\/CodeBrandLine>/g) || [])) {
      const qty = xmlVal(block, "StockQTY");
      rows.push({
        supplier: sup.name, brand: xmlVal(block, "Brand") || brandInfo.brand,
        code: xmlVal(block, "OrderCode") || brandInfo.code || code,
        name: xmlVal(block, "Name").slice(0, 120),
        term: +xmlVal(block, "DeliveryDelay") || 0,      // рабочих дней до выдачи со склада
        price: +xmlVal(block, "PriceRUR") || 0,
        amount: parseInt(qty, 10) || 0,
        warehouse: xmlVal(block, "StokName"),
        dealer: false, ret: true, isCross: false,
      });
    }
    return rows.filter(x => x.price > 0);
  }
};

// --- SUP11: REST API по логину и паролю (адрес сервиса — SUP11_API_URL) ---
// Адрес SUP11 зависит от сайта: у поставщика — sup11.example (SUP11_API_URL в .env).
// Аутентификация: userlogin + userpsw (md5-хэш пароля) в параметрах каждого запроса; логин и
// пароль — поля «Логин»/«Пароль» поставщика. Срок поставки — в часах, переводим в дни (вверх).
// Склад не отдаётся (только числовой код маршрута в supplierDescription) — колонку не заполняем.
// Внимание: search/brands отдаёт СЛОВАРЬ {ключ: {brand…}}, хотя в документации массив — читаем оба вида.
const SUP11_BASE = process.env.SUP11_API_URL || "https://sup11.example";
function sup11Get(sup, op, params) {
  const md5 = s => crypto.createHash("md5").update(String(s), "utf8").digest("hex").toLowerCase();
  const qs = new URLSearchParams({ userlogin: sup.login || "", userpsw: md5(sup.password || ""), ...params }).toString();
  return fetchJSON(`${SUP11_BASE}${op}?${qs}`, { Accept: "application/json" });
}
function sup11Err(r) {
  const code = r.data && r.data.errorCode;
  if (code === 102) return "ошибка авторизации — проверьте логин и пароль от поставщика";
  if (code === 103) return "доступ запрещён — включите пользователю права на API и проверьте IP-ограничения в кабинете поставщика";
  if (code === 104) return "сервис не признал адрес/доступы сайта — уточните адрес API в настройках кабинета поставщика";
  return "неожиданный ответ сервиса (HTTP " + r.status + (code ? ", код " + code : "") + ")";
}
function sup11List(r) {   // SUP11 отдаёт массив или словарь {ключ: позиция} — приводим к массиву
  if (r.status === 404 && r.data && r.data.errorCode === 301) return [];   // «объект не найден» — нет позиций по точному запросу; пустой результат, не ошибка
  if (!r.data || r.status !== 200) throw new Error(sup11Err(r));
  return Array.isArray(r.data) ? r.data : Object.values(r.data);
}
const sup11 = {
  async brands(sup, code) {
    return sup11List(await sup11Get(sup, "/search/brands", { number: code }))
      .map(b => ({ code: b.number || code, brand: b.brand || "", name: b.description || "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const r = await sup11Get(sup, "/search/articles", {
      number: normCode(brandInfo.code || code), brand: (brandInfo.brand || "").trim(),
      withOutAnalogs: crosses ? 0 : 1 });   // галочка «аналоги» снята — только точный артикул
    const want = brandKey(brandInfo.brand);
    return sup11List(r).filter(x => +x.price > 0).map(it => {
      const exact = brandKey(it.brand || "") === want &&
                    normCode(it.numberFix || it.number || "") === normCode(brandInfo.code || code);
      const hours = +it.deliveryPeriodMax || +it.deliveryPeriod || 0;
      const wh = v => (String(v || "").trim().match(/[^\d\s]/) ? String(v).trim() : "");   // «1425821» — код, не склад
      return {
        supplier: sup.name, brand: it.brand || "", code: it.numberFix || it.number || "",
        name: String(it.description || "").slice(0, 120),
        term: hours ? Math.ceil(hours / 24) : null,
        price: +it.price, amount: +it.availability || 0,
        warehouse: wh(it.supplierDescription) || wh(it.distributorCode),
        dealer: false, ret: !it.noReturn, isCross: !exact
      };
    });
  }
};

// --- REST API SearchService (общая платформа двух поставщиков): адрес сервиса — в записи поставщика ---
// Сервис одинаков за полем за поле; адрес сервиса — в поле apiUrl записи
// поставщика (у sup12.example — https://sup12.example), без него — адрес Поставщика (только punycode; поле «Сайт»
// у Поставщика — сайт кабинета, это НЕ адрес API).
// Авторизация Basic «логин:пароль кабинета» (поля «Логин»/«Пароль» поставщика) в каждом запросе.
// Срок поставки — в часах → дни (вверх). Маршрут поставщика (SupplierName, «МСК 28», «РНД 1»…)
// показываем в колонке «Склад». У Поставщика заменяет старый «браузер» (Chrome + ИИ) — падал,
// когда страница не влезала в контекст модели.
// ОСОБЕННОСТИ СЕРВИСА: ошибки приходят с HTTP 200 и полем Error (проверяем его, не код HTTP);
// withoutTransit обязателен и понимает только true/false; у транзитных поставщиков дневной лимит —
// при его исчерпании повторяем запрос без транзитных (транзитные не критичны, свой склад остаётся).
const AVTS_BASE = process.env.SUP12_API_URL || "https://sup12.example";
function sup12Get(sup, path) {
  const base = String(sup.apiUrl || "").trim().replace(/\/+$/, "") || AVTS_BASE;
  const auth = Buffer.from(`${sup.login || ""}:${sup.password || ""}`).toString("base64");
  return fetchJSON(`${base}${path}`, { Accept: "application/json", Authorization: "Basic " + auth });
}
function sup12Err(d) {
  const e = String(d && d.Error || "");
  if (/Login and Password are wrong/i.test(e)) return "нет авторизации — у Поставщика не включён доступ к API для этого аккаунта/IP";
  if (/Username not found|incorrect password/i.test(e)) return "ошибка авторизации — проверьте логин и пароль от Поставщика";
  return (e || "неизвестная ошибка сервиса").slice(0, 150);
}
async function sup12List(sup, op, params) {
  const call = async withoutTransit => sup12Get(sup, "/SearchService/" + op + "?" +
    new URLSearchParams({ ...params, withoutTransit: withoutTransit ? "true" : "false" }).toString());
  let r = await call(false);                                  // сначала с транзитными поставщиками
  if (r.status === 200 && r.data && /транзит/i.test(String(r.data.Error || ""))) {
    r = await call(true);                                     // «нет транзитных» — дневной лимит: без транзитных
  }
  if (r.status !== 200 || !r.data) throw new Error("сервис не ответил (HTTP " + r.status + ")");
  if (r.data.Error) throw new Error(sup12Err(r.data));
  return Array.isArray(r.data) ? r.data : Object.values(r.data || {});
}
const sup12 = {
  async brands(sup, code) {
    return (await sup12List(sup, "GetBrands", { article: code }))
      .map(b => ({ code: b.Article || code, brand: b.Brand || "", name: b.Description || "", pid: "" }));
  },
  async search(sup, code, brandInfo, crosses) {
    const list = await sup12List(sup, "GetParts", {
      article: normCode(brandInfo.code || code), brand: (brandInfo.brand || "").trim() });
    const want = brandKey(brandInfo.brand), wantCode = normCode(brandInfo.code || code);
    return list.filter(x => +x.CostSale > 0 && (crosses || (x.IsAnalog !== true &&
        brandKey(x.Brand || "") === want && normCode(x.Article || "") === wantCode)))
      .map(it => {
        const hours = +it.SupplierTimeMax || +it.SupplierTimeMin || 0;
        const wh = String(it.SupplierName || "").trim();
        return {
          supplier: sup.name, brand: it.Brand || "", code: it.Article || "",
          name: String(it.Description || "").slice(0, 120),
          term: hours ? Math.ceil(hours / 24) : null,
          price: +it.CostSale, amount: +it.Count || 0,
          warehouse: wh.match(/[^\d\s]/) ? wh : "",
          dealer: false, ret: it.IsAllowDiscountRefund !== false,
          isCross: crosses ? it.IsAnalog !== false : false
        };
      });
  }
};

const ADAPTERS = { sup01, "sup01web": sup01Web, sup02, sup03, demo, pricelist, sup04, sup05, browser, sup06, sup07, sup08, sup09, sup10, sup11, sup12, sup15 };
function adapterOf(sup) { return ADAPTERS[sup.adapter] || null; }
// ключ не нужен сайт-адаптерам, демо и прайсам; sup10 — логин+пароль (как Поставщик)
const NO_KEY_NEEDED = s => s === "demo" || s === "sup01web" || s === "pricelist" || s === "sup04" || s === "browser" || s === "sup06" || s === "sup10" || s === "sup11" || s === "sup12" || s === "sup15";  // у части адаптеров логин+пароль вместо ключа

// ---------- органайзер: API задач (только 5-й уровень, раздел 8 ТЗ) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REC_RE = /^(|daily|weekly|monthly|yearly)$/;   // повтор задачи (п.3 ТЗ)

// --- файлы органайзера: Organizer/files/<ГГГГ-ММ>/… (раздел 9.4) ---
const ORG_FILES = path.join(ROOT, "..", "Organizer", "files");
function orgPath(rel) { // выход за папку файлов запрещён
  const full = path.resolve(ORG_FILES, rel);
  if (full !== path.resolve(ORG_FILES) && !full.startsWith(path.resolve(ORG_FILES) + path.sep))
    throw new HttpError(400, "Путь вне папки файлов органайзера");
  return full;
}
const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
function orgSave(owner, name, buf, opts = {}) {
  const safe = String(name || "файл").replace(/[\/\\:*?"<>|\r\n]/g, "_").slice(0, 120).trim() || "файл";
  const rel = `${todayStr().slice(0, 7)}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
  fs.mkdirSync(path.dirname(orgPath(rel)), { recursive: true });
  fs.writeFileSync(orgPath(rel), buf);
  const ext = path.extname(safe).toLowerCase();
  const kind = IMG_EXT.includes(ext) ? "image" : ext === ".pdf" ? "pdf" : ext === ".txt" ? "txt" : "doc";
  return DB.oFiles.add({ owner, note_id: opts.note_id || null, task_id: opts.task_id || null,
    name: safe, stored: rel, kind, size: buf.length, created_at: new Date().toISOString() });
}
function orgRead(f) { return fs.readFileSync(orgPath(f.stored)); }

// --- сканы в сборке: страницы приходят по одной, потом собираются в задачу книжки/PDF ---
const SCAN_PAGES = new Map(); // токен → Buffer (чистятся раз в час)
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, v] of SCAN_PAGES) if (v.ts < cut) SCAN_PAGES.delete(k); }, 3600e3).unref();

// --- минимальный PDF из JPEG-страниц (без внешних библиотек) ---
// страницы целиком, контент — масштабирование на весь лист
function buildPdf(pages) { // pages: [{buf (jpeg), w, h}]
  const enc = s => Buffer.from(s, "binary");
  const objStart = i => `${i} 0 obj\n`;
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${5 + i * 3} 0 R`).join(" ")}] >>`;
  pages.forEach((p, i) => {
    const pg = 5 + i * 3, im = pg + 1, ct = pg + 2;
    objs[pg] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /XObject << /I${i} ${im} 0 R >> >> /Contents ${ct} 0 R >>`;
    objs[im] = { stream: p.buf, dict: `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.buf.length} >>` };
    const cont = `q ${p.w} 0 0 ${p.h} 0 0 cm /I${i} Do Q`;
    objs[ct] = { stream: enc(cont), dict: `<< /Length ${cont.length} >>` };
  });
  const head = "%PDF-1.4\n";
  let out = head, pos = head.length; const xref = [];
  for (let i = 1; i < objs.length; i++) {
    if (!objs[i]) continue;
    xref[i] = pos;
    const o = objs[i];
    if (typeof o === "string") { const s = `${objStart(i)}${o}\nendobj\n`; out += s; pos += s.length; }
    else { const s = `${objStart(i)}${o.dict}\nstream\n`; out += s; pos += s.length;
           out += o.stream; pos += o.stream.length;
           const tail = "\nendstream\nendobj\n"; out += tail; pos += tail.length; }
  }
  const xrefPos = pos;
  const maxObj = Math.max(...Object.keys(xref).map(Number));
  let x = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++)
    x += xref[i] ? String(xref[i]).padStart(10) + " 00000 n \n" : "0000000000 65535 f \n";
  x += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.concat([Buffer.from(out, "binary"), Buffer.from(x, "binary")]);
}
// размеры JPEG без библиотек: идём по маркерам до SOF
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 1240, h: 1754 }; // A4 150dpi на крайний случай
}

// --- распознавание текста с фото (GLM-4.6V, раздел 5.6 промта) ---
function visionCfg() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, "..", "bot", ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {}
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "bot", "config.json"), "utf8")).vision || {};
    return { key: (process.env.VISION_API_KEY || c.apiKey || "").trim(),
             model: c.model || "glm-4.6v", base: (c.baseUrl || "https://vision-ai.example/api/paas/v4").replace(/\/$/, "") };
  } catch (e) { return { key: "", model: "glm-4.6v", base: "https://vision-ai.example/api/paas/v4" }; }
}
async function ocrImage(buf) {
  const v = visionCfg();
  if (!v.key) throw new HttpError(400, "Не задан VISION_API_KEY — распознавание недоступно");
  const r = await fetchJSON(v.base + "/chat/completions",
    { "Authorization": "Bearer " + v.key, "Content-Type": "application/json" }, "POST", {
    model: v.model, temperature: 0.1,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + buf.toString("base64") } },
      { type: "text", text: "Перепиши ВЕСЬ текст с изображения как есть: рукописный или печатный. Верни только текст без комментариев, в том же языке. Сохраняй строки и числа." }
    ] }]
  });
  if (r.status !== 200 || !r.data) throw new HttpError(502, "Распознавание не ответило: HTTP " + r.status);
  const txt = ((r.data.choices || [])[0] || {}).message;
  const out = txt && (typeof txt.content === "string" ? txt.content : (txt.content || []).map(c => c.text || "").join("\n"));
  if (!out || !out.trim()) throw new HttpError(502, "Текст на фото не распознан");
  return out.trim();
}

// --- Яндекс.Диск (раздел 6.6): YADISK_TOKEN, YADISK_DIR (по умолчанию /Семья/OrganizerRVA);
// внутри — подпапка каждого пользователя (22.10: «каждый знает, где его документы») ---
async function yadiskUpload(userFolder, name, buf) {
  const token = (process.env.YADISK_TOKEN || "").trim();
  if (!token) throw new HttpError(400, "Не задан YADISK_TOKEN в procenka/.env — подключите токен Яндекс.Диска");
  const base = (process.env.YADISK_DIR || "/Семья/OrganizerRVA").replace(/\/+$/, "");
  const user = String(userFolder || "общее").replace(/[\/\\:*?"<>|]/g, "_").trim() || "общее";
  const base_ = "https://cloud-api.yandex.net/v1/disk/resources";
  const h = { "Authorization": "OAuth " + token };
  const path_for = p => encodeURIComponent(p);
  // Yandex сам создаёт недостающие родительские папки
  await fetchJSON(base_ + "?path=" + path_for(`${base}/${user}`), h, "PUT");
  const up = await fetchJSON(`${base_}/upload?path=${path_for(`${base}/${user}/${name}`)}&overwrite=true`, h);
  if (up.status !== 200 || !up.data || !up.data.href) throw new HttpError(502, "Яндекс.Диск не дал ссылку загрузки: " + (up.text || "").slice(0, 120));
  const put = await fetch(up.data.href, { method: "PUT", body: buf });
  if (!put.ok) throw new HttpError(502, "Файл не загружен на Яндекс.Диск: HTTP " + put.status);
  await fetchJSON(`${base_}/publish?path=${path_for(`${base}/${user}/${name}`)}`, h, "PUT");
  const meta = await fetchJSON(`${base_}?path=${path_for(`${base}/${user}/${name}`)}&fields=public_url`, h);
  return (meta.data || {}).public_url || "";
}

// --- отправка сообщения контакту из задачи (раздел 4.3): боты читают токены из bot/.env ---
const BOT_ENV = (() => { const e = {};
  try { for (const line of fs.readFileSync(path.join(ROOT, "..", "bot", ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  } } catch (err) {}
  return e; })();
async function sendBotMessage(channel, id, text) {
  if (channel === "max") {
    const token = BOT_ENV.MAX_TOKEN;
    if (!token) throw new HttpError(400, "Не задан MAX_TOKEN в bot/.env");
    // API бота — platform-api2.max.ru (как в bot/max_bot.py); MAX_BOT_URL из .env — это публичная ссылка, не API
    const r = await fetchJSON("https://platform-api2.max.ru/messages?user_id=" + encodeURIComponent(id),
      { "Authorization": token, "Content-Type": "application/json" }, "POST_RAW",
      JSON.stringify({ text: String(text).slice(0, 4000), notify: true }));
    if (r.status !== 200) throw new HttpError(502, "MAX не принял сообщение: HTTP " + r.status + " " + (r.text || "").slice(0, 150));
    return "отправлено в MAX";
  }
  if (channel === "telegram") {
    const token = BOT_ENV.TELEGRAM_TOKEN;
    if (!token) throw new HttpError(400, "Не задан TELEGRAM_TOKEN в bot/.env");
    const r = await fetchJSON(`https://api.telegram.org/bot${token}/sendMessage`, {}, "POST",
      { chat_id: id, text: String(text).slice(0, 4000) });
    if (r.status !== 200) throw new HttpError(502, "Telegram не принял сообщение: HTTP " + r.status + " " + (r.text || "").slice(0, 120));
    return "отправлено в Telegram";
  }
  throw new HttpError(400, "Неизвестный канал");
}

// контакт + автосклейка с пользователем сайта: совпал email или телефон → подтягиваем login/id
function byLogin(login) { return users.find(u => u.login && login && u.login.toLowerCase() === String(login).toLowerCase()) || null; }
function enrichContact(c) {
  if (!c.login) {
    const u = users.find(x => (c.email && x.email && x.email.toLowerCase() === c.email) ||
                              (c.phone && x.phone && normPhone(x.phone) === normPhone(c.phone)));
    if (u) { DB.oContacts.update(c.id, { login: u.login, max_id: u.max_id || "", telegram_id: u.telegram_id || "", phone: u.phone || "" }); return DB.oContacts.get(c.id); }
  }
  return c;
}

// имя файла из заголовка: %-кодировка от браузера, но некоторые клиенты шлют сырой UTF-8
function safeHeaderName(s) {
  let v = String(s || "").trim();
  try { v = decodeURIComponent(v); } catch (e) {}
  if (/[ÐÂÃ]/.test(v)) v = Buffer.from(v, "latin1").toString("utf8"); // клиент не закодировал — чиним
  return v;
}
function orgCarry() { // просроченное → сегодня; повторы рождают следующий заход; чистка архива
  const made = DB.oTasks.spawnRecurring(todayStr());
  if (made) DB.oAudit.log("система", "повтор задачи", null, `создан следующий экземпляр: ${made}`);
  const n = DB.oTasks.carryOver(todayStr());
  if (n) DB.oAudit.log("система", "автоперенос", null, `${n} задач(и) → ${todayStr()}`);
  const day = 24 * 3600e3;
  const c = DB.oTasks.autoClean(Date.now() - 14 * day, Date.now() - 30 * day); // архив 14 дней → корзина, 30 дней → удалить
  if (c.toTrash || c.gone) DB.oAudit.log("система", "очистка", null, `в корзину ${c.toTrash}, удалено ${c.gone}`);
  return n;
}
// голос → текст: локальный whisper (procenka/stt_server.py, порт 8767).
// ProxyAPI/OpenAI больше не используются (решение 21.10).
async function sttTranscribe(buf, mime) {
  const base = process.env.STT_URL || "http://127.0.0.1:8767";
  try {
    const r = await fetchJSON(base + "/stt",
      { "Content-Type": mime || "audio/webm" }, "POST_RAW", buf);
    if (r.status !== 200) throw new Error((r.data || {}).error || "HTTP " + r.status);
    const text = ((r.data || {}).text || "").trim();
    if (!text) throw new Error("Речь не распознана — попробуйте ещё раз");
    return text;
  } catch (e) {
    if (/ECONNREFUSED|fetch failed/i.test(String(e)))
      throw new HttpError(502, "Локальное распознавание не запущено: cd procenka && ../bot/venv/bin/python stt_server.py");
    throw new HttpError(502, "Распознавание: " + e.message);
  }
}
async function organizerApi(req, res, u1, tail, q) {
  const actor = u1.login;
  // почта (вариант 2): проброс в локальный сервис mail_api.py — тот общается с ящиками по IMAP/SMTP
  if (tail.startsWith("mail")) {
    const qs0 = q.toString();
    const target = new URL((process.env.MAIL_API || "http://127.0.0.1:8768") + "/" + tail.replace(/^mail\/?/, "") + (qs0 ? "?" + qs0 : ""));
    target.searchParams.set("actor", actor);   // сервис покажет только ящики этого пользователя
    const fwdBody = req.method === "POST" ? await readRaw(req) : undefined;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 90 * 1000);
    try {
      const resp = await fetch(target.toString(), {
        headers: fwdBody ? { "Content-Type": "application/json" } : {},
        method: fwdBody ? "POST" : "GET",
        body: fwdBody, signal: ac.signal
      });
      const text = await resp.text();
      let data = null; try { data = JSON.parse(text); } catch (e) {}
      return json(res, resp.status, data || { error: text.slice(0, 150) });
    } finally { clearTimeout(t); }
  }
  if (req.method === "GET" && tail === "access") return json(res, 200, { ok: true, name: u1.name || u1.login });
  if (req.method === "GET" && tail === "tasks") {
    orgCarry();
    const view = String(q.get("view") || "inbox");
    let date = DATE_RE.test(q.get("date") || "") ? q.get("date") : todayStr();
    let date2 = date;
    if (view === "week") { // понедельник…воскресенье недели, которой принадлежит date
      const d = new Date(date + "T12:00:00");
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      date = todayStr(mon); date2 = todayStr(sun);
    }
    return json(res, 200, {
      tasks: DB.oTasks.list({ view, date, date2, includeDone: q.get("done") === "1",
        q: String(q.get("q") || "").trim().slice(0, 100) }),
      counts: DB.oTasks.counts(), today: todayStr(),
    });
  }
  if (req.method === "POST" && tail === "tasks") { // создать
    const b = await readBody(req);
    const title = String(b.title || "").trim().slice(0, 200);
    if (!title) return json(res, 400, { error: "Укажите название задачи" });
    const due = b.due_date === "" || b.due_date === null ? null   // без даты → «Задачи» (без срока)
      : (DATE_RE.test(b.due_date) ? b.due_date : todayStr());
    const time = TIME_RE.test(b.due_time || "") ? b.due_time : null;
    const rec = REC_RE.test(b.rec || "") ? b.rec : "";
    const mins = Math.max(5, Math.min(600, Math.round(Number(b.mins) || 25)));   // таймфрейм, минут
    const id = DB.oTasks.add({ title, body: String(b.body || "").slice(0, 10000),
      source: "manual", contact: actor, due_date: due, due_time: time, rec, mins, created_at: new Date().toISOString() });
    DB.oAudit.log(actor, "создана", id, title + (rec ? ` (повтор: ${rec})` : ""));
    return json(res, 200, { ok: true, id, task: DB.oTasks.get(id) });
  }
  if (req.method === "POST" && tail === "stt") { // надиктованная задача: голос → текст
    const buf = await readRaw(req);
    if (!buf.length) return json(res, 400, { error: "Пустая запись" });
    const text = await sttTranscribe(buf, String(req.headers["content-type"] || ""));
    return json(res, 200, { ok: true, text });
  }
  const m = tail.match(/^tasks\/(\d+)$/);
  if (req.method === "POST" && m) { // действие над задачей
    const t = DB.oTasks.get(m[1]);
    if (!t) return json(res, 404, { error: "Задача не найдена" });
    const b = await readBody(req);
    const act = String(b.action || "");
    if (act === "restore") { // единственное действие над задачей из корзины
      DB.oTasks.restore(t.id);
      DB.oAudit.log(actor, "восстановлена", t.id, t.title);
      return json(res, 200, { ok: true, task: DB.oTasks.get(t.id) });
    }
    if (t.deleted) return json(res, 404, { error: "Задача в корзине — сначала восстановите её" });
    if (act === "done" || act === "undone") {
      DB.oTasks.setDone(t.id, act === "done", actor, new Date().toISOString());
      DB.oAudit.log(actor, act === "done" ? "выполнено" : "возвращена в работу", t.id, t.title);
    } else if (act === "move") { // перетаскивание: дата и/или время
      const date = DATE_RE.test(b.due_date || "") ? b.due_date : t.due_date;
      const time = b.due_time === null || b.due_time === "" ? null : (TIME_RE.test(b.due_time || "") ? b.due_time : t.due_time);
      DB.oTasks.move(t.id, date, time);
      DB.oAudit.log(actor, "перенесена", t.id, `${t.due_date}${t.due_time ? " " + t.due_time : ""} → ${date}${time ? " " + time : " (весь день)"}`);
    } else if (act === "edit") {
      const title = String(b.title || "").trim().slice(0, 200);
      if (!title) return json(res, 400, { error: "Укажите название задачи" });
      const mins = b.mins === undefined ? (t.mins || 25)
        : Math.max(5, Math.min(600, Math.round(Number(b.mins) || 25)));
      DB.oTasks.edit(t.id, { title, body: String(b.body || "").slice(0, 10000),
        due_date: b.due_date === "" ? null : (DATE_RE.test(b.due_date || "") ? b.due_date : t.due_date),
        due_time: b.due_time === null || b.due_time === "" ? null : (TIME_RE.test(b.due_time || "") ? b.due_time : t.due_time),
        rec: REC_RE.test(b.rec || "") ? b.rec : (t.rec || ""),
        mins });
      DB.oAudit.log(actor, "изменена", t.id, title);
    } else if (act === "mins") { // растягивание задачи мышью в календаре — меняется только таймфрейм
      const mins = Math.max(5, Math.min(600, Math.round(Number(b.mins) || 25)));
      DB.oTasks.edit(t.id, { title: t.title, body: t.body, due_date: t.due_date,
        due_time: t.due_time, rec: t.rec, mins });
      DB.oAudit.log(actor, "изменён таймфрейм", t.id, `${t.title}: ${mins} мин`);
    } else if (act === "delete") {
      DB.oTasks.softDelete(t.id, new Date().toISOString());
      DB.oAudit.log(actor, "в корзину", t.id, t.title);
    } else return json(res, 400, { error: "Неизвестное действие" });
    return json(res, 200, { ok: true, task: DB.oTasks.get(t.id) });
  }
  if (req.method === "GET" && tail === "audit") return json(res, 200, { log: DB.oAudit.list() });

  // ---------- контакты (О-2) ----------
  if (req.method === "GET" && tail === "contacts") {
    const find = String(q.get("q") || "").trim().slice(0, 100);
    const list = DB.oContacts.list(find).map(c => enrichContact(c));
    return json(res, 200, { contacts: list });
  }
  if (req.method === "POST" && tail === "contacts") { // добавить вручную (дубль по телефону/email — обновляем)
    const b = await readBody(req);
    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().toLowerCase();
    const phone = normPhone(b.phone);
    if (!name && !email && !phone) return json(res, 400, { error: "Укажите имя, телефон или email" });
    const dup = DB.oContacts.byEmailOrPhone(email, phone);
    let id;
    if (dup) { DB.oContacts.update(dup.id, { name, email, phone, note: b.note }); id = dup.id; }
    else id = DB.oContacts.add({ name, email, phone, note: String(b.note || "").slice(0, 500), created_at: new Date().toISOString() });
    DB.oAudit.log(actor, dup ? "обновлён контакт" : "создан контакт", null, name || email || phone);
    return json(res, 200, { ok: true, id, contact: enrichContact(DB.oContacts.get(id)) });
  }
  const cm = tail.match(/^contact\/(\d+)\/message$/);
  if (req.method === "POST" && cm) { // сообщение из задачи: MAX / Telegram (email — mailto на клиенте)
    const c = DB.oContacts.get(cm[1]);
    if (!c) return json(res, 404, { error: "Контакт не найден" });
    const b = await readBody(req);
    const channel = b.channel === "telegram" ? "telegram" : "max";
    const id = channel === "telegram" ? (c.telegram_id || (byLogin(c.login) || {}).telegram_id) : (c.max_id || (byLogin(c.login) || {}).max_id);
    if (!id) return json(res, 400, { error: `У контакта нет id в ${channel === "max" ? "MAX" : "Telegram"} — он должен написать боту и привязать аккаунт` });
    const text = String(b.text || "").trim();
    if (!text) return json(res, 400, { error: "Пустое сообщение" });
    const status = await sendBotMessage(channel, id, text);
    DB.oAudit.log(actor, "сообщение контакту", null, `${channel} ${c.name || c.login || id}: ${text.slice(0, 60)}`);
    return json(res, 200, { ok: true, status });
  }

  // ---------- записная книжка (О-3): персональная, буквы — в db.js ----------
  if (req.method === "GET" && tail === "notes") {
    const letter = q.get("letter");
    if (letter) return json(res, 200, { notes: DB.oNotes.listByLetter(actor, letter.slice(0, 1)) });
    return json(res, 200, { letters: DB.oNotes.listLetters(actor) });
  }
  const nm = tail.match(/^notes\/(\d+)$/);
  if (req.method === "GET" && nm) {
    const note = DB.oNotes.get(nm[1], actor);
    if (!note) return json(res, 404, { error: "Запись не найдена" });
    return json(res, 200, { note, files: DB.oFiles.byNote(note.id) });
  }
  if (req.method === "POST" && tail === "notes") { // создать запись
    const b = await readBody(req);
    const title = String(b.title || "").trim().slice(0, 200);
    if (!title) return json(res, 400, { error: "Укажите название записи" });
    const id = DB.oNotes.add({ owner: actor, title, body: String(b.body || "").slice(0, 50000) });
    DB.oAudit.log(actor, "создана запись книжки", null, title);
    return json(res, 200, { ok: true, id, note: DB.oNotes.get(id, actor) });
  }
  if (req.method === "POST" && nm) { // правка/удаление записи
    const note = DB.oNotes.get(nm[1], actor);
    if (!note) return json(res, 404, { error: "Запись не найдена" });
    const b = await readBody(req);
    if (b.action === "delete") { DB.oNotes.softDelete(note.id); DB.oAudit.log(actor, "запись в корзину", null, note.title); }
    else {
      const title = String(b.title || "").trim().slice(0, 200);
      if (!title) return json(res, 400, { error: "Укажите название записи" });
      DB.oNotes.update(note.id, { title, body: String(b.body || "").slice(0, 50000) });
      DB.oAudit.log(actor, "изменена запись", null, title);
    }
    return json(res, 200, { ok: true });
  }
  const nf = tail.match(/^notes\/(\d+)\/file$/);
  if (req.method === "POST" && nf) { // «скрепка»: файл/фото в запись (сырое тело, имя в заголовке)
    const note = DB.oNotes.get(nf[1], actor);
    if (!note) return json(res, 404, { error: "Запись не найдена" });
    const buf = await readRaw(req);
    if (!buf.length) return json(res, 400, { error: "Пустой файл" });
    const name = safeHeaderName(req.headers["x-filename"] || "файл");
    const id = orgSave(actor, name, buf, { note_id: note.id });
    DB.oAudit.log(actor, "файл в записи", null, `${name} → «${note.title}»`);
    return json(res, 200, { ok: true, id, file: DB.oFiles.get(id) });
  }

  // ---------- файлы: скачать, распознать, на Диск, удалить ----------
  const fm = tail.match(/^file\/(\d+)$/);
  if (req.method === "GET" && fm) {
    const f = DB.oFiles.get(fm[1]);
    if (!f || f.deleted) return json(res, 404, { error: "Файл не найден" });
    if (f.owner && f.owner !== actor) return json(res, 403, { error: "Это файл чужой книжки" });
    res.writeHead(200, { "Content-Type": f.kind === "image" ? "image/jpeg" : f.kind === "pdf" ? "application/pdf" : f.kind === "txt" ? "text/plain; charset=utf-8" : "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
    return res.end(orgRead(f));
  }
  const fo = tail.match(/^file\/(\d+)\/(ocr|yadisk|delete)$/);
  if (req.method === "POST" && fo) {
    const f = DB.oFiles.get(fo[1]);
    if (!f || f.deleted) return json(res, 404, { error: "Файл не найден" });
    if (f.owner && f.owner !== actor) return json(res, 403, { error: "Это файл чужой книжки" });
    if (fo[2] === "ocr") {
      if (f.kind !== "image") return json(res, 400, { error: "Распознать можно только фото/скан" });
      const txt = await ocrImage(orgRead(f));
      const id = orgSave(actor, f.name.replace(/\.[a-z]+$/i, "") + ".txt", Buffer.from(txt, "utf8"), { note_id: f.note_id });
      DB.oAudit.log(actor, "распознан текст", null, f.name);
      return json(res, 200, { ok: true, text: txt, file: DB.oFiles.get(id) });
    }
    if (fo[2] === "yadisk") {
      const url = await yadiskUpload(u1.name || u1.login, f.name, orgRead(f));
      DB.oFiles.setYadisk(f.id, url);
      DB.oAudit.log(actor, "файл на Яндекс.Диск", null, f.name);
      return json(res, 200, { ok: true, url, file: DB.oFiles.get(f.id) });
    }
    DB.oFiles.softDelete(f.id);
    DB.oAudit.log(actor, "файл удалён", null, f.name);
    return json(res, 200, { ok: true });
  }

  // ---------- сканер (О-4): страницы по одной, потом сборка ----------
  if (req.method === "POST" && tail === "scan/page") {
    const buf = await readRaw(req);
    if (!buf.length) return json(res, 400, { error: "Пустая страница" });
    const token = crypto.randomBytes(8).toString("hex");
    SCAN_PAGES.set(token, { buf, ts: Date.now(), owner: actor });
    return json(res, 200, { ok: true, token, size: jpegSize(buf) });
  }
  if (req.method === "POST" && tail === "scan") {
    const b = await readBody(req); // {name, tokens:[…], note_id | new_note, download, yadisk}
    const name = String(b.name || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 120) || "scan_" + todayStr();
    const pages = (b.tokens || []).map(t => { const p = SCAN_PAGES.get(String(t)); if (!p || p.owner !== actor) throw new HttpError(400, "Страницы скана устарели — снимите заново"); return p.buf; });
    if (!pages.length) return json(res, 400, { error: "Нет страниц скана" });
    let noteId = Number(b.note_id) || null;
    if (!noteId && b.new_note !== false && b.to_note !== false) { // по умолчанию — запись в книжке с именем скана
      noteId = DB.oNotes.add({ owner: actor, title: name, body: "" });
    }
    const pdf = buildPdf(pages.map(buf => ({ buf, ...jpegSize(buf) })));
    const pdfId = orgSave(actor, name + ".pdf", pdf, { note_id: noteId });
    let url = "";
    if (b.yadisk) url = await yadiskUpload(u1.name || u1.login, name + ".pdf", pdf);
    if (url) DB.oFiles.setYadisk(pdfId, url);
    (b.tokens || []).forEach(t => SCAN_PAGES.delete(String(t)));
    DB.oAudit.log(actor, "скан сохранён", null, `${name}.pdf, страниц: ${pages.length}${url ? ", на Яндекс.Диске" : ""}`);
    return json(res, 200, { ok: true, pdf: DB.oFiles.get(pdfId), note_id: noteId, yadisk_url: url });
  }

  return json(res, 404, { error: "Нет такого запроса органайзера" });
}



// ---------- таблица пользователей для администратора: данные, доступ, цепочки приглашений ----------
// Приглашения записываются ботами по id в мессенджере (referrals: inviter_id → tid). Здесь они
// сопоставляются с пользователями сайта по привязанным max_id / telegram_id.
function userByMessenger(transport, id) {
  if (!id) return null;
  const fields = transport === "telegram" ? ["telegram_id"] : transport === "max" ? ["max_id"] : ["max_id", "telegram_id"];
  return users.find(x => fields.some(f => x[f] && String(x[f]) === String(id))) || null;
}
const fioOf = x => [x.surname, x.name, x.patronymic].filter(Boolean).join(" ");
const personLabel = x => fioOf(x) || x.login;
function referralGraph() {
  const refs = DB.referrals.list(100000);
  const parent = {}, kids = {}, invitedByText = {};
  for (const r of refs) {
    const inv = userByMessenger(r.transport, r.inviter_id), child = userByMessenger(r.transport, r.tid);
    const childKey = child ? child.id : null;
    const invLabel = inv ? personLabel(inv) : `${r.transport === "telegram" ? "Telegram" : "MAX"} ${r.inviter_id} (не на сайте)`;
    if (childKey && !parent[childKey]) { parent[childKey] = inv ? inv.id : null; invitedByText[childKey] = invLabel; }
    if (inv) (kids[inv.id] = kids[inv.id] || []).push(child ? personLabel(child) : `${r.transport === "telegram" ? "Telegram" : "MAX"} ${r.tid} (не на сайте)`);
  }
  return { parent, kids, invitedByText, refs };
}
function chainOf(id, g) {           // «кто пригласил того, кто пригласил…» — до 10 звеньев вверх
  const path = [], seen = new Set([id]);
  let cur = g.parent[id];
  while (cur && !seen.has(cur) && path.length < 10) {
    seen.add(cur);
    const x = users.find(y => y.id === cur);
    if (!x) break;
    path.unshift(personLabel(x));
    cur = g.parent[cur];
  }
  return path;
}
function adminUsersTable() {
  const g = referralGraph();
  return users.map(x => {
    const a = accessInfo(x);
    return {
      id: x.id, login: x.login, email: x.email || x.login, fio: fioOf(x), name: x.name || "", surname: x.surname || "",
      patronymic: x.patronymic || "", phone: x.phone || "", role: x.role || "user", approved: !!x.approved,
      photos: x.photos === undefined || x.photos === null ? null : Number(x.photos),
      photos_default: hasAccess(x) ? 6 : (x.approved ? 4 : 2),   // по уровню: 6 полный доступ, 4 регистрация, 2 бот
      level: levelOf(x), created: x.created || null, last_login: x.last_login || null,
      max: !!x.max_id, telegram: !!x.telegram_id,
      access: a, invited_by: g.invitedByText[x.id] || "", chain: chainOf(x.id, g),
      invitees: g.kids[x.id] || [], invited_count: (g.kids[x.id] || []).length
    };
  }).sort((p, q) => (q.created || 0) - (p.created || 0));
}
function adminExportXlsx() {
  const XLSX = require("xlsx");
  const d = ts => ts ? new Date(ts).toLocaleString("ru-RU") : "";
  const rows = adminUsersTable().map(x => ({
    "ФИО": x.fio, "Email": x.email, "Телефон": x.phone ? "+" + x.phone : "", "Роль": x.role === "admin" ? "администратор" : "пользователь",
    "Статус": x.approved ? "подтверждён" : "ждёт подтверждения", "Уровень": x.level,
    "MAX": x.max ? "привязан" : "", "Telegram": x.telegram ? "привязан" : "",
    "Зарегистрирован": d(x.created), "Последний вход": d(x.last_login),
    "Пригласил": x.invited_by, "Цепочка приглашений": x.chain.join(" → "),
    "Пригласил(а) человек": x.invited_count, "Кого пригласил(а)": x.invitees.join(", "),
    "Доступ до": x.access.unlimited ? "бессрочно" : x.access.days > 0 ? d(x.access.until) : "закрыт",
    "Дней доступа": x.access.unlimited ? "бессрочно" : x.access.days,
  }));
  const g = referralGraph();
  const refs = g.refs.map(r => {
    const inv = userByMessenger(r.transport, r.inviter_id), ch = userByMessenger(r.transport, r.tid);
    return { "Дата": d(r.date), "Мессенджер": r.transport || "", "Пригласил": inv ? personLabel(inv) : "", "id пригласившего": r.inviter_id,
             "Приглашённый": ch ? personLabel(ch) : "", "id приглашённого": r.tid };
  });
  const log = DB.accessLog.list(100000).map(l => ({ "Дата": d(l.ts), "Пользователь": l.login, "Кто изменил": l.admin,
    "Было дней": l.days_before, "Стало дней": l.days_after, "Доступ до": l.until ? d(l.until) : "", "Примечание": l.note }));
  const qs = DB.questions.list(100000).map(q => ({ "Дата": d(q.date), "Мессенджер": q.transport, "От": q.from || "", "id": q.tid, "Вопрос": q.text }));
  const wb = XLSX.utils.book_new();
  const add = (data, name, widths) => {
    const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ "": "нет данных" }]);
    ws["!cols"] = widths.map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(rows, "Пользователи", [28, 28, 15, 14, 18, 8, 9, 9, 18, 18, 24, 34, 10, 40, 18, 12]);
  add(refs, "Приглашения", [18, 11, 24, 14, 24, 14]);
  add(log, "История доступа", [18, 26, 20, 10, 10, 18, 30]);
  add(qs, "Вопросы", [18, 11, 22, 14, 80]);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const q = u.searchParams;
  try {
    // картинки ленты: /lenta/<файл> из public/lenta
    if (req.method === "GET" && u.pathname.startsWith("/lenta/")) {
      const f = path.join(PUB, "lenta", path.basename(u.pathname));
      if (fs.existsSync(f)) {
        res.writeHead(200, { "Content-Type": f.endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "no-cache" });
        return res.end(fs.readFileSync(f));
      }
    }
    // статика: логотип и QR-коды ботов (png/ico из public)
    if (req.method === "GET" && /^\.(png|ico)$/.test(path.extname(u.pathname))) {
      const f = path.join(PUB, path.basename(u.pathname));
      if (fs.existsSync(f)) {
        res.writeHead(200, { "Content-Type": u.pathname.endsWith(".ico") ? "image/x-icon" : "image/png" });
        return res.end(fs.readFileSync(f));
      }
    }
    // PWA органайзера: манифест и service worker из public
    if (req.method === "GET" && /\.(webmanifest|js)$/.test(path.extname(u.pathname))) {
      const f = path.join(PUB, path.basename(u.pathname));
      if (fs.existsSync(f)) {
        res.writeHead(200, { "Content-Type": u.pathname.endsWith(".js") ? "application/javascript" : "application/manifest+json", "Cache-Control": "no-cache" });
        return res.end(fs.readFileSync(f));
      }
    }
    // главная страница сайта — site/variant-1.html (исходник в папке сайта)
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(ROOT, "..", "site", "variant-1.html")));
    }
    // страница проценки
    if (req.method === "GET" && (u.pathname === "/poisk" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(PUB, "index.html")));
    }
    // страница органайзера (данные отдаёт только API и только 5-му уровню)
    if (req.method === "GET" && u.pathname === "/organizer") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(PUB, "organizer.html")));
    }
    // страница «Автоматизация бизнес-процессов с помощью ИИ» — портфолио проектов, открыта всем
    if (req.method === "GET" && (u.pathname === "/automation" || u.pathname === "/portfolio")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(PUB, "automation.html")));
    }
    // ---- авторизация ----
    if (req.method === "GET" && u.pathname === "/api/auth/me") {
      const u1 = currentUser(req);
      return json(res, 200, { user: u1 ? { login: u1.login, name: u1.name || "", surname: u1.surname || "", role: u1.role, approved: u1.approved,
                                           full: isFull(u1), access: accessInfo(u1),
                                           supSpace: u1.role === "admin" ? "global" : isLevel4(u1) ? "view" : isFull(u1) ? "own" : "none" } : null });
    }
    if (req.method === "POST" && u.pathname === "/api/auth/register") {
      const b = await readBody(req);
      const login = String(b.login || "").trim(), password = String(b.password || "");
      const name = String(b.name || "").trim();
      const surname = String(b.surname || "").trim();
      const patronymic = String(b.patronymic || "").trim();
      const phone = normPhone(b.phone);
      if (!name) return json(res, 400, { error: "Укажите имя (обязательно)" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return json(res, 400, { error: "Укажите email — он же логин для входа" });
      if (!phone) return json(res, 400, { error: "Укажите телефон (+7…) — по нему бот привяжет аккаунт" });
      if (password.length < 8) return json(res, 400, { error: "Пароль — от 8 символов" });
      if (!rateHit("reg:" + clientIp(req), 5, 60 * 60e3)) return json(res, 429, { error: "Слишком много регистраций с этого адреса — повторите позже" });
      if (users.some(x => x.login.toLowerCase() === login.toLowerCase())) return json(res, 409, { error: "Такой email уже зарегистрирован" });
      if (users.some(x => x.phone === phone)) return json(res, 409, { error: "Этот телефон уже зарегистрирован" });
      // шаг 1: заявка + ссылка подтверждения на email; в пользователи попадёт только после перехода по ссылке
      const token = crypto.randomBytes(16).toString("hex");
      DB.registrations.put({ name, surname, patronymic, login, pass: hashPass(password), phone, token, created: Date.now(), sent: Date.now() });
      const base = process.env.BASE_URL || `http://${req.headers.host || "127.0.0.1:8766"}`;
      const link = `${base}/confirm?token=${token}`;
      const mail = await sendEmail(login, "Подтверждение регистрации RVA",
        `Здравствуйте, ${name}!\n\nПодтвердите email и получите доступ к проценке по ссылке:\n${link}\nСсылка действует 24 часа.\nВход на сайт — по email и паролю.\n\n— бот Prodobrey / RVA`) // текст письма — черновик, разработаем позже
        .catch(e => { console.error("[почта] письмо подтверждения не ушло:", e.message);
                      throw new HttpError(502, "Письмо со ссылкой отправить не удалось — почтовый сервер недоступен. Заявка сохранена: попробуйте позже или напишите нам в бот MAX."); });
      return json(res, 200, {
        ok: true,
        message: mail.sent ? "Письмо со ссылкой отправлено на email" : "Тестовый режим: письмо не отправлялось, ссылка показана ниже",
        dev_link: mail.sent ? undefined : link,
      });
    }
    // страница подтверждения email по ссылке из письма (одноразовая, живёт 24 часа)
    if (req.method === "GET" && u.pathname === "/confirm") {
      const token = String(q.get("token") || "");
      const r = token ? DB.registrations.byToken(token) : null;
      const page = (ok, msg) => `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>RVA — подтверждение email</title>` +
        `<style>body{font-family:-apple-system,Arial,sans-serif;background:#0d1b2a;color:#e9eff6;display:grid;place-items:center;height:100vh;margin:0}` +
        `.box{background:#13263c;border:1px solid #24405d;border-radius:14px;padding:40px;max-width:520px;text-align:center}` +
        `h1{font-size:22px;margin-bottom:12px}p{color:#9db0c4;font-size:14px}a{color:#ff8c1a}</style></head>` +
        `<body><div class="box"><h1>${ok ? "✓" : "⚠️"} ${msg}</h1><p><a href="/">На главную страницу сайта</a> · <a href="/poisk">Страница проценки</a></p></div></body></html>`;
      if (!r) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(page(false, "Ссылка недействительна — зарегистрируйтесь заново"));
      }
      if (Date.now() - r.created > DB.registrations.ttl) {
        DB.registrations.remove(r.token);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(page(false, "Ссылка устарела — зарегистрируйтесь заново"));
      }
      if (users.some(x => x.login.toLowerCase() === r.login.toLowerCase())) {
        DB.registrations.remove(r.token);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(page(false, "Этот email уже зарегистрирован — войдите по email и паролю"));
      }
      const nu = { id: crypto.randomUUID(), name: r.name, surname: r.surname || "", patronymic: r.patronymic || "", login: r.login, pass: r.pass, phone: r.phone || "", role: "user", approved: true, created: Date.now() };
      saveUser(nu);
      users.push(nu);
      DB.registrations.remove(r.token);
      // уведомление админам с привязанным MAX (не блокирует и не ломает подтверждение)
      const who = [nu.name, nu.surname].filter(Boolean).join(" ") || "без имени";
      for (const a of users.filter(x => x.role === "admin" && x.max_id))
        sendBotMessage("max", a.max_id, `🔔 Новая регистрация: ${who} — ${nu.login}` + (nu.phone ? `, тел. ${nu.phone}` : "") +
          ". Вход на сайт открыт; полный доступ к проценке открывается в кабинете («Дней доступа»).")
          .catch(e => console.error("[регистрация] уведомление в MAX не ушло:", e.message));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(page(true, "Email подтверждён — можно входить на сайт (email и пароль). Полный доступ к проценке открывается администратором."));
    }
    if (req.method === "POST" && u.pathname === "/api/auth/resend") {
      const b = await readBody(req);
      const r = DB.registrations.byLogin(String(b.login || "").trim());
      if (!r) return json(res, 404, { error: "Заявка не найдена — зарегистрируйтесь заново" });
      if (Date.now() - (r.sent || 0) < 60 * 1000) return json(res, 429, { error: "Повторите через минуту" });
      const newToken = crypto.randomBytes(16).toString("hex");
      DB.registrations.retoken(r.token, newToken);
      r.token = newToken;
      const base = process.env.BASE_URL || `http://${req.headers.host || "127.0.0.1:8766"}`;
      const link = `${base}/confirm?token=${r.token}`;
      const mail = await sendEmail(r.login, "Подтверждение регистрации RVA",
        `Новая ссылка для подтверждения email:\n${link}\nСсылка действует 24 часа.\n\n— бот Prodobrey / RVA`);
      return json(res, 200, {
        ok: true,
        message: mail.sent ? "Новая ссылка отправлена на email" : "Тестовый режим: ссылка показана ниже",
        dev_link: mail.sent ? undefined : link,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/auth/login") {
      const b = await readBody(req);
      const login = String(b.login || "").trim().toLowerCase();
      const ip = clientIp(req);
      // перебор паролей: 10 неудачных попыток за 15 минут на адрес и на логин
      const blocked = (RATE.get("login-ip:" + ip) || []).filter(t => Date.now() - t < 15 * 60e3).length >= 10 ||
                      (RATE.get("login-u:" + login) || []).filter(t => Date.now() - t < 15 * 60e3).length >= 10;
      if (blocked) return json(res, 429, { error: "Слишком много попыток входа — повторите через 15 минут" });
      const u1 = users.find(x => x.login.toLowerCase() === login);
      if (!u1 || !checkPass(u1.pass, String(b.password || ""))) {
        rateHit("login-ip:" + ip, 1e9, 15 * 60e3); rateHit("login-u:" + login, 1e9, 15 * 60e3);
        // незавершённая регистрация: заявка есть, но email не подтверждён — честная подсказка
        const reg = DB.registrations.byLogin(login);
        if (reg) return json(res, 403, { pending: true,
          error: "Email ещё не подтверждён — мы отправили письмо со ссылкой на " + reg.login +
                 ". Проверьте входящие и папку «Спам» (ссылка действует 24 часа)." });
        return json(res, 401, { error: "Неверный логин или пароль" });
      }
      if (isLegacyHash(u1.pass)) { u1.pass = hashPass(String(b.password || "")); }
      u1.last_login = Date.now(); saveUser(u1);
      if (!u1.approved) return json(res, 403, { pending: true, error: "Заявка на подтверждении у администратора" });
      const sid = DB.sessions.create(u1.id, ip);
      // один вход на аккаунт: новый вход гасит прежние сессии — на других компьютерах и с других адресов
      DB.sessions.removeOthers(u1.id, sid);
      res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DB.sessions.ttlSeconds}` + COOKIE_SECURE);
      return json(res, 200, { user: { login: u1.login, role: u1.role, approved: true } });
    }
    // nginx auth_request: есть живой вход в программу? Служебная проверка для служебных
    // разделов: со входом второй пароль не спрашивается, без него — остаётся запасным замком
    if (req.method === "GET" && u.pathname === "/api/auth/check") {
      if (!currentUser(req)) return json(res, 401, { error: "Нужен вход" });
      return json(res, 200, { ok: true });
    }
    // заявка на страницу Проценки (переход во 2→3 уровень): проверяем логин/пароль,
    // ставим пользователю 3-й уровень, директору — задача на сегодня и сообщение в MAX
    if (req.method === "POST" && u.pathname === "/api/auth/l3-request") {
      const b = await readBody(req);
      const login = String(b.login || "").trim().toLowerCase();
      const u1 = users.find(x => x.login.toLowerCase() === login);
      if (!u1 || !checkPass(u1.pass, String(b.password || "")))
        return json(res, 401, { error: "Неверный логин или пароль" });
      if (!u1.approved) return json(res, 403, { error: "Сначала подтвердите email — ссылка из письма" });
      if (u1.l3) return json(res, 200, { ok: true, message: "Заявка уже принята — мы свяжемся с вами" });
      u1.l3 = true;
      saveUser(u1);
      const who = fioOf(u1) || u1.login;
      DB.oTasks.add({ title: `Заявка на Проценку: ${who}`, source: "site", contact: u1.login,
        body: `Пользователь ${u1.login} (тел. ${u1.phone ? "+" + u1.phone : "—"}) подал заявку на страницу Проценки. Дни доступа — в кабинете («Дней доступа»).`,
        due_date: todayStr(), mins: 25, created_at: new Date().toISOString() });
      DB.oAudit.log(u1.login, "заявка на Проценку (3 уровень)", null, u1.login);
      for (const a of users.filter(x => x.role === "admin" && x.max_id))
        sendBotMessage("max", a.max_id, `🔔 Заявка на Проценку: ${who} (${u1.login}). Задача — в «Сегодня» органайзера. Дни доступа — в кабинете.`)
          .catch(e => console.error("[l3] MAX не ушёл:", e.message));
      return json(res, 200, { ok: true, message: "Заявка отправлена — мы свяжемся с вами и откроем доступ" });
    }
    if (req.method === "POST" && u.pathname === "/api/auth/logout") {
      DB.sessions.remove(parseCookies(req).sid);
      res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + COOKIE_SECURE);
      return json(res, 200, { ok: true });
    }
    // ---- администрирование пользователей (только админ) ----
    if (u.pathname === "/api/admin/users") {
      if (req.method === "GET") {
        if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
        return json(res, 200, { users: adminUsersTable(), trialDays: DB.settings.get("trialDays", 0) });
      }
      if (req.method === "POST") {
        const me = currentUser(req);
        if (!isAdmin(me)) return json(res, 403, { error: "Только для администратора" });
        const b = await readBody(req);
        const t = users.find(x => x.id === b.id);
        if (!t) return json(res, 404, { error: "Пользователь не найден" });
        const logAccess = (before, note) => DB.accessLog.add({ ts: Date.now(), user_id: t.id, login: t.login, admin: me.login,
          days_before: before, days_after: accessText(accessInfo(t)), until: typeof t.access_until === "number" ? t.access_until : null, note });
        if (b.action === "approve") {
          t.approved = true;
          if (t.access_until === undefined) {          // новому — пробный срок (настройка, по умолчанию 0 дней)
            const before = accessText(accessInfo(t));
            t.access_until = accessUntilFor(Number(DB.settings.get("trialDays", 0)) || 0);
            saveUser(t); logAccess(before, "одобрение регистрации");
          } else saveUser(t);
        }
        else if (b.action === "access") {             // «Дней доступа» в таблице кабинета
          const before = accessText(accessInfo(t));
          if (b.unlimited) t.access_until = "unlimited";
          else {
            const days = Number(b.days);
            if (!Number.isInteger(days) || days < 0 || days > 3650) return json(res, 400, { error: "Дней доступа — целое число от 0 до 3650" });
            t.access_until = accessUntilFor(days);
          }
          saveUser(t); logAccess(before, String(b.note || "").slice(0, 200));
        }
        else if (b.action === "level") { t.level = b.level === null ? undefined : Number(b.level) || 1; saveUser(t); }
        else if (b.action === "reject" || b.action === "delete") {
          if (t.id === me.id) return json(res, 400, { error: "Нельзя удалить самого себя" });
          removeUser(t.id);  // сессии удаляются вместе с пользователем
        }
        else if (b.action === "photos") {   // 3 уровень: квота распознаваний по фото
          t.photos = Math.max(0, Math.floor(Number(b.photos) || 0));
          saveUser(t);
        }
        else return json(res, 400, { error: "Неизвестное действие" });
        return json(res, 200, { users: adminUsersTable() });
      }
    }
    // история доступа (продления/оплаты) — для кабинета
    if (req.method === "GET" && u.pathname === "/api/admin/access-log") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      return json(res, 200, { log: DB.accessLog.list(500) });
    }
    // ---- заявки на регистрацию (форму заполнили, email не подтвердили) — блок в кабинете ----
    if (u.pathname === "/api/admin/registrations") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      if (req.method === "GET") {
        return json(res, 200, { regs: DB.registrations.list().map(r => ({
          login: r.login, name: r.name || "", surname: r.surname || "", patronymic: r.patronymic || "",
          phone: r.phone || "", created: r.created || null, sent: r.sent || null })) });
      }
      if (req.method === "POST") {
        const b = await readBody(req);
        const r = DB.registrations.byLogin(String(b.login || "").trim());
        if (!r) return json(res, 404, { error: "Заявка не найдена — возможно, уже подтверждена или удалена" });
        if (b.action === "delete") {
          DB.registrations.remove(r.token);
          return json(res, 200, { ok: true, message: "Заявка удалена" });
        }
        if (b.action === "resend") {
          // новый токен = новая ссылка и новые 24 часа на подтверждение
          const newToken = crypto.randomBytes(16).toString("hex");
          DB.registrations.retoken(r.token, newToken);
          const base = process.env.BASE_URL || `http://${req.headers.host || "127.0.0.1:8766"}`;
          const mail = await sendEmail(r.login, "Подтверждение регистрации RVA",
            `Здравствуйте, ${r.name || "покупатель"}!\n\nПодтвердите email и получите доступ к проценке по ссылке:\n${base}/confirm?token=${newToken}\nСсылка действует 24 часа.\nВход на сайт — по email и паролю.\n\n— бот Prodobrey / RVA`)
            .catch(e => { throw new HttpError(502, "Письмо отправить не удалось — почтовый сервер недоступен. Попробуйте ещё раз позже."); });
          return json(res, 200, { ok: true, message: mail.sent ? `Письмо со ссылкой отправлено на ${r.login}` : "Тестовый режим: письмо не отправлялось" });
        }
        return json(res, 400, { error: "Неизвестное действие" });
      }
    }
    // ---- близкие: список 5-го уровня и галочка «Четвёртый уровень» (organizer_people.json) ----
    if (req.method === "GET" && u.pathname === "/api/admin/orgpeople") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      return json(res, 200, { people: loadOrgPeople().map(p => ({
        name: p.name || "", phone: p.phone || "", login: p.login || "",
        max_id: p.max_id || "", telegram_id: p.telegram_id || "", level4: !!p.level4 })) });
    }
    if (req.method === "POST" && u.pathname === "/api/admin/orgpeople") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      const b = await readBody(req);
      const people = loadOrgPeople();
      const person = people.find(p =>
        (b.login && p.login && p.login.toLowerCase() === String(b.login).toLowerCase()) ||
        (b.phone && p.phone && normPhone(p.phone) === normPhone(b.phone)) ||
        (b.name && p.name && p.name.toLowerCase() === String(b.name).toLowerCase()));
      if (!person) return json(res, 404, { error: "Человек не найден в списке 5-го уровня" });
      person.level4 = !!b.level4;
      writeJsonAtomic(ORG_FILE, people);
      DB.oAudit.log(currentUser(req)?.login || "—", person.level4 ? "4-й уровень включён" : "4-й уровень снят", null, person.name || person.login || "");
      return json(res, 200, { ok: true, level4: person.level4 });
    }
    // выгрузка в Excel: пользователи, приглашения, история доступа, вопросы
    if (req.method === "GET" && u.pathname === "/api/admin/export.xlsx") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      const buf = adminExportXlsx();
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="rva-users-${new Date().toISOString().slice(0, 10)}.xlsx"`, "Cache-Control": "no-store" });
      return res.end(buf);
    }
    // ---- бот-API: уровень по id мессенджера и привязка аккаунта по телефону ----
    if (req.method === "POST" && u.pathname === "/api/bot/user") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      const field = b.transport === "telegram" ? "telegram_id" : "max_id";
      const u1 = users.find(x => String(x[field] || "") === String(b.tid));
      const transport = b.transport === "telegram" ? "telegram" : "max";
      const invited = u1
        ? invitedCountFor(u1.max_id, "max") + invitedCountFor(u1.telegram_id, "telegram")
        : invitedCountFor(b.tid, transport);
      const today = new Date().toLocaleDateString("sv");
      const photoDay = u1 && u1.photo_day === today;
      const photoUsed = u1 && photoDay ? Math.max(0, Math.floor(Number(u1.photo_used) || 0)) : 0;
      // квота «Фото» на день: 2 — подключившиеся в боте, 4 — зарегистрированные, 6 — с доступом к проценке;
      // число из колонки «Фото» в кабинете (u1.photos) перекрывает уровень
      const photoDefault = !u1 ? 2 : ((u1.l3 || hasAccess(u1)) ? 6 : (u1.approved ? 4 : 2));
      const photos = u1 && u1.photos !== undefined && u1.photos !== null ? Number(u1.photos) : photoDefault;
      return json(res, 200, { found: !!u1, level: levelOf(u1), login: u1 ? u1.login : "", role: u1 ? (u1.role || "user") : "",
                              org: orgAccess(u1),   // 5-й уровень (organizer_people.json) → кнопка «Органайзер» в боте
                              discount: Math.min(10, Math.floor(invited / 10) * 2), invited,
                              access_days: u1 ? accessInfo(u1).days : 0,
                              photos, photo_used: photoUsed,      // 3 уровень: квота распознаваний по фото
                              guest_markup: guestMarkup() });  // бот наценивает гостям так же, как сайт
    }
    if (req.method === "POST" && u.pathname === "/api/bot/photo-used") {  // списать одно фото с дневной квоты (3 уровень)
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      const field = b.transport === "telegram" ? "telegram_id" : "max_id";
      const u1 = users.find(x => x.login && x.login.toLowerCase() === String(b.login || "").toLowerCase())
        || users.find(x => String(x[field] || "") === String(b.tid || ""));
      const today = new Date().toLocaleDateString("sv");
      if (!u1) {   // незарегистрированный (1 уровень): счёт по id мессенджера
        const used = DB.guestPhotos.use((b.transport === "telegram" ? "telegram:" : "max:") + b.tid, today);
        return json(res, 200, { ok: true, used, photos: 2 });
      }
      const used = u1.photo_day === today ? Math.max(0, Math.floor(Number(u1.photo_used) || 0)) : 0;
      u1.photo_day = today;                       // квота «Фото» — дневная: на следующий день сбрасывается
      u1.photo_used = used + 1;
      saveUser(u1);
      return json(res, 200, { ok: true, used: u1.photo_used, photos: Number(u1.photos ?? 6) });
    }
    if (req.method === "POST" && u.pathname === "/api/bot/link") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      // телефон боту присылает сам мессенджер (кнопка «поделиться контактом», бот сверяет,
      // что контакт принадлежит отправителю) — номер, набранный текстом, сюда не попадает
      const phone = normPhone(b.phone);
      if (!/^\d{1,20}$/.test(String(b.tid || ""))) return json(res, 400, { error: "Не указан id пользователя" });
      const field = b.transport === "telegram" ? "telegram_id" : "max_id";
      const u1 = phone ? users.find(x => normPhone(x.phone) === phone) : null;
      if (!u1) return json(res, 200, { found: false, level: 1, login: "" });
      // один аккаунт мессенджера — у одного пользователя: прежняя привязка снимается
      for (const x of users) if (x !== u1 && String(x[field] || "") === String(b.tid)) { delete x[field]; saveUser(x); }
      u1[field] = String(b.tid);
      saveUser(u1);
      return json(res, 200, { found: true, level: levelOf(u1), login: u1.login });
    }
    // поставщики: у директора — общий список (владелец), у 4-го уровня — общий только для чтения,
    // у остальных с полным доступом — ЛИЧНЫЙ список: свои логины и пароли, свои цены, чужим не видны
    if (req.method === "GET" && u.pathname === "/api/suppliers") {
      const me = currentUser(req);
      if (!isFull(me)) return json(res, 200, []);
      if (isAdmin(me)) return json(res, 200, suppliers.map(adminSup));
      if (isLevel4(me)) return json(res, 200, suppliers.filter(s => s.enabled).map(pubSup));
      return json(res, 200, loadUserSups(me.id).map(adminSup));
    }
    // ---- «Проверенные поставщики» — открытый список (видят все, включая гостей) ----
    if (req.method === "GET" && u.pathname === "/api/suppliers/verified") return json(res, 200, { suppliers: verifiedSuppliers() });
    // ---- настройки проценки (только админ): наценка для гостей ----
    if (u.pathname === "/api/admin/settings") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      if (req.method === "POST") {
        const b = await readBody(req);
        if (b.trialDays !== undefined) {               // сколько дней доступа даётся при одобрении регистрации
          const v = Number(b.trialDays);
          if (!Number.isInteger(v) || v < 0 || v > 365) return json(res, 400, { error: "Пробный срок — от 0 до 365 дней" });
          DB.settings.set("trialDays", v);
        }
        if (b.guestMarkupPct !== undefined) {
          const v = Number(b.guestMarkupPct);
          if (!Number.isFinite(v) || v < 0 || v > 500) return json(res, 400, { error: "Наценка — число от 0 до 500 %" });
          DB.settings.set("guestMarkupPct", Math.round(v * 10) / 10);
        }
      }
      return json(res, 200, { guestMarkupPct: guestMarkupPct(), trialDays: DB.settings.get("trialDays", 0) });
    }
    // ---- вход в кабинет поставщика «через браузер»: окно Chrome с его профилем (только на этом компьютере) ----
    if (req.method === "POST" && u.pathname === "/api/suppliers/browser-login") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      const s = suppliers.find(x => x.id === q.get("id"));
      if (!s || s.adapter !== "browser") return json(res, 404, { error: "Поставщик «через браузер» не найден" });
      try { browserLogin(s); } catch (e) { return json(res, 500, { error: "Не удалось открыть браузер: " + e.message }); }
      return json(res, 200, { ok: true, message: "Открыто окно Chrome: войдите в кабинет поставщика и закройте окно — вход сохранится" });
    }
    if (req.method === "POST" && u.pathname === "/api/suppliers") {
      const me = currentUser(req);
      if (!isFull(me)) return json(res, 403, { error: "Добавлять поставщиков может только пользователь с полным доступом" });
      if (isLevel4(me)) return json(res, 403, { error: "Четвёртый уровень работает с общим списком — свой список не подключается" });
      const list = isAdmin(me) ? suppliers : loadUserSups(me.id);
      const saveList = () => { if (isAdmin(me)) saveSups(suppliers); else saveUserSups(me.id, list); };
      const b = await readBody(req);
      const name = (b.name || "").trim(), site = (b.site || "").trim();
      if (!name) return json(res, 400, { error: "Укажите название поставщика" });
      if ((b.mode === "browser" || b.mode === "pricelist") && !isAdmin(me))
        return json(res, 403, { error: "Подключение «через браузер» и прайс-лист настраивает администратор — используйте вкладку «API / логин и пароль»" });
      if (b.mode === "browser") {
        const searchUrl = String(b.searchUrl || "").trim();
        if (!/^https?:\/\/.+\{code\}/.test(searchUrl)) return json(res, 400, { error: "Адрес поиска должен начинаться с http(s):// и содержать {code} на месте артикула" });
        list.push({ id: crypto.randomUUID(), name, site: site || new URL(searchUrl.replace("{code}", "x")).origin, login: "", password: "", apiKey: "",
                         adapter: "browser", searchUrl, enabled: true, onDemand: !!b.onDemand,
                         ...(String(b.clickAfter || "").trim() ? { clickAfter: String(b.clickAfter).trim().slice(0, 80) } : {}) });
        saveList(); clearSearchCache();
        return json(res, 200, { ok: true, suppliers: list.map(adminSup) });
      }
      if (b.mode === "pricelist") {
        const p = (b.path || "").trim();
        if (!p) return json(res, 400, { error: "Укажите путь к файлу прайса" });
        try { parsePriceFile(p); } catch (e) { return json(res, 400, { error: "Прайс не читается: " + e.message }); }
        list.push({ id: crypto.randomUUID(), name, site: site || "прайс-лист", login: "", password: "", apiKey: "", adapter: "pricelist", priceFile: { path: path.relative(PRICES_DIR, pricePath(p)), header: b.header !== false }, enabled: true });
        saveList(); clearSearchCache();
        return json(res, 200, { ok: true, suppliers: list.map(adminSup) });
      }
      let adapter = b.adapter;
      if (!adapter) {
        if (site.includes("sup01")) adapter = (b.apiKey || "").trim() ? "sup01" : "sup01web";
        else if (site.includes("sup02")) adapter = "sup02";
        else if (site.includes("sup03")) adapter = "sup03";
        else if (site.includes("sup04")) adapter = "sup04";
        else if (site.includes("sup05")) adapter = "sup05";
        else if (site.includes("sup06")) adapter = "sup06";
        else if (site.includes("sup07")) adapter = "sup07";
        else if (site.includes("sup08")) adapter = "sup08";
        else if (site.includes("sup09")) adapter = "sup09";
        else if (site.includes("sup10")) adapter = "sup10";
        else if (site.includes("sup11")) adapter = "sup11";
        else if (site.includes("sup12")) adapter = "sup12";   // поставщики общей платформы SearchService
        else if (site.includes("sup15")) adapter = "sup15";   // SOAP v2: вход логин/пароль → остатки с ценами
        else adapter = "none";
      }
      list.push({ id: crypto.randomUUID(), name, site, login: b.login || "", password: b.password || "",
                       apiKey: [(b.apiKey1 || "").trim(), (b.apiKey2 || "").trim()].filter(Boolean).join(":"),
                       adapter, enabled: true, onDemand: !!b.onDemand,
                       ...(/^https?:\/\//.test(String(b.orderUrl || "")) ? { orderUrl: String(b.orderUrl).trim().slice(0, 300) } : {}),
                       ...(/^https?:\/\//.test(String(b.publicUrl || "")) ? { publicUrl: String(b.publicUrl).trim().slice(0, 300) } : {}) });
      saveList(); clearSearchCache();
      return json(res, 200, { ok: true, suppliers: list.map(adminSup) });
    }
    if (req.method === "PUT" && u.pathname === "/api/suppliers") {
      const me = currentUser(req);
      if (!isFull(me) || isLevel4(me)) return json(res, 403, { error: "Менять поставщиков может администратор или владелец своего списка" });
      const list = isAdmin(me) ? suppliers : loadUserSups(me.id);
      const b = await readBody(req);
      const s = list.find(x => x.id === q.get("id") || x.id === b.id);
      if (!s) return json(res, 404, { error: "Поставщик не найден" });
      if (b.name !== undefined) { const v = String(b.name).trim(); if (!v) return json(res, 400, { error: "Название не может быть пустым" }); s.name = v.slice(0, 80); }
      if (b.site !== undefined) s.site = String(b.site).trim().slice(0, 120);
      if (b.login !== undefined) s.login = String(b.login).trim();
      if (b.clickAfter !== undefined) s.clickAfter = String(b.clickAfter).trim().slice(0, 80) || undefined;
      if (b.onDemand !== undefined) s.onDemand = !!b.onDemand;
      if (b.enabled !== undefined) s.enabled = !!b.enabled;   // галочка в «Мои поставщики»: опрашивается у незарегистрированных (гости и боты)
      for (const k of ["orderUrl", "publicUrl"]) {            // необязательные адреса: корзина и список проверенных
        if (b[k] === undefined) continue;
        const v = String(b[k]).trim();
        if (v && !/^https?:\/\//.test(v)) return json(res, 400, { error: "Адрес должен начинаться с http:// или https://" });
        if (v) s[k] = v.slice(0, 300); else delete s[k];
      }
      if (b.searchUrl !== undefined && s.adapter === "browser") {
        const v = String(b.searchUrl).trim();
        if (!/^https?:\/\/.+\{code\}/.test(v)) return json(res, 400, { error: "Адрес поиска должен начинаться с http(s):// и содержать {code} на месте артикула" });
        s.searchUrl = v;
      }
      // пустой пароль в форме = «не менять»
      if (b.password) s.password = String(b.password);
      // форма шлёт apiKey1/apiKey2 (как при добавлении); маскированный ключ «abcd…wxyz» = «не менять»
      const key = b.apiKey !== undefined ? String(b.apiKey).trim()
        : [(b.apiKey1 || "").trim(), (b.apiKey2 || "").trim()].filter(Boolean).join(":");
      if (key && !key.includes("…")) s.apiKey = key;
      if (isAdmin(me)) saveSups(list); else saveUserSups(me.id, list);
      clearSearchCache();
      return json(res, 200, { ok: true, suppliers: list.map(adminSup) });
    }
    if (req.method === "DELETE" && u.pathname === "/api/suppliers") {
      const me = currentUser(req);
      if (!isFull(me) || isLevel4(me)) return json(res, 403, { error: "Удалять поставщиков может администратор или владелец своего списка" });
      const id = q.get("id");
      let list = isAdmin(me) ? suppliers : loadUserSups(me.id);
      list = list.filter(s => s.id !== id);
      if (isAdmin(me)) { suppliers = list; saveSups(suppliers); } else saveUserSups(me.id, list);
      clearSearchCache();
      return json(res, 200, { ok: true, suppliers: list.map(adminSup) });
    }
    // ---- личный кабинет администратора: вся информация в одном месте ----
    if (req.method === "GET" && (decodeURIComponent(u.pathname) === "/кабинет" || u.pathname === "/kabinet")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(PUB, "kabinet.html")));
    }
    if (req.method === "GET" && u.pathname === "/api/admin/info") {
      if (!isAdmin(currentUser(req))) return json(res, 403, { error: "Только для администратора" });
      return json(res, 200, {
        referrals: DB.referrals.list(),
        questions: DB.questions.list(),
      });
    }
    // ---- личный кабинет: свой профиль, смена пароля ----
    if (req.method === "GET" && u.pathname === "/api/auth/profile") {
      const u1 = currentUser(req);
      if (!u1) return json(res, 401, { error: "Нужен вход" });
      return json(res, 200, { profile: {
        login: u1.login, name: u1.name || "", surname: u1.surname || "", patronymic: u1.patronymic || "",
        phone: u1.phone || "", approved: !!u1.approved, role: u1.role || "user", level: levelOf(u1),
        discount: Math.min(10, Math.floor((invitedCountFor(u1.max_id, "max") + invitedCountFor(u1.telegram_id, "telegram")) / 10) * 2),
        created: u1.created || null, access: accessInfo(u1)
      } });
    }
    if (req.method === "POST" && u.pathname === "/api/auth/profile") {
      const u1 = currentUser(req);
      if (!u1) return json(res, 401, { error: "Нужен вход" });
      const b = await readBody(req);
      if (b.name !== undefined) { const v = String(b.name).trim(); if (!v) return json(res, 400, { error: "Имя не может быть пустым" }); u1.name = v.slice(0, 60); }
      if (b.surname !== undefined) u1.surname = String(b.surname).trim().slice(0, 60);
      if (b.patronymic !== undefined) u1.patronymic = String(b.patronymic).trim().slice(0, 60);
      if (b.phone !== undefined) {
        const ph = normPhone(b.phone);
        if (!ph) return json(res, 400, { error: "Телефон указан неверно" });
        // по телефону бот привязывает аккаунт — он должен быть только у одного пользователя
        if (users.some(x => x !== u1 && normPhone(x.phone) === ph)) return json(res, 409, { error: "Этот телефон уже указан у другого пользователя" });
        u1.phone = ph;
      }
      saveUser(u1);
      return json(res, 200, { ok: true, message: "Профиль обновлён" });
    }
    if (req.method === "POST" && u.pathname === "/api/auth/password") {
      const u1 = currentUser(req);
      if (!u1) return json(res, 401, { error: "Нужен вход" });
      const b = await readBody(req);
      const old_p = String(b.old || ""), new_p = String(b.new || "");
      if (!checkPass(u1.pass, old_p)) return json(res, 400, { error: "Старый пароль неверен" });
      if (new_p.length < 8) return json(res, 400, { error: "Новый пароль — от 8 символов" });
      if (new_p === old_p) return json(res, 400, { error: "Новый пароль совпадает со старым" });
      u1.pass = hashPass(new_p);
      saveUser(u1);
      DB.sessions.removeOthers(u1.id, parseCookies(req).sid); // выход на остальных устройствах
      return json(res, 200, { ok: true, message: "Пароль изменён" });
    }
    // ---- лента новостей (публично, просмотр без регистрации) ----
    if (req.method === "GET" && u.pathname === "/api/news") {
      let news = [];
      try { news = JSON.parse(fs.readFileSync(path.join(ROOT, "news.json"), "utf8")) || []; } catch (e) {}
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(JSON.stringify({ news }));
    }
    // ---- добавить новость вручную (кнопка «+» на главной; только 5-й уровень) ----
    if (req.method === "POST" && u.pathname === "/api/news/add") {
      const u1 = currentUser(req);
      if (!orgAccess(u1)) return json(res, 403, { error: "Добавление новостей недоступно" });
      const b = JSON.parse((await readRaw(req)).toString("utf8") || "{}");
      const text = String(b.text || "").trim().slice(0, 5000);
      let image = "";
      if (typeof b.image === "string" && b.image.startsWith("data:image/")) {
        const m = b.image.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([\s\S]+)$/);
        if (!m) return json(res, 400, { error: "Непонятный формат картинки" });
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > 8 * 1024 * 1024) return json(res, 400, { error: "Картинка больше 8 МБ" });
        const ext = m[1] === "jpeg" ? "jpg" : m[1];
        const dir = path.join(PUB, "lenta");
        fs.mkdirSync(dir, { recursive: true });
        const day = todayStr();
        let name = `news-${day}.${ext}`, n = 2;
        while (fs.existsSync(path.join(dir, name))) { name = `news-${day}-${n}.${ext}`; n++; }
        fs.writeFileSync(path.join(dir, name), buf);
        image = "/lenta/" + name;
      }
      if (!text && !image) return json(res, 400, { error: "Добавьте изображение или текст" });
      const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
        "августа", "сентября", "октября", "ноября", "декабря"];
      const d = new Date();
      const list = JSON.parse(fs.readFileSync(path.join(ROOT, "news.json"), "utf8") || "[]");
      list.unshift({ date: `${d.getDate()} ${months[d.getMonth()]}`, title: "", image, text });
      writeJsonAtomic(path.join(ROOT, "news.json"), list);
      DB.oAudit.log(u1.login, "новость в ленту", null, (text || "(картинка)").slice(0, 60));
      return json(res, 200, { ok: true });
    }
    // ---- вопросы из бота (ключ бот-API); вопрос сразу становится задачей органайзера ----
    if (req.method === "POST" && u.pathname === "/api/question") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      const text = String(b.text || "").trim();
      if (!text) return json(res, 400, { error: "Пустой вопрос" });
      const transport = b.transport === "telegram" ? "telegram" : "max";
      const field = transport === "telegram" ? "telegram_id" : "max_id";
      const u1 = users.find(x => String(x[field] || "") === String(b.tid));
      DB.questions.add({ date: new Date().toISOString(), transport,
                         tid: String(b.tid || ""), from: u1 ? u1.login : "", text: text.slice(0, 2000) });
      // задача: заголовок — первые слова вопроса, автор — привязанный логин или id в боте
      const title = text.replace(/\s+/g, " ").slice(0, 80);
      const id = DB.oTasks.add({ title, body: text.slice(0, 2000), source: transport,
        contact: u1 ? u1.login : `id ${b.tid}`, due_date: todayStr(), due_time: null,
        created_at: new Date().toISOString() });
      DB.oAudit.log("бот " + transport, "создана (вопрос из бота)", id, u1 ? u1.login : `id ${b.tid}`);
      return json(res, 200, { ok: true });
    }
    // ---- приглашения: кто кого пригласил в бота (ключ бот-API) ----
    if (req.method === "POST" && u.pathname === "/api/bot/referral") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      const inviterId = String(b.inviter || "").trim();   // id пригласившего в мессенджере
      const tid = String(b.tid || "").trim();             // id приглашённого
      const transport = b.transport === "telegram" ? "telegram" : "max";
      if (!inviterId || !tid) return json(res, 400, { error: "Не указаны участники" });
      if (inviterId === tid) return json(res, 200, { ok: true, note: "самоссылка" });
      const field = transport === "telegram" ? "telegram_id" : "max_id";
      const inviter = users.find(x => String(x[field] || "") === inviterId);
      const added = DB.referrals.add({ date: new Date().toISOString(), transport, tid,
                                       inviter: inviter ? inviter.login : "", inviter_id: inviterId });
      if (!added) return json(res, 200, { ok: true, duplicate: true, inviter_found: !!inviter });
      return json(res, 200, { ok: true, inviter_found: !!inviter });
    }
    // ---- заявка на согласование (2 уровень): результат оценки → задача директору + сообщение ----
    if (req.method === "POST" && u.pathname === "/api/bot/approval") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const b = await readBody(req);
      const code = String(b.code || "").trim(), brand = String(b.brand || "").trim();
      if (!code) return json(res, 400, { error: "Не указан артикул" });
      const u1 = users.find(x => x.login && x.login.toLowerCase() === String(b.login || "").toLowerCase()) || null;
      const fio = u1 ? [u1.surname, u1.name].filter(Boolean).join(" ") : "";
      const phone = u1 && u1.phone ? "+7" + String(u1.phone).replace(/\D/g, "").slice(-10) : "";
      const contact = u1 ? (u1.login || phone || String(b.tid || "")) : String(b.tid || "");
      const today = new Date().toLocaleDateString("sv");   // YYYY-MM-DD по серверному времени
      const t = DB.oTasks.add({ title: `Согласование: ${brand} ${code} — ${fio || contact}`.replace(/\s+/g, " ").trim(),
        body: String(b.text || "").slice(0, 3500),
        source: b.transport === "telegram" ? "telegram" : "max", contact,
        due_date: today, mins: 25, created_at: new Date().toISOString() });
      DB.oAudit.log(contact, "заявка на согласование", t, `${brand} ${code}`.trim());
      const msg = `🔔 Заявка на согласование: ${brand} ${code} — ${fio || contact}` +
        (phone ? ", тел. " + phone : "") + ". Задача добавлена в органайзер на сегодня.";
      for (const a of users.filter(x => x.role === "admin")) {
        if (a.max_id) sendBotMessage("max", a.max_id, msg).catch(e => console.error("[согласование] MAX не ушёл:", e.message));
        if (a.telegram_id) sendBotMessage("telegram", a.telegram_id, msg).catch(e => console.error("[согласование] Telegram не ушёл:", e.message));
      }
      return json(res, 200, { ok: true, task: t });
    }
    // ---- органайзер: только для вошедших с 5-м уровнем (organizer_people.json) ----
    if (u.pathname.startsWith("/api/organizer/")) {
      const u1 = currentUser(req);
      if (!u1) return json(res, 401, { error: "Войдите на сайте" });
      if (!orgAccess(u1)) return json(res, 403, { error: "Нет доступа к органайзеру" });
      return await organizerApi(req, res, u1, u.pathname.slice("/api/organizer/".length), q);
    }
    // ---- органайзер для бота (раздел 6.7): директор читает сканы прямо в чате ----
    if (req.method === "GET" && u.pathname === "/api/bot/organizer/files") {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const files = DB.oFiles.recent(8).map(f => ({ id: f.id, name: f.name, kind: f.kind, yadisk: f.yadisk, created_at: f.created_at }));
      return json(res, 200, { files });
    }
    const bfm = u.pathname.match(/^\/api\/bot\/organizer\/file\/(\d+)$/);
    if (req.method === "GET" && bfm) {
      if (!botKeyOk(req)) return json(res, 403, { error: "Неверный ключ бот-API" });
      const f = DB.oFiles.get(bfm[1]);
      if (!f || f.deleted) return json(res, 404, { error: "Файл не найден" });
      res.writeHead(200, { "Content-Type": f.kind === "image" ? "image/jpeg" : "application/octet-stream",
        "X-File-Name": encodeURIComponent(f.name), "X-File-Kind": f.kind,
        "X-File-Yadisk": encodeURIComponent(f.yadisk || "") });
      return res.end(orgRead(f));
    }
    if (req.method === "GET" && u.pathname === "/api/search/recent") {
      const u1 = currentUser(req);
      return json(res, 200, { recent: (u1 && u1.approved && u1.extra && u1.extra.recent) || [] });
    }
    if (req.method === "GET" && u.pathname === "/api/brands") return guestLimited(req, res) || await apiBrands(req, res, q);
    if (req.method === "GET" && u.pathname === "/api/search") return guestLimited(req, res) || await apiSearch(req, res, q);
    // массовая проценка (XLSX/CSV) — только полным доступом, см. блок «массовая проценка»
    if (req.method === "POST" && u.pathname === "/api/bulk/parse") return bulkParse(req, res, q);
    if (req.method === "POST" && u.pathname === "/api/bulk/start") return bulkStart(req, res);
    if (req.method === "GET" && u.pathname === "/api/bulk/status") return bulkStatus(req, res, q);
    if (req.method === "GET" && u.pathname === "/api/bulk/report") return bulkReport(req, res, q);
    res.writeHead(404); res.end("Not found");
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    json(res, e instanceof HttpError ? e.status : 500, { error: String(e && e.message || e) });
  }
});

// по умолчанию только локально (на VPS снаружи — через nginx); HOST=0.0.0.0 — открыть в сеть
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => console.log(`Проценка: http://${HOST}:${PORT}`));
