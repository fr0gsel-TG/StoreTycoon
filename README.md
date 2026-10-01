# StoreTycoon: IT Empire

Telegram Mini App в жанре Tycoon/Idle. Игрок управляет IT-компанией: нанимает
сотрудников, покупает оборудование, расширяет офис, выполняет квесты,
зарабатывает игровую валюту (TSP) и донатит за премиальную (TST) через TON.

Этот файл фиксирует **фактическое** текущее состояние архитектуры — что где
лежит, как компоненты связаны и на что стоит обратить внимание при следующей
доработке. Актуален на дату последней правки; при значимых архитектурных
изменениях обновляйте вместе с кодом.

---

## Стек

| Слой | Технология |
|---|---|
| Клиент | Vanilla JS, HTML5 Canvas (изометрический рендер), Tailwind CSS (CDN) |
| Игровой бэкенд | Node.js + Express, Vercel Serverless Functions |
| БД | Firebase Firestore (доступ только через Admin SDK на сервере) |
| Авторизация | HMAC-SHA256 проверка `Telegram.WebApp.initData` |
| Платежи (TON) | TonConnect UI + TonWeb, отдельный Vercel-проект |
| Уведомления | Telegram Bot API, Vercel Cron |

Фреймворков вроде React/Vue на клиенте нет и не планируется — весь UI и
игровая логика клиента живут в одном файле `index.html`.

---

## Структура репозитория

```
├── index.html              # Весь клиент: UI, canvas-рендер, игровой цикл,
│                            # SaveSystem, вся сетевая логика к API
├── api/
│   ├── game.js              # Основной бэкенд — единая Express-функция,
│   │                         # обрабатывает почти весь /api/*
│   ├── bot.js                # Telegram-бот: /start, выдача кнопки запуска игры
│   └── checkOfflineIncome.js # Cron-хендлер: пуш о накопленном оффлайн-доходе
├── vercel.json              # Роутинг (rewrites) + расписание cron
└── firebase.json            # ⚠️ Мёртвый конфиг, см. "Технический долг"
```

Второй, независимый Vercel-проект (`project-ma0qy.vercel.app`, вне этого
репозитория) отвечает только за донаты: `createInvoice.js` создаёт TON-счёт,
`checkPayment.js` проверяет оплату в блокчейне и сам пишет `tst` игроку
напрямую в Firestore, в обход `game.js`.

---

## Архитектура: server-authoritative

Правило: **клиент ничего не решает про экономику, только показывает**.
Любое действие, которое меняет баланс/инвентарь/прогресс, идёт отдельным
запросом на конкретный `/api/action/*`-эндпоинт; сервер сам:

1. проверяет подпись `initData` (`verifyTelegramAuth`, HMAC-SHA256 от
   `TELEGRAM_BOT_TOKEN`); подпись старше
   `INIT_DATA_MAX_AGE_SEC` (по умолчанию 24 ч) отклоняется;
2. читает текущее состояние игрока из Firestore внутри транзакции
   (`db.runTransaction`);
3. пересчитывает цену/доход по собственным формулам (клиентским цифрам не
   доверяет);
4. пишет результат и возвращает его клиенту — клиент просто подставляет
   пришедшие числа в `GameState`, не считает их сам.

```
index.html (клиент)                    game.js (Vercel, Express)          Firestore
      │                                        │                              │
      │── POST /api/action/buy-item ──────────►│                              │
      │                                        │── runTransaction ───────────►│
      │                                        │   читает progress,           │
      │                                        │   проверяет баланс/лимит,    │
      │                                        │   пересчитывает доход        │
      │                                        │──────────────────────────────►│ update
      │◄── { newBalance, newAutoClicker, ... } │                              │
      │  (просто присваивает в GameState)      │                              │
```

Все запросы к `/api/*`, кроме `/bot/*`, идут через один и тот же файл
`game.js` — это единая Express-функция с внутренним роутингом (см.
`vercel.json`), а не набор отдельных serverless-функций на каждый эндпоинт.

### Формула дохода — единственный источник истины

