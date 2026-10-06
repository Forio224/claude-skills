"""Пример спецификации инцидента для scripts/incident_kit.py (уровень 2).

Это инцидент «Касса»: изменяемый аргумент по умолчанию копит промокоды между запросами.
Образец формата — НЕ давать как новую игру тому, кто его уже сыграл.
Порядок полей: сначала нейтральные (дата, таймлайн, формат лога), код с багом и SECRET — в конце,
чтобы в видимом превью записи файла не оказалось спойлера.
"""

DATE = "2026-09-29"
ENTRY = "shop.checkout:checkout"  # handler(request: dict) -> (status, body); sim.py генерируется сам


def request_head(rid, req):
    promo = str(req.get("promo", [])).replace("'", '"')
    return f"req={rid} POST /checkout items={len(req['items'])} promo={promo}"


def ok_tail(status, body):
    if status != 200:
        return f"{status} {body}"
    return f"200 subtotal={body['subtotal']} discount={body['discount']} total={body['total']}"


def it(*pairs):
    return [{"sku": s, "qty": q} for s, q in pairs]


# (время, "строка лога") | (время, запрос) | None — рестарт воркера (новый процесс)
TIMELINE = [
    ("09:00:02", "INFO  deploy v1.8.3: worker pid=4121 started"),
    ("09:03:15", {"items": it(("mug", 1)), "promo": []}),
    ("09:11:40", {"items": it(("hoodie", 1), ("mug", 1)), "promo": ["welcome10"]}),
    ("09:18:02", {"items": it(("notebook", 2)), "promo": []}),
    ("09:26:51", "WARN  catalog: cache miss, db fetch took 912ms"),
    ("09:26:52", {"items": it(("backpack", 1)), "promo": [" Autumn15"]}),
    ("09:40:09", {"items": it(("cap", 1)), "promo": []}),
    ("10:05:33", {"items": it(("mug", 2)), "promo": ["WELCOME10"]}),
    ("10:21:47", "WARN  db: pool exhausted, waited 1.4s for connection"),
    ("10:21:49", {"items": it(("hoodie", 1)), "promo": ["VIP20"]}),
    ("10:34:12", {"items": it(("mug", 1)), "promo": []}),
    ("11:40:00", "INFO  worker pid=4121 restarted manually (on-call)"),
    None,
    ("11:40:02", "INFO  worker pid=4388 started"),
    ("11:52:18", {"items": it(("cap", 2)), "promo": []}),
    ("12:07:44", {"items": it(("hoodie", 1)), "promo": ["vip20"]}),
    ("12:30:11", {"items": it(("mug", 1), ("notebook", 1)), "promo": ["WELCOME10"]}),
    ("13:15:23", {"items": it(("mug", 1)), "promo": ["AUTUMN15"]}),
    ("13:50:00", "ALERT checkout 5xx rate > 20% for 15m"),
]

# Объявляется игроку в брифинге ДО первого хода.
STAND_DIFF = ("shop/catalog.py на стенде — заглушка со словарём цен; в проде цены из БД через кэш, "
              "код слоя БД в материалы не входит. checkout.py и promo.py идентичны проду. "
              "На стенде нет БД, пула и драйвера; запросы идут по очереди через один процесс.")

FILES = {
    "shop/__init__.py": "",
    "shop/catalog.py": '''\
"""Каталог товаров. В проде цены приходят из БД через кэш; на стенде — словарь."""

PRICES = {"mug": 490, "notebook": 390, "cap": 800, "hoodie": 2990, "backpack": 3490}


def price(sku):
    return PRICES[sku]
''',
    "CHANGELOG.md": '''\
## v1.8.3 — 2026-09-29
- Обновлён драйвер PostgreSQL (psycopg 3.1 → 3.2), размер пула соединений 10 → 8.
- Промокоды: нормализация (пробелы, регистр), отбрасываются повторы и неизвестные коды.
''',
    "shop/checkout.py": '''\
"""Обработчик POST /checkout."""

from shop import catalog, promo


def checkout(request):
    """Считает заказ. Возвращает (http_status, body)."""
    try:
        subtotal = sum(catalog.price(i["sku"]) * i["qty"] for i in request["items"])
    except KeyError as e:
        return 404, {"error": f"unknown field or sku: {e}"}

    codes = promo.collect_codes(request.get("promo", []))
    pct = promo.discount_percent(codes)
    total = round(subtotal * (100 - pct) / 100, 2)
    return 200, {"subtotal": subtotal, "discount": pct, "total": total}
''',
    "shop/promo.py": '''\
"""Промокоды и расчёт скидки."""

PROMOS = {"WELCOME10": 10, "AUTUMN15": 15, "VIP20": 20}
MAX_DISCOUNT = 30  # бизнес-правило: суммарная скидка не больше 30 %


def collect_codes(raw_codes, applied=[]):
    """Возвращает список валидных кодов без повторов."""
    for code in raw_codes:
        code = code.strip().upper()
        if code in PROMOS and code not in applied:
            applied.append(code)
    return applied


def discount_percent(codes):
    total = sum(PROMOS[c] for c in codes)
    if total > MAX_DISCOUNT:
        raise ValueError(f"discount {total}% exceeds limit {MAX_DISCOUNT}%")
    return total
''',
}

# Каждая t_* получает load(имя_модуля) и выполняется на свежем импорте кода игрока.
HIDDEN_TESTS = '''\
def co(load):
    return load("shop.checkout").checkout


def req(promo, sku="hoodie"):
    return {"items": [{"sku": sku, "qty": 1}], "promo": promo}


def ok(result, pct):
    status, body = result
    assert status == 200, status
    assert body["discount"] == pct, body


def t_no_leak_to_empty(load):
    c = co(load)
    ok(c(req(["VIP20"])), 20)
    ok(c(req([])), 0)


def t_distinct_users_in_row(load):
    c = co(load)
    for code, pct in [("WELCOME10", 10), ("AUTUMN15", 15), ("VIP20", 20)]:
        ok(c(req([code])), pct)


def t_normalization_and_duplicates(load):
    ok(co(load)(req([" vip20 ", "VIP20"])), 20)


def t_long_run(load):
    c = co(load)
    for i in range(200):
        status, _ = c(req([["WELCOME10"], ["AUTUMN15"], ["VIP20"], []][i % 4]))
        assert status == 200, (i, status)
'''

REFERENCE_PATCH = [
    {"file": "shop/promo.py", "old": "def collect_codes(raw_codes, applied=[]):",
     "new": "def collect_codes(raw_codes, applied=None):"},
    {"file": "shop/promo.py", "old": "    for code in raw_codes:",
     "new": "    if applied is None:\n        applied = []\n    for code in raw_codes:"},
]

SECRET = {
    "incident": "example-kassa",
    "level": 2,
    "root_cause": "promo.collect_codes: applied=[] создаётся один раз при определении функции, коды копятся "
                  "между запросами в жизни воркера; при сумме > 30% ValueError -> 500 до рестарта.",
    "secondary_effect": "до первых 500 клиенты получали чужие скидки (без кода — 10/25/30%, AUTUMN15 — 25%).",
    "red_herrings": ["драйвер БД и пул 10->8", "WARN db pool exhausted рядом с 500 по времени"],
    "language_topic": "изменяемый аргумент по умолчанию",
    "design_question": "легальная комбинация кодов > 30% тоже даёт 500, а должна давать 4xx или срез до лимита",
}