```js
// game.js — GameFormulas.recalculateGlobalIncome
доход = Σ (count(itemId) × item.income × level(itemId) ^ 1.2)
```

Пересчитывается на сервере при любом действии, влияющем на доход (покупка,
апгрейд). Клиент income сам не считает — берёт готовое число из ответа
сервера. Формула стоимости следующей копии предмета (`base × 5^count`)
продублирована на клиенте (`getCurrentItemStats` в `index.html`) только для
отображения цены в магазине **до** покупки — фактическое списание всё равно
проверяет и делает сервер.

---

## API-эндпоинты

Все — в `api/game.js`, все POST кроме `/api/health` (GET). Каждый начинается
с `verifyTelegramAuth(initData)`, кроме `/api/health`.

| Эндпоинт | Назначение |
|---|---|
| `/api/load` | Загрузка прогресса; создаёт нового игрока, если документа нет; считает оффлайн-доход (1 ч < время оффлайн ≤ `progress.offlineLimit`, базово 3 ч) |
| `/api/action/buy-item` | Покупка предмета/сотрудника — серверная цена, лимиты, слот в комнате |
| `/api/action/buy-room` | Разблокировка комнаты |
| `/api/action/apply-upgrades` | Массовое применение апгрейдов уровня предметов (батчем из `UpgradeBuffer`) |
| `/api/action/sync-income` | Начисление накопленного дохода (батчем из `ClickBuffer`, раз в 30 сек). Сервер начисляет не больше, чем игрок мог заработать с прошлой синхронизации (`progress.lastIncomeSync`, окно до 5 мин) |
| `/api/action/complete-quest` | Завершение квеста, выдача награды, активация следующего, реферальная награда за `intro` |
| `/api/action/buy-skin` | Покупка скина за TST |
| `/api/action/equip-skin` | Смена уже купленного скина (проверяет владение) |
| `/api/action/save-meta` | Некритичные UI-метаданные: `shownDialogues`, `camera` — без баланса/предметов |
| `/api/action/fix-server` | Ручная починка "упавшего" сервера (см. ограничение ниже) |
| `/api/action/check-subscription` | Проверка подписки на Telegram-канал, награда 50 TST |
| `/api/action/claim-instagram` | Награда за переход в Instagram, 50 TST |
| `/api/action/upgrade-offline` | Покупка увеличения лимита оффлайн-дохода за TST |
| `/api/action/save-wallet` | Привязка/отвязка TON-кошелька (адрес приходит от `tonConnectUI.onStatusChange`) |
| `/api/handle-start` | Регистрация реферала при переходе по `ref_<id>`. Из Mini App — по подписанному `initData` (`start_param`), от бота — с заголовком `x-internal-secret`. Только для новых игроков |
| `/api/game/reset` | Полное удаление документа игрока |
| `/api/health` | Health-check |
| `/api/checkOfflineIncome` | Отдельный файл (`checkOfflineIncome.js`), дёргается Vercel Cron раз в день, шлёт Telegram-пуш игрокам с накопленным оффлайн-доходом |

`api/bot.js` (отдельный процесс, роутится через `/bot/(.*)`):

| Эндпоинт | Назначение |
|---|---|
| `/bot/webhook` | Обрабатывает `/start` и `/start ref_<id>`, отправляет кнопку запуска игры |
| `/bot/health` | Health-check |

---

## Модель данных (Firestore)

### `players/{telegram_id}`

```js
{
  progress: {
    tsp: number,              // основная валюта
    tst: number,               // премиальная валюта (донат)
    autoClicker: number,       // доход/сек — считается только сервером
    clickPower: number,
    objects: [{ id, x, y, ... }],
    npcs: [{ id, name, x, y, state, ... }],
    itemLevels: { [itemId]: level },
    limits: { [itemId]: number },        // лимиты покупки по уровню компании
    roomPrices: { [roomId]: number },
    unlockedRooms: string[],
    questsData: { activeQuests, completedQuests, failedQuests, stats },
    playerSkins: string[],
    appliedSkins: { [npcTypeId]: skinId },
    shownDialogues: string[],            // пишется только через save-meta
    camera: { x, y, zoom },              // пишется только через save-meta
    instagramRewardClaimed: boolean,
    telegramRewardClaimed: boolean,
    lastSaved: timestamp,
    walletAddress: string | null
  },
  createdAt: timestamp
}
```

### `referrals/{telegram_id}`

```js
{ referrerId: string, status: 'pending' | 'completed', createdAt: timestamp }
```

Награда пригласившему (50 TST) начисляется не сразу при регистрации
реферала, а при завершении новым игроком квеста `intro` — см.
`complete-quest`.

Коллекций `sessions` и `transactions`, описанных в старом черновике
`INSTRUCTIONS_SAVE_SYSTEM.md`, **в реальной схеме нет** — тот документ
описывал нереализованный план и подлежит удалению из репозитория.

---

## Безопасность

- **Firestore Security Rules** — `allow read, write: if false` по умолчанию
  на `/{document=**}`. Прямой доступ к БД с клиента невозможен, вся запись —
  только через Admin SDK на сервере.
- **Telegram initData** проверяется HMAC-SHA256 на каждом эндпоинте
  (`verifyTelegramAuth`).
- **Сервер не доверяет клиентским числам** — баланс, цены и лимиты всегда
  пересчитываются на бэкенде из состояния в БД, а не из тела запроса.

---

## Технический долг / известные ограничения

Это не todo-лист «сделать красиво», а конкретные места, о которых нужно
помнить, если снова туда полезете:

- **`firebase.json`** — конфигурирует Cloud Functions, которые ни разу не
  деплоились (подтверждено в консоли: "Waiting for your first deploy").
  Безопасно удалить файл целиком; весь реальный бэкенд — на Vercel.
- **`INSTRUCTIONS_SAVE_SYSTEM.md`** — нереализованный черновик архитектуры
  сохранений (сессии, `cash_last_verified` и т.д.), не соответствует коду.
  Подлежит удалению.
- **`isServerDown` не авторитетен на сервере.** Краш "сервера" в игре —
  чисто клиентская случайность (`gameLoop`), на бэкенд никогда не
  репортится. `ClickBuffer.tick()` останавливает накопление дохода при
  `isServerDown === true`, но это самоналагаемый клиентский штраф: ничто не
  мешает обойти его правкой `GameState.isServerDown` в консоли браузера.
  `/api/action/fix-server` по той же причине не проверяет, действительно ли
  сервер "упал" — только личность игрока. Если механика когда-нибудь должна
  стать частью реальной анти-чит логики, а не просто визуальным эффектом —
  нужно заводить `progress.isServerDown` в БД и репортить сам факт краша на
  сервер в момент его наступления. Это отдельная, более крупная задача.

---

## Переменные окружения (Vercel)

| Переменная | Где используется |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Admin SDK в `game.js` / `checkOfflineIncome.js` |
| `TELEGRAM_BOT_TOKEN` | Проверка `initData`, отправка сообщений через Bot API |
| `TELEGRAM_WEBHOOK_SECRET` | Проверка вебхука в `bot.js` и внутренних вызовов `bot.js` → `/api/handle-start` |
| `INIT_DATA_MAX_AGE_SEC` | Необязательно. Максимальный возраст подписи `initData`, по умолчанию 86400 (24 ч) |
| `CRON_SECRET` | Проверяется в `checkOfflineIncome.js` (`Authorization: Bearer ...`) — задаётся вручную, Vercel не генерирует значение сам |

---

## Фоновые задачи

`vercel.json` → `crons`: `/api/checkOfflineIncome` раз в день (`0 12 * * *`).
Это ограничение Hobby-тарифа Vercel (более частые расписания не проходят
деплой); на Pro можно сократить интервал вплоть до 4 часов — ровно тот порог,
после которого в `checkOfflineIncome.js` начинает считаться оффлайн-доход.

---

## Локальная разработка / деплой

```bash
vercel --prod
```

Требует авторизованного `vercel login` с доступом к проекту (org/team,
под которым он создан) — см. `vercel whoami` при проблемах с правами.
