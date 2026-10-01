const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '4mb' })); // 4mb — для картинки карточки (/api/share/prepare)
app.use(cors()); // Разрешаем запросы от игры

// ==========================================
// 1. ИНИЦИАЛИЗАЦИЯ FIREBASE (без изменений)
// ==========================================
try {
    if (!admin.apps.length) {
        let privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, '\n');
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey,
            }),
        });
    }
} catch (error) {
    console.error("🔥 Ошибка инициализации Firebase:", error);
}

const db = admin.firestore();

// ==========================================
// 2. ФУНКЦИИ ВЕРИФИКАЦИИ TELEGRAM (без изменений)
// ==========================================
// Максимальный возраст подписи Telegram initData (по умолчанию 24 часа).
const INIT_DATA_MAX_AGE_SEC = parseInt(process.env.INIT_DATA_MAX_AGE_SEC, 10) || 86400;

function verifyTelegramAuth(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (!hash || hash.length !== computedHash.length) return false;
        if (!crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'))) return false;

        // initData без срока годности можно переиспользовать бесконечно —
        // отклоняем слишком старые подписи.
        const authDate = parseInt(params.get('auth_date'), 10);
        if (!authDate) return false;
        const ageSec = Math.floor(Date.now() / 1000) - authDate;
        if (ageSec > INIT_DATA_MAX_AGE_SEC) return false;
        return true;
    } catch (e) {
        console.error("Ошибка проверки подписи Telegram:", e);
        return false;
    }
}

function getPlayerIdFromInitData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user') || '{}');
        return user.id ? user.id.toString() : null;
    } catch (e) {
        return null;
    }
}

// lastSaved исторически писался то числом (Date.now()), то Firestore Timestamp.
// Приводим к миллисекундам, чтобы расчёты времени не превращались в NaN.
function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    return null;
}

// Базовый лимит оффлайн-дохода (3 часа) — совпадает с клиентом и тирами upgrade-offline.
const DEFAULT_OFFLINE_LIMIT_SEC = 10800;

// Ограничения для /api/action/sync-income
const MAX_SYNC_WINDOW_SEC = 300;     // максимум 5 минут дохода за один запрос
const MAX_CLICKS_PER_SEC = 15;       // потолок ручных кликов в секунду
const MAX_INCOME_MULTIPLIER = 2;     // максимальный множитель дохода от игровых событий

// ==========================================
// 3. СЕРВЕРНАЯ ЛОГИКА ИГРЫ (МОЗГ ИГРЫ)
// ==========================================
// ВАЖНО: Эти данные должны быть идентичны тем, что на клиенте.
// В будущем их можно вынести в общий файл.
const ITEM_TYPES = {
    workstation_basic: { id: 'workstation_basic', name: 'Базовое рабочее место', cost: 700, income: 5, renderType: 'workstation', type: 'workstation' },
    server_rack: { id: 'server_rack', name: 'Сервер', cost: 1200, income: 15, renderType: 'server' },
    plant: { id: 'plant', name: 'Фикус', cost: 25, income: 0, renderType: 'plant' },
    employee_dev: { id: 'employee_dev', name: 'Junior Dev', cost: 2500, income: 30, renderType: 'npc' },
    employee_manager: { id: 'employee_manager', name: 'Team Lead', cost: 5000, income: 60, renderType: 'npc' },
    coffee_machine: { id: 'coffee_machine', name: 'Кофемашина', cost: 800, income: 0, renderType: 'appliance' },
    whiteboard: { id: 'whiteboard', name: 'Маркерная доска', cost: 300, income: 0, renderType: 'board' }
};

// Вставьте этот код в game.js после объекта ITEM_TYPES

const RoomSystem = {
    rooms: [
        { id: 'dev_room', name: 'Dev Zone', x: 2, y: 2, width: 7, height: 9 },
        { id: 'server_room', name: 'Server Room', x: 12, y: 2, width: 5, height: 6 },
        { id: 'meeting_room', name: 'Meeting', x: 12, y: 11, width: 5, height: 4 },
        { id: 'break_room', name: 'Lounge', x: 2, y: 13, width: 7, height: 4 }
    ],
    getRoomForItem(itemId) {
        if (itemId === 'server_rack') return this.rooms.find(r => r.id === 'server_room');
        if (['coffee_machine', 'plant'].includes(itemId)) return this.rooms.find(r => r.id === 'break_room');
        if (itemId === 'whiteboard') return this.rooms.find(r => r.id === 'meeting_room');
        return this.rooms.find(r => r.id === 'dev_room');
    },
};

const OfficeLayout = {
    isPositionOccupied(x, y, objects) {
        return objects.some(obj => obj.x === x && obj.y === y);
    },
    getNextSlot(itemId, objects) {
        const targetRoom = RoomSystem.getRoomForItem(itemId);
        if (!targetRoom) return null; // Нет комнаты для предмета

        // Ищем свободное место внутри комнаты, отступая от стен
        for (let ry = 1; ry < targetRoom.height - 1; ry++) {
            for (let rx = 1; rx < targetRoom.width - 1; rx++) {
                const worldX = targetRoom.x + rx;
                const worldY = targetRoom.y + ry;
                if (!this.isPositionOccupied(worldX, worldY, objects)) {
                    return { x: worldX, y: worldY };
                }
            }
        }
        return null; // Комната заполнена
    }
};

// ==========================================
// 1. ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ (ФОРМУЛЫ)
// ==========================================
const GameFormulas = {
    getUpgradeCost(item, level) {
        // Используем степень 1.5, как в твоем исходном коде
        return Math.floor((item.cost * Math.pow(level, 1.5)) * 0.8);
    },
    
    getItemIncome(item, level) {
        return item.income > 0 ? (item.income * Math.pow(level, 1.2)) : 0;
    },

    recalculateGlobalIncome(progress) {
        let totalIncome = 0;
        const items = [...(progress.objects || []), ...(progress.npcs || [])];
        const itemLevels = progress.itemLevels || {};

        const uniqueItemIds = [...new Set(items.map(i => i.id))];
        
        uniqueItemIds.forEach(itemId => {
            const itemConfig = ITEM_TYPES[itemId];
            if (!itemConfig || itemConfig.income <= 0) return;

            const count = items.filter(i => i.id === itemId).length;
            const level = itemLevels[itemId] || 1;
            // Вызываем через GameFormulas для надежности
            const incomePerItem = GameFormulas.getItemIncome(itemConfig, level);
            
            totalIncome += count * incomePerItem;
        });

        return totalIncome;
    }
};

function getCurrentItemStats(itemId, currentObjects, currentNpcs) {
    const item = ITEM_TYPES[itemId];
    if (!item) return { cost: 0, income: 0 };
    const count = [...(currentObjects || []), ...(currentNpcs || [])].filter(o => o.id === itemId).length;
    const currentCost = item.cost * Math.pow(5, count);
    const currentIncome = item.income ? item.income * Math.pow(2, count) : 0;
    return { cost: currentCost, income: currentIncome };
}


// ==========================================
// 4. НОВЫЕ БЕЗОПАСНЫЕ ЭНДПОИНТЫ
// ==========================================

/**
 * НОВЫЙ ЭНДПОИНТ
 * Безопасно добавляет накопленный доход к балансу игрока в БД.
 * Использует транзакцию, чтобы избежать гонки данных.
 */
app.post('/api/action/sync-income', async (req, res) => {
    try {
        const { initData, amount } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return res.status(403).json({ success: false, error: 'Неверные данные.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) {
            return res.status(400).json({ success: false, error: 'Не удалось определить ID игрока.' });
        }

        const playerRef = db.collection('players').doc(playerId);
        let newBalance = 0;
        let newAutoClicker = 0;
        let credited = 0;
        let knownLeague = null;
        let knownClan = null;
        let syncElapsedSec = 0;

        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            // Игрок создаётся только через /api/load — здесь не создаём.
            if (!playerDoc.exists) throw new Error('PLAYER_NOT_FOUND');

            const progress = playerDoc.data().progress || {};
            knownLeague = playerDoc.data().league || null;
            knownClan = playerDoc.data().clan || null;
            const now = Date.now();

            // Сервер сам считает, сколько игрок мог заработать с прошлой синхронизации.
            // Сумма от клиента — только заявка, начисляется не больше потолка.
            const lastSync = toMillis(progress.lastIncomeSync) || toMillis(progress.lastSaved) || now;
            const elapsedSec = Math.min(Math.max((now - lastSync) / 1000, 0), MAX_SYNC_WINDOW_SEC);
            syncElapsedSec = elapsedSec;

            newAutoClicker = GameFormulas.recalculateGlobalIncome(progress);
            const clickPower = progress.clickPower || 1;
            const boostMult = LeagueRewards.activeBoostMult(progress, now);
            const maxAllowed = elapsedSec * (newAutoClicker * MAX_INCOME_MULTIPLIER * boostMult + clickPower * MAX_CLICKS_PER_SEC);

            credited = Math.min(amount, maxAllowed);
            newBalance = (progress.tsp || 0) + credited;

            transaction.update(playerRef, {
                'progress.tsp': newBalance,
                'progress.autoClicker': newAutoClicker,
                'progress.lastSaved': now,
                'progress.lastIncomeSync': now
            });
        });

        await LeagueSystem.addPoints(playerId, credited, LeagueSystem.displayName(initData), knownLeague);
        await ClanSystem.addCup(playerId, knownClan, credited, newAutoClicker, syncElapsedSec, knownLeague && knownLeague.tier);
        res.json({ success: true, newBalance, newAutoClicker, credited });

    } catch (error) {
        if (error.message === 'PLAYER_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        }
        console.error("Ошибка при синхронизации дохода:", error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// Данные о скинах — ТОЛЬКО на сервере, единый источник для buy-skin/equip-skin
const SKINS_SERVER = {
    npc1: { price: 100 }, npc2: { price: 250 }, npc3: { price: 500 },
    npc4: { price: 800 }, npc5: { price: 2000 }, npc6: { price: 3500 },
    npc7: { price: 5000 }, pepe: { price: 15000 }, freedur: { price: 25000 }
};

app.post('/api/action/buy-skin', async (req, res) => {
    try {
        const { initData, skinId, npcTypeId } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId || !skinId || !npcTypeId) {
            return res.status(400).json({ success: false, error: 'Неверные данные запроса.' });
        }

        const skin = SKINS_SERVER[skinId];
        if (!skin) {
            return res.status(400).json({ success: false, error: 'Скин не найден.' });
        }

        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        await db.runTransaction(async (t) => {
            const doc = await t.get(playerRef);
            if (!doc.exists) throw new Error("Игрок не найден.");

            const progress = doc.data().progress || {};
            if ((progress.tst || 0) < skin.price) throw new Error("Недостаточно TST.");

            const newTst = progress.tst - skin.price;
            const playerSkins = [...(progress.playerSkins || ['npc1'])];
            if (!playerSkins.includes(skinId)) playerSkins.push(skinId);
            const appliedSkins = { ...(progress.appliedSkins || {}), [npcTypeId]: skinId };

            t.update(playerRef, {
                'progress.tst': newTst,
                'progress.playerSkins': playerSkins,
                'progress.appliedSkins': appliedSkins
            });

            finalState = { newTst, newPlayerSkins: playerSkins, newAppliedSkins: appliedSkins };
        });

        res.json({ success: true, ...finalState });
    } catch (error) {
        console.error('[BUY-SKIN-ERROR]', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Экипировка уже купленного скина — отдельно от покупки, проверяет владение на сервере
app.post('/api/action/equip-skin', async (req, res) => {
    try {
        const { initData, skinId, npcTypeId } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId || !skinId || !npcTypeId) {
            return res.status(400).json({ success: false, error: 'Неверные данные запроса.' });
        }

        if (!SKINS_SERVER[skinId]) {
            return res.status(400).json({ success: false, error: 'Скин не найден.' });
        }

        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        await db.runTransaction(async (t) => {
            const doc = await t.get(playerRef);
            if (!doc.exists) throw new Error("Игрок не найден.");

            const progress = doc.data().progress || {};
            const playerSkins = progress.playerSkins || ['npc1'];

            if (!playerSkins.includes(skinId)) {
                throw new Error("Скин не куплен.");
            }

            const appliedSkins = { ...(progress.appliedSkins || {}), [npcTypeId]: skinId };
            t.update(playerRef, { 'progress.appliedSkins': appliedSkins });

            finalState = { newAppliedSkins: appliedSkins };
        });

        res.json({ success: true, ...finalState });
    } catch (error) {
        console.error('[EQUIP-SKIN-ERROR]', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Ручная починка упавшего сервера — fallback-путь для игрока без Team Lead.
// Бесплатно по требованию продукта. ВАЖНО: "сервер упал" — чисто клиентское
// состояние (случайный краш считается в gameLoop на фронте и никогда не
// репортится на бэкенд), поэтому здесь нет и не может быть проверки "а правда
// ли сервер сейчас недоступен" — только подтверждение, что это реальный игрок.
// Если понадобится закрыть эту дыру по-настоящему, нужно сначала сделать
// progress.isServerDown авторитетным полем (репортить краш на сервер в момент
// его наступления), это отдельная, более крупная задача.
app.post('/api/action/fix-server', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) {
            return res.status(400).json({ success: false, error: 'ID игрока не найден.' });
        }

        const doc = await db.collection('players').doc(playerId).get();
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[FIX-SERVER-ERROR]', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * НОВЫЙ ЭНДПОИНТ
 * Безопасно обрабатывает покупку предмета.
 * Проверяет баланс, стоимость и лимиты на сервере.
 */
app.post('/api/action/buy-item', async (req, res) => {
    try {
        const { initData, itemId } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        // 1. Верификация
        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        const item = ITEM_TYPES[itemId];

        if (!playerId || !item) {
            return res.status(400).json({ success: false, error: 'Неверные данные запроса.' });
        }

        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        // 2. Транзакция для обеспечения целостности данных
        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            if (!playerDoc.exists) {
                throw new Error("Игрок не найден. Перезапустите игру.");
            }

            const progress = playerDoc.data().progress || {};
            
            // Копируем данные, чтобы не мутировать исходный объект раньше времени
            let balance = progress.tsp || 0;
            const objects = [...(progress.objects || [])];
            const npcs = [...(progress.npcs || [])];
            const itemLevels = progress.itemLevels || {};

            // Получаем актуальную стоимость (с учетом уровней, если нужно)
            const stats = getCurrentItemStats(itemId, objects, npcs);

            if (balance < stats.cost) {
                throw new Error("Недостаточно средств!");
            }

            // --- ЛОГИКА РАЗМЕЩЕНИЯ ---
            const targetRoom = RoomSystem.getRoomForItem(itemId);
            if (!targetRoom) {
                throw new Error(`Для предмета "${item.name}" не найдена комната.`);
            }

            const slot = OfficeLayout.getNextSlot(itemId, objects);

            // 💰 Списываем баланс
            const newBalance = balance - stats.cost;

            // 📦 Добавляем предмет в соответствующий массив
            if (item.renderType === 'npc') {
                npcs.push({ 
                    id: item.id, 
                    name: item.name, 
                    x: targetRoom.x + 1, 
                    y: targetRoom.y + 1, 
                    state: 'idle' 
                });
            } else {
                if (!slot) {
                    throw new Error(`Нет свободного места в "${targetRoom.name}"!`);
                }
                objects.push({ id: item.id, x: slot.x, y: slot.y });
            }
            
            // 🧠 ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ: Пересчитываем доход на основе НОВОГО состояния
            const tempProgressForCalculation = {
                ...progress,
                objects: objects,
                npcs: npcs,
                itemLevels: itemLevels
            };
            
            const newAutoClicker = GameFormulas.recalculateGlobalIncome(tempProgressForCalculation);

            // 3. ЗАПИСЬ В БД (используем точечное обновление для безопасности)
            transaction.update(playerRef, {
                'progress.tsp': newBalance,
                'progress.autoClicker': newAutoClicker,
                'progress.objects': objects,
                'progress.npcs': npcs,
                'progress.lastSaved': Date.now()
            });
            
            finalState = {
                newBalance: newBalance,
                newObjects: objects,
                newNpcs: npcs,
                newAutoClicker: newAutoClicker
            };
        });

        res.json({ success: true, ...finalState });

    } catch (error) {
        console.error(`[BUY-ITEM-ERROR]`, error);
        res.status(400).json({ success: false, error: error.message || "Ошибка при покупке." });
    }
});

app.post('/api/action/check-subscription', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) throw new Error('Неверная подпись.');
        
        const playerId = getPlayerIdFromInitData(initData);
        const playerRef = db.collection('players').doc(playerId.toString());
        
        const result = await db.runTransaction(async t => {
            const doc = await t.get(playerRef);
            if (!doc.exists) throw new Error("Игрок не найден.");
            
            const progress = doc.data().progress || {};
            if (progress.subscriptionRewardClaimed) throw new Error("Награда уже получена.");

            const CHANNEL_ID = '@to_tonstore'; 
            const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
            const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHANNEL_ID}&user_id=${playerId}`;
            
            const response = await axios.get(url);
            console.log(`[SUB-CHECK] Status for ${playerId}:`, response.data.result?.status);
            
            const memberStatus = response.data.result?.status;

            // 'left' или 'kicked' означает отсутствие в канале
            if (['member', 'administrator', 'creator'].includes(memberStatus)) {
                progress.tst = (progress.tst || 0) + 50;
                progress.subscriptionRewardClaimed = true;
                
                t.update(playerRef, { 'progress': progress });
                return { success: true, newTst: progress.tst };
            } else {
                throw new Error("Сначала подпишитесь на канал!");
            }
        });

        res.json(result);
    } catch (error) {
        console.error("Sub Error:", error.response?.data || error.message);
        const errorMessage = error.response?.data?.description || error.message;
        res.status(400).json({ success: false, error: errorMessage });
    }
});

app.post('/api/handle-start', async (req, res) => {
    try {
        let userId, referrerId;

        const internalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
        const isInternal = !!internalSecret && req.headers['x-internal-secret'] === internalSecret;

        if (isInternal) {
            // Вызов от нашего бота (api/bot.js) — доверяем телу запроса.
            userId = req.body.userId;
            referrerId = req.body.referrerId;
        } else {
            // Вызов из Mini App — всё берём из подписанного initData.
            const { initData } = req.body;
            if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
                return res.status(403).json({ ok: false, error: 'Неверная подпись.' });
            }
            userId = getPlayerIdFromInitData(initData);
            const startParam = new URLSearchParams(initData).get('start_param') || '';
            referrerId = startParam.startsWith('ref_') ? startParam.slice(4) : null;
        }

        if (!userId || !referrerId) return res.status(400).json({ ok: false, error: 'Нет данных.' });
        userId = userId.toString();
        referrerId = referrerId.toString();
        if (!/^\d+$/.test(userId) || !/^\d+$/.test(referrerId)) return res.status(400).json({ ok: false, error: 'Неверный ID.' });
        if (userId === referrerId) return res.status(200).json({ ok: false, error: "Self-ref" });

        // Реферальная ссылка работает только для новых игроков.
        const playerDoc = await db.collection('players').doc(userId).get();
        if (playerDoc.exists) return res.json({ ok: false, error: 'Игрок уже зарегистрирован.' });

        const refDoc = db.collection('referrals').doc(userId);
        const doc = await refDoc.get();

        // Записываем реферала только если его еще нет в системе (чтобы нельзя было сменить реферера)
        if (!doc.exists) {
            await refDoc.set({
                referrerId: referrerId,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[DB] Pending referral saved: ${userId} invited by ${referrerId}`);
        }

        res.json({ ok: true });
    } catch (e) {
        console.error("Handle Start Error:", e);
        res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/api/action/complete-quest', async (req, res) => {
    try {
        const { initData, questId } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken) || !questId) {
            return res.status(403).json({ success: false, error: 'Неверные данные.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'ID игрока не найден.' });

        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        const QUESTS_SERVER = {
            intro: { 
                id: 'intro', 
                title: "Первый фриланс",
                description: "Напиши простой лендинг для пиццерии. Нужно 50 строк кода.",
                requirement: { action: 'click', amount: 50 },
                reward: { money: 300, xp: 100 }, 
                nextQuest: "first_hire" 
            },
            first_hire: { 
                id: 'first_hire', 
                title: "Расширяемся",
                description: "Нужен помощник! Нанять первого Junior разработчика.",
                requirement: { action: 'buy', item: 'employee_dev', amount: 1 },
                reward: { money: 500, xp: 250 }, 
                nextQuest: "expand_server" 
            },
            expand_server: {
                id: 'expand_server', title: "Место для железа",
                description: "Нам нужно место для серверов. Купи Серверную комнату!",
                requirement: { action: "unlock_room", item: "server_room", amount: 1 },
                reward: { money: 800, xp: 300 }, nextQuest: "server_setup"
            },
            server_setup: {
                id: 'server_setup', title: "Серверная инфраструктура",
                description: "Клиент хочет масштабируемый бэкенд. Установи первый сервер.",
                requirement: { action: "buy", item: "server_rack", amount: 1 },
                reward: { money: 1200, xp: 500 }, nextQuest: "bug_hunt"
            },
            bug_hunt: {
                id: 'bug_hunt', title: "Охота на баги",
                description: "Критический баг в продакшене! Найди и исправь 20 багов.",
                requirement: { action: "bug_fix", amount: 20 },
                reward: { money: 800, xp: 400 }, nextQuest: "expand_lounge"
            },
            expand_lounge: {
                id: 'expand_lounge', title: "Забота о сотрудниках",
                description: "Люди устают. Открой Комнату отдыха (Lounge).",
                requirement: { action: "unlock_room", item: "break_room", amount: 1 },
                reward: { money: 1000, xp: 400 }, nextQuest: "team_management"
            },
            team_management: {
                id: 'team_management', title: "Управление командой",
                description: "Нанять Team Lead для управления разработчиками.",
                requirement: { action: "buy", item: "employee_manager", amount: 1 },
                reward: { money: 2000, xp: 800 }, nextQuest: "expand_meeting"
            },
            expand_meeting: {
                id: 'expand_meeting', title: "Бизнес встречи",
                description: "Нужно место для обсуждения стратегий. Открой Переговорную.",
                requirement: { action: "unlock_room", item: "meeting_room", amount: 1 },
                reward: { money: 2500, xp: 1000 }
            }
        };

        const quest = QUESTS_SERVER[questId];
        if (!quest) throw new Error("Квест не найден на сервере.");

        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            if (!playerDoc.exists) throw new Error("Игрок не найден.");

            const progress = playerDoc.data().progress || {};
            const questsData = progress.questsData || { completedQuests: [], activeQuests: [] };
            
            if (questsData.completedQuests.includes(questId)) {
                throw new Error("Квест уже выполнен.");
            }

            const activeIndex = (questsData.activeQuests || []).findIndex(q => q.id === questId);
            if (activeIndex > -1) {
                questsData.activeQuests.splice(activeIndex, 1);
            }
            
            questsData.completedQuests.push(questId);

            // Логика добавления следующего квеста
            if (quest.nextQuest) {
                const isAlreadyActive = (questsData.activeQuests || []).some(q => q.id === quest.nextQuest);
                const isAlreadyCompleted = (questsData.completedQuests || []).includes(quest.nextQuest);

                if (!isAlreadyActive && !isAlreadyCompleted) {
                    const nextQuestData = QUESTS_SERVER[quest.nextQuest];
                    if (nextQuestData) {
                        questsData.activeQuests.push({
                            id: nextQuestData.id,
                            title: nextQuestData.title || "Новое задание",
                            description: nextQuestData.description || "",
                            requirement: nextQuestData.requirement || { action: 'click', amount: 1 },
                            reward: nextQuestData.reward,
                            progress: { 
                                current: 0, 
                                total: (nextQuestData.requirement && nextQuestData.requirement.amount) ? nextQuestData.requirement.amount : 1 
                            }
                        });
                    }
                }
            }
            
            // Формируем новый прогресс
            const newProgress = {
                ...progress,
                tsp: (progress.tsp || 0) + (quest.reward.money || 0),
                xp: (progress.xp || 0) + (quest.reward.xp || 0),
                questsData: questsData
            };

            // --- ВСТАВКА: РЕФЕРАЛЬНАЯ ЛОГИКА ---
            if (questId === 'intro') {
                const pendingRef = db.collection('referrals').doc(playerId);
                const pendingDoc = await transaction.get(pendingRef);

                if (pendingDoc.exists && pendingDoc.data().status === 'pending') {
                    const referrerId = pendingDoc.data().referrerId.toString();
                    const referrerRef = db.collection('players').doc(referrerId);
                    const referrerDoc = await transaction.get(referrerRef);

                    if (referrerDoc.exists) {
                        transaction.update(pendingRef, { status: 'completed' });
                        
                        // Награждаем пригласившего (50 TST - премиальная валюта)
                        // Убедитесь, что у вас подключена библиотека admin
                        transaction.update(referrerRef, { 
                            'progress.tst': admin.firestore.FieldValue.increment(50) 
                        });
                        
                        // Награждаем новичка (500 TSP)
                        newProgress.tsp += 500;
                        
                        console.log(`Реферал ${playerId} подтвержден. Награды распределены.`);
                    }
                }
            }
            // --- КОНЕЦ РЕФЕРАЛЬНОЙ ЛОГИКИ ---

            // Сохраняем итоговое состояние
            transaction.update(playerRef, { 'progress': newProgress });
            
            finalState = { 
                newBalance: newProgress.tsp,
                newXp: newProgress.xp,
                newQuestsData: newProgress.questsData
            };
        });

        res.json({ success: true, ...finalState });

    } catch (error) {
        console.error(`[QUEST-ERROR]`, error);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/action/buy-room', async (req, res) => {
    try {
        const { initData, roomId } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken) || !roomId) {
            return res.status(403).json({ success: false, error: 'Неверные данные.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'ID игрока не найден.' });

        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            if (!playerDoc.exists) throw new Error("Игрок не найден.");

            const progress = playerDoc.data().progress || {};
            const balance = progress.tsp || 0;
            const roomPrices = progress.roomPrices || { server_room: 3000000, break_room: 1000000, meeting_room: 500000 };
            
            const price = roomPrices[roomId];
            if (typeof price === 'undefined') throw new Error("Комната не найдена.");

            // Проверяем, не куплена ли комната уже (добавим новое поле в progress)
            const unlockedRooms = progress.unlockedRooms || ['dev_room'];
            if (unlockedRooms.includes(roomId)) throw new Error("Комната уже куплена.");

            if (balance < price) throw new Error("Недостаточно средств.");

            const newBalance = balance - price;
            unlockedRooms.push(roomId); // Добавляем комнату в список купленных

            const newProgress = {
                ...progress,
                tsp: newBalance,
                unlockedRooms: unlockedRooms
            };
            
            transaction.update(playerRef, { 'progress': newProgress });
            
            finalState = { 
                newBalance: newProgress.tsp,
                newUnlockedRooms: newProgress.unlockedRooms
            };
        });

        res.json({ success: true, ...finalState });

    } catch (error) {
        console.error(`[BUY-ROOM-ERROR] Player: ${getPlayerIdFromInitData(req.body.initData)}, Room: ${req.body.roomId}.`, error);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/action/save-wallet', async (req, res) => {
    try {
        const { initData, address } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'ID не найден.' });

        await db.collection('players').doc(playerId).set({ 
            walletAddress: address // address может быть строкой или null
        }, { merge: true });

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Эндпоинт для массового применения улучшений
app.post('/api/action/apply-upgrades', async (req, res) => {
    try {
        const { initData, upgrades } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Auth failed' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        const playerRef = db.collection('players').doc(playerId);
        let finalState = {};

        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            if (!playerDoc.exists) throw new Error("Игрок не найден");

            const progress = playerDoc.data().progress || {};
            let tempBalance = progress.tsp || 0;
            let tempItemLevels = { ...(progress.itemLevels || {}) };

            for (const itemId in upgrades) {
                const countToUpgrade = upgrades[itemId];
                const itemConfig = ITEM_TYPES[itemId];
                if (!itemConfig) continue;

                for (let i = 0; i < countToUpgrade; i++) {
                    const currentLvl = tempItemLevels[itemId] || 1;
                    // ИСПОЛЬЗУЕМ ЕДИНУЮ ФОРМУЛУ
                    const cost = GameFormulas.getUpgradeCost(itemConfig, currentLvl);

                    if (tempBalance >= cost) {
                        tempBalance -= cost;
                        tempItemLevels[itemId] = currentLvl + 1;
                    } else {
                        break;
                    }
                }
            }

            // Пересчитываем доход на сервере
            const newIncome = GameFormulas.recalculateGlobalIncome({
                ...progress,
                itemLevels: tempItemLevels
            });

            // ТОЧЕЧНОЕ ОБНОВЛЕНИЕ БД
            transaction.update(playerRef, {
                'progress.tsp': tempBalance,
                'progress.itemLevels': tempItemLevels,
                'progress.autoClicker': newIncome,
                'progress.lastSaved': Date.now()
            });

            finalState = {
                newBalance: tempBalance,
                newItemLevels: tempItemLevels,
                newAutoClicker: newIncome
            };
        });

        res.json({ success: true, ...finalState });
    } catch (error) {
        console.error("[UPGRADE ERROR]", error);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/action/claim-instagram', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            throw new Error('Неверная подпись.');
        }
        
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) throw new Error('ID игрока не найден.');

        const playerRef = db.collection('players').doc(playerId);
        
        await db.runTransaction(async t => {
            const doc = await t.get(playerRef);
            if (!doc.exists) throw new Error("Игрок не найден.");
            
            const data = doc.data();
            const progress = data.progress || {};
            
            // 1. Проверяем, не была ли награда получена ранее
            if (progress.instagramRewardClaimed) {
                throw new Error("Награда за подписку уже была получена.");
            }

            // 2. Рассчитываем новую сумму TST (кристаллов)
            // Было: tsp + 200, xp + 50. Стало: tst + 50.
            const currentTst = progress.tst || 0;
            const newTst = currentTst + 50;

            // 3. Обновляем документ в базе
            t.update(playerRef, {
                'progress.tst': newTst,
                'progress.instagramRewardClaimed': true
            });

            // 4. Отправляем ответ клиенту (важно вернуть именно newTst)
            res.json({ 
                success: true, 
                newTst: newTst 
            });
        });
    } catch (error) {
        console.error("Ошибка claim-instagram:", error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/action/upgrade-offline', async (req, res) => {
    try {
        const { initData, tier } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) throw new Error('Неверная подпись.');
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) throw new Error('ID игрока не найден.');

        const tiers = {
            2: { limit: 21600, cost: 10 },
            3: { limit: 43200, cost: 25 },
            4: { limit: 86400, cost: 50 }
        };
        const upgrade = tiers[tier];
        if (!upgrade) throw new Error("Улучшение не найдено.");

        const playerRef = db.collection('players').doc(playerId);
        await db.runTransaction(async t => {
            const doc = await t.get(playerRef);
            if (!doc.exists) throw new Error("Игрок не найден.");
            
            const progress = doc.data().progress;
            if ((progress.tst || 0) < upgrade.cost) throw new Error("Недостаточно TST.");
            if ((progress.offlineTier || 1) >= tier) throw new Error("Улучшение уже куплено.");
            
            progress.tst -= upgrade.cost;
            progress.offlineTier = tier;
            progress.offlineLimit = upgrade.limit;
            
            t.update(playerRef, { 'progress': progress });
            
            res.json({ 
                success: true, 
                newTst: progress.tst, 
                newOfflineLimit: progress.offlineLimit,
                newOfflineTier: progress.offlineTier
            });
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Некритичные UI-метаданные (онбординг, позиция камеры). Никакого баланса/
// предметов здесь нет и не будет — те идут только через action-эндпоинты выше.
app.post('/api/action/save-meta', async (req, res) => {
    try {
        const { initData, shownDialogues, camera } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) {
            return res.status(400).json({ success: false, error: 'ID игрока не найден.' });
        }

        const updates = {};

        if (Array.isArray(shownDialogues)) {
            updates['progress.shownDialogues'] = shownDialogues
                .filter(id => typeof id === 'string')
                .slice(0, 50);
        }

        if (camera && typeof camera === 'object') {
            const x = Number(camera.x), y = Number(camera.y), zoom = Number(camera.zoom);
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom)) {
                updates['progress.camera'] = { x, y, zoom };
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.json({ success: true, skipped: true });
        }

        // set+merge вместо update: не падает, если документ ещё не создан
        // (гонка с /api/load на самом первом входе игрока)
        await db.collection('players').doc(playerId).set(updates, { merge: true });

        res.json({ success: true });
    } catch (error) {
        console.error('[SAVE-META-ERROR]', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/game/reset', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) return res.sendStatus(403);
        
        const playerId = getPlayerIdFromInitData(initData);
        await db.collection('players').doc(playerId).delete();
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

/*app.post('/api/full-save', async (req, res) => {
    try {
        const { initData, progress } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId || !progress) {
            return res.status(400).json({ success: false, error: 'Нет данных.' });
        }
        
        // Мы сохраняем весь объект, так как доверяем этому эндпоинту меньше,
        // чем эндпоинтам действий. Критические изменения все равно идут через них.
        await db.collection('players').doc(playerId).set(
            { 
                progress: progress,
                lastSaved: admin.firestore.FieldValue.serverTimestamp() 
            }, 
            { merge: true }
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка полного сохранения:", error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
}); */

/**
 * Эндпоинт загрузки (без изменений)
 * Он по-прежнему должен отдавать полный и достоверный `progress` из БД.
 */
app.post('/api/load', async (req, res) => {
    try {
        const { initData } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) {
            return res.status(400).json({ success: false, error: 'Не удалось получить ID.' });
        }

        const playerRef = db.collection('players').doc(playerId);
        const doc = await playerRef.get();
        
        const now = Date.now(); 

        if (doc.exists) {
            const data = doc.data();
            let progress = data.progress || {};
            
            // ГАРАНТИРУЕМ, что флаги наград существуют (для старых игроков)
            if (progress.instagramRewardClaimed === undefined) progress.instagramRewardClaimed = false;
            if (progress.telegramRewardClaimed === undefined) progress.telegramRewardClaimed = false;

            const lastSavedTime = toMillis(progress.lastSaved);
            let offlineIncome = 0;

            // Расчёт оффлайн дохода
            if (lastSavedTime && (progress.autoClicker || 0) > 0) {
                const diffInSeconds = Math.floor((now - lastSavedTime) / 1000);
                const ONE_HOUR = 3600;
                // Учитываем купленное улучшение оффлайн-лимита (upgrade-offline)
                const offlineLimit = progress.offlineLimit || DEFAULT_OFFLINE_LIMIT_SEC;

                if (diffInSeconds > ONE_HOUR) {
                    const secondsToCalculate = Math.min(diffInSeconds, offlineLimit);
                    offlineIncome = Math.floor(secondsToCalculate * progress.autoClicker);
                    
                    if (offlineIncome > 0) {
                        progress.tsp = (progress.tsp || 0) + offlineIncome;
                    }
                }
            }
            
            progress.lastSaved = now;
            // Оффлайн-доход начислен по текущий момент — окно sync-income начинается заново.
            progress.lastIncomeSync = now;

            // Сохраняем прогресс с обновленными флагами и временем
            await playerRef.update({ 
                'progress': progress,
                'lastSaved': admin.firestore.FieldValue.serverTimestamp() 
            });

            if (offlineIncome > 0) {
                await LeagueSystem.addPoints(playerId, offlineIncome, LeagueSystem.displayName(initData));
                await ClanSystem.addCup(playerId, data.clan, offlineIncome, progress.autoClicker, Math.min(Math.floor((now - lastSavedTime) / 1000), progress.offlineLimit || DEFAULT_OFFLINE_LIMIT_SEC), data.league && data.league.tier);
            }

            return res.json({ 
                success: true, 
                progress: progress,
                offlineIncome: offlineIncome 
            });

        } else {
            // ЛОГИКА ДЛЯ НОВОГО ИГРОКА
            const initialProgress = {
                shownDialogues: [],
                tsp: 100,
                tst: 0,
                autoClicker: 0,
                clickPower: 1,
                objects: [],
                npcs: [],
                xp: 0,
                companyLevel: 1,
                lastSaved: now,
                lastIncomeSync: now,
                offlineLimit: DEFAULT_OFFLINE_LIMIT_SEC,
                offlineTier: 1,
                unlockedRooms: ['dev_room'],
                itemLevels: {}, 
                questsData: { activeQuests: [], completedQuests: [], failedQuests: [] },
                // НОВЫЕ ФЛАГИ ДЛЯ КВЕСТОВ
                instagramRewardClaimed: false,
                telegramRewardClaimed: false,
                limits: { 'workstation_basic': 2, 'employee_dev': 2, 'server_rack': 1, 'employee_manager': 1, 'plant': 4, 'coffee_machine': 1, 'whiteboard': 1 },
                roomPrices: { 'server_room': 3000000, 'break_room': 1000000, 'meeting_room': 500000 }
                // camera сознательно не задаётся: это клиентское состояние,
                // SaveSystem.load() в index.html сам вызывает centerCamera(),
                // если progress.camera отсутствует.
            };

            await db.collection('players').doc(playerId).set({
                progress: initialProgress,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ success: true, progress: initialProgress, message: 'Новый игрок создан.' });
        }
    } catch (error) {
        console.error("Ошибка при загрузке:", error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// ==========================================
// ЛИГИ: недельный рейтинг (IPO Points)
// ==========================================
// Очки лиги = TSP, заработанные за текущую неделю (sync-income + оффлайн-доход).
// Игроки делятся на группы по LEAGUE_GROUP_SIZE внутри своей лиги.
// Неделя закрывается в воскресенье 23:59 (по LEAGUE_TZ_OFFSET_MIN, по умолчанию МСК).
// Итоги считаются "лениво": при первом заходе игрока в новой неделе
// сервер читает его прошлую группу (она уже заморожена) и повышает/понижает лигу.
// Поэтому cron не нужен.
const LEAGUE_TIERS = [
    { id: 0, name: 'Гаражный стартап', icon: '🛠️' },
    { id: 1, name: 'Офисный дата-центр', icon: '🏢' },
    { id: 2, name: 'IT-Гигант', icon: '🏙️' },
    { id: 3, name: 'Кибер-Синдикат', icon: '🕶️' },
    { id: 4, name: 'Титаны ИИ', icon: '🤖' }
];
const LEAGUE_GROUP_SIZE = parseInt(process.env.LEAGUE_GROUP_SIZE, 10) || 30;
const LEAGUE_PROMOTE_SHARE = 0.10;
const LEAGUE_DEMOTE_SHARE = 0.10;
const LEAGUE_TZ_OFFSET_MIN = Number.isFinite(parseInt(process.env.LEAGUE_TZ_OFFSET_MIN, 10))
    ? parseInt(process.env.LEAGUE_TZ_OFFSET_MIN, 10) : 180;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const EPOCH_MONDAY_MS = Date.UTC(1970, 0, 5); // понедельник

const LeagueSystem = {
    weekIndex(now = Date.now()) {
        return Math.floor((now + LEAGUE_TZ_OFFSET_MIN * 60000 - EPOCH_MONDAY_MS) / WEEK_MS);
    },
    weekKey(now = Date.now()) { return 'w' + this.weekIndex(now); },
    weekEndsAt(now = Date.now()) {
        return EPOCH_MONDAY_MS + (this.weekIndex(now) + 1) * WEEK_MS - LEAGUE_TZ_OFFSET_MIN * 60000;
    },
    clampTier(t) { return Math.max(0, Math.min(LEAGUE_TIERS.length - 1, parseInt(t, 10) || 0)); },

    // Сколько мест повышается/понижается в группе размера size
    zones(size, tier) {
        if (size < 2) return { promote: 0, demote: 0 };
        const promote = tier < LEAGUE_TIERS.length - 1 ? Math.max(1, Math.floor(size * LEAGUE_PROMOTE_SHARE)) : 0;
        let demote = tier > 0 ? Math.max(1, Math.floor(size * LEAGUE_DEMOTE_SHARE)) : 0;
        if (promote + demote > size - 1) demote = Math.max(0, size - 1 - promote);
        return { promote, demote };
    },

    // Сортировка участников группы: очки desc, при равенстве — кто раньше набрал
    rank(entries) {
        return entries.slice().sort((a, b) =>
            (b.points || 0) - (a.points || 0) || (a.updatedAt || 0) - (b.updatedAt || 0) || String(a.playerId).localeCompare(String(b.playerId)));
    },

    // Итог прошлой недели для игрока по замороженной группе
    computeResult(entries, playerId, tier) {
        const ranked = this.rank(entries);
        const idx = ranked.findIndex(e => e.playerId === playerId);
        if (idx < 0) return null;
        const size = ranked.length;
        const { promote, demote } = this.zones(size, tier);
        const place = idx + 1;
        const myPoints = ranked[idx].points || 0;
        let change = 'stay';
        if (place <= promote && myPoints > 0) change = 'up';
        else if (place > size - demote) change = 'down';
        const newTier = this.clampTier(tier + (change === 'up' ? 1 : change === 'down' ? -1 : 0));
        return { place, size, points: Math.floor(myPoints), change, fromTier: tier, toTier: newTier };
    },

    displayName(initData) {
        try {
            const user = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
            const name = user.username ? '@' + user.username : [user.first_name, user.last_name].filter(Boolean).join(' ');
            return (name || 'Игрок').slice(0, 32);
        } catch (e) { return 'Игрок'; }
    },

    /**
     * Гарантирует, что игрок записан в группу текущей недели.
     * Если наступила новая неделя — подводит итоги прошлой и меняет лигу.
     * Возвращает объект league из документа игрока.
     */
    async ensure(playerId, name) {
        const week = this.weekKey();
        const playerRef = db.collection('players').doc(playerId);
        return db.runTransaction(async (tx) => {
            const playerDoc = await tx.get(playerRef);
            if (!playerDoc.exists) throw new Error('PLAYER_NOT_FOUND');
            const league = playerDoc.data().league || {};
            if (league.week === week && league.groupId) {
                if (name && league.name !== name) {
                    tx.update(playerRef, { 'league.name': name });
                    tx.set(db.collection('leagueEntries').doc(`${week}_${playerId}`), { name }, { merge: true });
                }
                return { ...league, name: name || league.name };
            }

            // 1) Итоги прошлой недели (если игрок в ней участвовал)
            let tier = this.clampTier(league.tier);
            let lastResult = league.lastResult || null;
            let pendingReward = league.pendingReward || null;
            const progress = playerDoc.data().progress || {};
            const extraUpdates = {};
            if (league.week && league.groupId) {
                const snap = await tx.get(db.collection('leagueEntries').where('groupId', '==', league.groupId));
                const entries = snap.docs.map(d => d.data());
                const result = this.computeResult(entries, playerId, tier);
                if (result) {
                    // Незабранную награду позапрошлой недели выдаём автоматически
                    if (pendingReward) {
                        Object.assign(extraUpdates, LeagueRewards.apply(progress, pendingReward).updates);
                    }
                    const income = GameFormulas.recalculateGlobalIncome(progress) || progress.autoClicker || 0;
                    const bracket = LeagueRewards.bracketFor({ ...result, minPoints: income * LEAGUE_MIN_ACTIVITY_SEC });
                    pendingReward = LeagueRewards.build(result.fromTier, bracket, income);
                    if (pendingReward) pendingReward.week = league.week;
                    lastResult = { ...result, week: league.week, bracket, reward: pendingReward };
                    tier = result.toTier;
                }
            }

            // 2) Назначение группы в новой неделе
            const counterRef = db.collection('leagueCounters').doc(`${week}_${tier}`);
            const counterDoc = await tx.get(counterRef);
            let { group = 0, size = 0 } = counterDoc.exists ? counterDoc.data() : {};
            if (size >= LEAGUE_GROUP_SIZE) { group += 1; size = 0; }
            size += 1;
            const groupId = `${week}_${tier}_${group}`;
            const now = Date.now();

            tx.set(counterRef, { group, size, week, tier }, { merge: true });
            tx.set(db.collection('leagueEntries').doc(`${week}_${playerId}`), {
                week, tier, groupId, playerId, name: name || 'Игрок', points: 0, updatedAt: now
            });
            const newLeague = { week, tier, groupId, name: name || league.name || 'Игрок', lastResult, pendingReward };
            tx.update(playerRef, { league: newLeague, ...extraUpdates });
            return newLeague;
        });
    },

    // Начислить очки лиги (вызывается после успешного начисления дохода)
    async addPoints(playerId, amount, name, knownLeague = null) {
        if (!(amount > 0)) return;
        try {
            // Быстрый путь: игрок уже в группе текущей недели — без лишней транзакции
            const league = (knownLeague && knownLeague.week === this.weekKey() && knownLeague.groupId)
                ? knownLeague
                : await this.ensure(playerId, name);
            await db.collection('leagueEntries').doc(`${league.week}_${playerId}`).set({
                points: admin.firestore.FieldValue.increment(amount),
                updatedAt: Date.now()
            }, { merge: true });
        } catch (e) {
            if (e.message !== 'PLAYER_NOT_FOUND') console.error('League addPoints error:', e);
        }
    }
};

/**
 * Рейтинг группы игрока за текущую неделю.
 * Ответ: лига, место, зоны повышения/понижения, таблица и итог прошлой недели.
 */
app.post('/api/league/me', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'Не удалось получить ID.' });

        const league = await LeagueSystem.ensure(playerId, LeagueSystem.displayName(initData));
        const snap = await db.collection('leagueEntries').where('groupId', '==', league.groupId).get();
        const ranked = LeagueSystem.rank(snap.docs.map(d => d.data()));
        const { promote, demote } = LeagueSystem.zones(ranked.length, league.tier);
        const standings = ranked.map((e, i) => ({
            place: i + 1,
            name: e.name || 'Игрок',
            points: Math.floor(e.points || 0),
            isMe: e.playerId === playerId
        }));
        const me = standings.find(s => s.isMe) || null;

        res.json({
            success: true,
            week: league.week,
            weekEndsAt: LeagueSystem.weekEndsAt(),
            tier: league.tier,
            tiers: LEAGUE_TIERS,
            promote, demote,
            size: standings.length,
            myPlace: me ? me.place : null,
            myPoints: me ? me.points : 0,
            standings,
            lastResult: league.lastResult || null,
            pendingReward: league.pendingReward || null,
            rewardTable: LeagueRewards.table(league.tier)
        });
    } catch (error) {
        if (error.message === 'PLAYER_NOT_FOUND') return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        console.error('Ошибка лиги:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// ==========================================
// НАГРАДЫ ЛИГ
// ==========================================
// Принципы, чтобы не ломать экономику:
//  - TSP выдаётся в "часах собственного дохода" игрока (autoClicker на момент итогов),
//    поэтому награда масштабируется с прогрессом и не обесценивает цены магазина.
//  - Буст дохода временный, не суммируется (берётся больший множитель / продлевается срок),
//    и сервер учитывает его в потолке sync-income.
//  - TST (донатная валюта) — только с лиги «Офисный дата-центр» и выше, малыми порциями.
//  - Скины — только в двух верхних лигах за топ-места; если скин уже есть — компенсация TST.
//  - Призовые места (top1/top3) только в группах от LEAGUE_MIN_GROUP_FOR_TOP игроков,
//    чтобы нельзя было "выиграть" полупустую группу.
//  - Нужна минимальная активность: очки ≥ LEAGUE_MIN_ACTIVITY_SEC секунд своего дохода.
const LEAGUE_MIN_GROUP_FOR_TOP = 10;
const LEAGUE_MIN_GROUP_FOR_PROMO_BRACKET = 5;
const LEAGUE_MIN_ACTIVITY_SEC = 600;
const LEAGUE_SKIN_DUPLICATE_TST = 25;
const LEAGUE_BRACKETS = ['top1', 'top3', 'top10', 'top50', 'active'];
const LEAGUE_BRACKET_NAMES = { top1: '1 место', top3: '2–3 место', top10: 'Топ-10%', top50: 'Топ-50%', active: 'Участие' };
// h — часы дохода в TSP, boost — [множитель, часов], tst — кристаллы, skin — id скина
const LEAGUE_REWARDS = [
    { // 0 Гаражный стартап
        top1:  { h: 3, boost: [1.5, 2] },
        top3:  { h: 2, boost: [1.5, 1] },
        top10: { h: 1.5 },
        top50: { h: 1 },
        active:{ h: 0.5 }
    },
    { // 1 Офисный дата-центр
        top1:  { h: 4, boost: [1.5, 4], tst: 5 },
        top3:  { h: 3, boost: [1.5, 2] },
        top10: { h: 2, boost: [1.5, 1] },
        top50: { h: 1.5 },
        active:{ h: 0.5 }
    },
    { // 2 IT-Гигант
        top1:  { h: 5, boost: [2, 4], tst: 15 },
        top3:  { h: 4, boost: [1.5, 4], tst: 10 },
        top10: { h: 3, boost: [1.5, 2], tst: 5 },
        top50: { h: 2 },
        active:{ h: 1 }
    },
    { // 3 Кибер-Синдикат
        top1:  { h: 6, boost: [2, 6], tst: 30, skin: 'npc4' },
        top3:  { h: 5, boost: [2, 4], tst: 20 },
        top10: { h: 4, boost: [1.5, 4], tst: 10 },
        top50: { h: 2, tst: 3 },
        active:{ h: 1 }
    },
    { // 4 Титаны ИИ
        top1:  { h: 8, boost: [2, 8], tst: 60, skin: 'npc5' },
        top3:  { h: 6, boost: [2, 6], tst: 40, skin: 'npc4' },
        top10: { h: 5, boost: [2, 4], tst: 25 },
        top50: { h: 3, tst: 5 },
        active:{ h: 1 }
    }
];

const LeagueRewards = {
    bracketFor(result) {
        const { place, size, points, minPoints } = result;
        if (!(points > 0) || points < (minPoints || 0)) return null;
        if (size >= LEAGUE_MIN_GROUP_FOR_TOP && place === 1) return 'top1';
        if (size >= LEAGUE_MIN_GROUP_FOR_TOP && place <= 3) return 'top3';
        if (size >= LEAGUE_MIN_GROUP_FOR_PROMO_BRACKET && place <= Math.max(1, Math.floor(size * 0.1))) return 'top10';
        if (place <= Math.ceil(size * 0.5)) return 'top50';
        return 'active';
    },
    // Конкретная награда (с суммой TSP) для игрока
    build(tier, bracket, incomePerSec) {
        const spec = bracket && LEAGUE_REWARDS[tier] && LEAGUE_REWARDS[tier][bracket];
        if (!spec) return null;
        return {
            tier, bracket,
            tsp: Math.floor((spec.h || 0) * 3600 * Math.max(0, incomePerSec || 0)),
            hours: spec.h || 0,
            boost: spec.boost ? { mult: spec.boost[0], hours: spec.boost[1] } : null,
            tst: spec.tst || 0,
            skin: spec.skin || null
        };
    },
    // Таблица наград лиги для UI
    table(tier) {
        const t = LEAGUE_REWARDS[tier] || {};
        return LEAGUE_BRACKETS.map(b => ({ bracket: b, name: LEAGUE_BRACKET_NAMES[b], ...(t[b] ? {
            hours: t[b].h || 0, boost: t[b].boost ? { mult: t[b].boost[0], hours: t[b].boost[1] } : null,
            tst: t[b].tst || 0, skin: t[b].skin || null } : {}) }));
    },
    // Применить награду к progress, вернуть поля для update и итог
    apply(progress, reward, now = Date.now()) {
        const updates = {};
        const out = { tsp: 0, tst: 0, skin: null, skinDuplicateTst: 0, boost: null };
        if (!reward) return { updates, out };
        let tst = progress.tst || 0;
        if (reward.tsp > 0) {
            updates['progress.tsp'] = (progress.tsp || 0) + reward.tsp;
            out.tsp = reward.tsp;
        }
        if (reward.tst > 0) { tst += reward.tst; out.tst += reward.tst; }
        if (reward.skin) {
            const skins = [...(progress.playerSkins || ['npc1'])];
            if (skins.includes(reward.skin)) {
                tst += LEAGUE_SKIN_DUPLICATE_TST;
                out.tst += LEAGUE_SKIN_DUPLICATE_TST;
                out.skinDuplicateTst = LEAGUE_SKIN_DUPLICATE_TST;
            } else {
                skins.push(reward.skin);
                updates['progress.playerSkins'] = skins;
                out.skin = reward.skin;
            }
        }
        if (out.tst > 0) updates['progress.tst'] = tst;
        if (reward.boost) {
            const cur = progress.incomeBoost || {};
            const active = cur.until > now;
            const mult = Math.max(reward.boost.mult, active ? (cur.mult || 1) : 1);
            const until = Math.max(active ? cur.until : now, now) + reward.boost.hours * 3600000;
            // Не даём бусту копиться бесконечно: максимум 24 часа вперёд
            const boost = { mult, until: Math.min(until, now + 24 * 3600000) };
            updates['progress.incomeBoost'] = boost;
            out.boost = boost;
        }
        return { updates, out };
    },
    activeBoostMult(progress, now = Date.now()) {
        const b = progress && progress.incomeBoost;
        return b && b.until > now && b.mult > 1 ? Math.min(b.mult, 3) : 1;
    }
};

// Забрать награду за прошлую неделю (идемпотентно)
app.post('/api/league/claim', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'Не удалось получить ID.' });
        // Сначала убедимся, что итоги прошлой недели подведены
        await LeagueSystem.ensure(playerId, LeagueSystem.displayName(initData));

        const playerRef = db.collection('players').doc(playerId);
        const result = await db.runTransaction(async (tx) => {
            const doc = await tx.get(playerRef);
            if (!doc.exists) throw new Error('PLAYER_NOT_FOUND');
            const data = doc.data();
            const progress = data.progress || {};
            const pending = data.league && data.league.pendingReward;
            if (!pending) throw new Error('NO_REWARD');
            const { updates, out } = LeagueRewards.apply(progress, pending);
            updates['league.pendingReward'] = null;
            tx.update(playerRef, updates);
            return {
                granted: out,
                newTsp: updates['progress.tsp'] ?? (progress.tsp || 0),
                newTst: updates['progress.tst'] ?? (progress.tst || 0),
                playerSkins: updates['progress.playerSkins'] || progress.playerSkins || ['npc1'],
                incomeBoost: updates['progress.incomeBoost'] || progress.incomeBoost || null
            };
        });
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.message === 'NO_REWARD') return res.status(400).json({ success: false, error: 'Награда уже получена.' });
        if (error.message === 'PLAYER_NOT_FOUND') return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        console.error('Ошибка выдачи награды лиги:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// ==========================================
// КАРТОЧКА ДЛЯ ШАРИНГА
// ==========================================
// Клиент рисует карточку (офис из спрайтов + статистика) в JPEG и присылает сюда.
// Сервер загружает фото в Telegram (получает file_id), готовит inline-сообщение
// через savePreparedInlineMessage — клиент открывает нативное окно "Поделиться" (tg.shareMessage).
// Фото кладётся в SHARE_STORAGE_CHAT_ID (приватный канал, где бот — админ), а если он не задан —
// в личный чат игрока с ботом (заодно карточку можно переслать оттуда вручную).
const SHARE_MAX_BYTES = 2.5 * 1024 * 1024;
const SHARE_COOLDOWN_MS = 20 * 1000;
const BOT_USERNAME = process.env.BOT_USERNAME || 'DigitalCryptoStore_bot';
const BOT_APP_NAME = process.env.BOT_APP_NAME || 'game';

async function tgApi(method, body) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body)
    });
    const json = await resp.json().catch(() => ({}));
    if (!json.ok) {
        const err = new Error(`TG_${method}_FAILED: ${json.description || resp.status}`);
        err.tg = json;
        throw err;
    }
    return json.result;
}

app.post('/api/share/prepare', async (req, res) => {
    try {
        const { initData, image } = req.body;
        if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись.' });
        }
        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) return res.status(400).json({ success: false, error: 'Не удалось получить ID.' });

        const m = typeof image === 'string' && image.match(/^data:image\/(jpeg|png);base64,(.+)$/);
        if (!m) return res.status(400).json({ success: false, error: 'Нет изображения.' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > SHARE_MAX_BYTES) return res.status(413).json({ success: false, error: 'Слишком большая картинка.' });

        // Антиспам: не чаще раза в SHARE_COOLDOWN_MS
        const playerRef = db.collection('players').doc(playerId);
        const doc = await playerRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        const lastShareAt = doc.data().lastShareAt || 0;
        if (Date.now() - lastShareAt < SHARE_COOLDOWN_MS) {
            return res.status(429).json({ success: false, error: 'Подождите немного перед следующей карточкой.' });
        }
        await playerRef.set({ lastShareAt: Date.now() }, { merge: true });

        const referralLink = `https://t.me/${BOT_USERNAME}/${BOT_APP_NAME}?startapp=ref_${playerId}`;
        const caption = '🏢 Мой IT-офис в StoreTycoon! Построй свой и обгони меня в лиге 🏆';

        // 1) Загрузка фото в Telegram → file_id
        const storageChat = process.env.SHARE_STORAGE_CHAT_ID || playerId;
        const form = new FormData();
        form.append('chat_id', String(storageChat));
        form.append('caption', storageChat === playerId
            ? '📸 Ваша карточка готова! Её можно переслать друзьям.'
            : `share card ${playerId}`);
        if (storageChat === playerId) form.append('disable_notification', 'true');
        form.append('photo', new Blob([buf], { type: `image/${m[1]}` }), `card.${m[1] === 'png' ? 'png' : 'jpg'}`);
        let sent;
        try {
            sent = await tgApi('sendPhoto', form);
        } catch (e) {
            console.error('share sendPhoto error:', e.message);
            return res.status(502).json({ success: false, error: 'Не удалось загрузить карточку. Нажмите /start в чате с ботом и попробуйте снова.' });
        }
        const photos = sent.photo || [];
        const fileId = photos.length ? photos[photos.length - 1].file_id : null;
        if (!fileId) return res.status(502).json({ success: false, error: 'Telegram не вернул фото.' });

        // 2) Подготовленное сообщение для tg.shareMessage (Bot API 8.0+)
        let preparedId = null;
        try {
            const prepared = await tgApi('savePreparedInlineMessage', {
                user_id: Number(playerId),
                result: {
                    type: 'photo',
                    id: crypto.randomBytes(8).toString('hex'),
                    photo_file_id: fileId,
                    caption,
                    reply_markup: { inline_keyboard: [[{ text: '🎮 Играть в StoreTycoon', url: referralLink }]] }
                },
                allow_user_chats: true,
                allow_bot_chats: false,
                allow_group_chats: true,
                allow_channel_chats: true
            });
            preparedId = prepared.id;
        } catch (e) {
            console.warn('savePreparedInlineMessage failed:', e.message);
        }

        res.json({
            success: true,
            preparedId,
            referralLink,
            caption,
            // Публичная ссылка на картинку для tg.shareToStory
            imageUrl: `/api/share/img?f=${encodeURIComponent(fileId)}`
        });
    } catch (error) {
        console.error('Ошибка подготовки карточки:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// Отдаёт картинку карточки по file_id (нужен публичный URL для историй Telegram)
app.get('/api/share/img', async (req, res) => {
    try {
        const fileId = String(req.query.f || '');
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(fileId)) return res.status(400).end();
        const file = await tgApi('getFile', { file_id: fileId });
        const resp = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
        if (!resp.ok) return res.status(404).end();
        const buf = Buffer.from(await resp.arrayBuffer());
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.end(buf);
    } catch (e) {
        res.status(404).end();
    }
});

// ==========================================
// КЛАНЫ (ХОЛДИНГИ) И НЕДЕЛЬНЫЙ КУБОК КЛАНОВ
// ==========================================
// - Создать клан можно только за TST (CLAN_CREATE_COST_TST, по умолчанию 250 = один пакет).
// - Вступление бесплатное: открытые кланы видны в списке, закрытые — только по ссылке-приглашению.
// - Очки кубка не зависят от богатства игрока: это "часы работы офиса" за неделю
//   (заработанное / доход в секунду), умноженные на коэффициент лиги игрока.
//   Поэтому новичок и кит вносят сопоставимый вклад — важна активность всей команды.
// - Итоги кубка подводятся лениво (как у лиг), награда забирается кнопкой.
const CLAN_CREATE_COST_TST = parseInt(process.env.CLAN_CREATE_COST_TST, 10) || 250;
const CLAN_MAX_MEMBERS = parseInt(process.env.CLAN_MAX_MEMBERS, 10) || 30;
const CLAN_REJOIN_COOLDOWN_MS = (parseFloat(process.env.CLAN_REJOIN_COOLDOWN_H) || 12) * 3600000;
const CLAN_EMBLEMS = ['🚀', '💻', '🛡️', '⚡', '🐸', '🦾', '🧠', '🔥', '👾', '🏴‍☠️', '💎', '🌐', '🐉', '👑', '🦊', '🤖'];
const CLAN_CUP_POINTS_PER_HOUR = 10;
const CLAN_CUP_TIER_MULT = [1, 1.2, 1.4, 1.7, 2];
const CLAN_CUP_MIN_HOURS = 3;            // минимум личного вклада за неделю для награды
const CLAN_CUP_MIN_JOIN_BEFORE_END_MS = 48 * 3600000; // вступить нужно минимум за 48ч до конца недели
const CLAN_CUP_TST_MIN_CLANS = 5;        // TST-призы — только если в кубке участвует ≥5 кланов
const CLAN_CUP_TST_MIN_ACTIVE = 5;       // ...и в клане ≥5 активных участников
const CLAN_CUP_REWARDS = {
    top1:  { h: 3, boost: [1.5, 6], tst: 30 },
    top3:  { h: 2, boost: [1.5, 4], tst: 20 },
    top10: { h: 2, tst: 10 },
    top25: { h: 3 },
    active:{ h: 1 }
};

const ClanSystem = {
    cupRef(week) { return db.collection('clanCup').doc(week); },
    validName(name) {
        if (typeof name !== 'string') return null;
        const n = name.replace(/\s+/g, ' ').trim();
        if (n.length < 3 || n.length > 20) return null;
        if (!/^[\p{L}\p{N} _\-.]+$/u.test(n)) return null;
        return n;
    },
    newId() { return crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x'); },
    publicClan(id, c) {
        return {
            id, name: c.name, emblem: c.emblem, description: c.description || '', open: !!c.open,
            memberCount: c.memberCount || 0, maxMembers: c.maxMembers || CLAN_MAX_MEMBERS, leaderId: c.leaderId
        };
    },
    prevWeekKey() { return 'w' + (LeagueSystem.weekIndex() - 1); },
    weekEndOf(weekKey) {
        const idx = parseInt(String(weekKey).slice(1), 10);
        return EPOCH_MONDAY_MS + (idx + 1) * WEEK_MS - LEAGUE_TZ_OFFSET_MIN * 60000;
    },

    // Сбросить недельный вклад игрока при смене клана (очки остаются у старого клана)
    resetMemberCup(tx, playerId, clanId, name, now) {
        const week = LeagueSystem.weekKey();
        tx.set(this.cupRef(week).collection('members').doc(playerId), {
            playerId, clanId, name, points: 0, hours: 0, joinedAt: now, updatedAt: now
        });
    },

    // Начисление очков кубка (после sync-income / оффлайн-дохода)
    async addCup(playerId, knownClan, credited, income, elapsedSec, tier) {
        if (!knownClan || !knownClan.id || !(credited > 0)) return;
        try {
            const byIncome = income > 0 ? credited / income / 3600 : Infinity;
            const byTime = (elapsedSec || 0) / 3600 * 1.2;
            const hours = Math.max(0, Math.min(byIncome, byTime));
            if (!(hours > 0)) return;
            const points = hours * CLAN_CUP_POINTS_PER_HOUR * (CLAN_CUP_TIER_MULT[LeagueSystem.clampTier(tier)] || 1);
            const week = LeagueSystem.weekKey();
            const inc = admin.firestore.FieldValue.increment;
            const now = Date.now();
            const batch = db.batch();
            batch.set(this.cupRef(week).collection('clans').doc(knownClan.id), {
                clanId: knownClan.id, points: inc(points), hours: inc(hours), updatedAt: now
            }, { merge: true });
            batch.set(this.cupRef(week).collection('members').doc(playerId), {
                playerId, clanId: knownClan.id, points: inc(points), hours: inc(hours), updatedAt: now
            }, { merge: true });
            await batch.commit();
        } catch (e) {
            console.error('Clan addCup error:', e);
        }
    },

    rewardFor(place, total, activeMembers, myHours) {
        if (!(myHours >= CLAN_CUP_MIN_HOURS)) return null;
        const tstAllowed = total >= CLAN_CUP_TST_MIN_CLANS && activeMembers >= CLAN_CUP_TST_MIN_ACTIVE;
        let bracket = 'active';
        if (tstAllowed && place === 1) bracket = 'top1';
        else if (tstAllowed && place <= 3) bracket = 'top3';
        else if (tstAllowed && place <= 10 && place <= Math.ceil(total * 0.3)) bracket = 'top10';
        else if (place <= Math.max(1, Math.ceil(total * 0.25))) bracket = 'top25';
        return bracket;
    },

    // Подвести итоги кубка прошлой недели для игрока (идемпотентно)
    async settle(playerId) {
        const prev = this.prevWeekKey();
        const playerRef = db.collection('players').doc(playerId);
        const pDoc = await playerRef.get();
        if (!pDoc.exists) return null;
        const pdata = pDoc.data();
        if (pdata.clanCupSettled === prev) return pdata;

        const memberDoc = await this.cupRef(prev).collection('members').doc(playerId).get();
        let result = null, reward = null;
        if (memberDoc.exists) {
            const m = memberDoc.data();
            const clanCupDoc = await this.cupRef(prev).collection('clans').doc(m.clanId).get();
            if (clanCupDoc.exists) {
                const clanPoints = clanCupDoc.data().points || 0;
                const higher = await this.cupRef(prev).collection('clans').where('points', '>', clanPoints).count().get();
                const totalSnap = await this.cupRef(prev).collection('clans').count().get();
                const place = higher.data().count + 1;
                const total = totalSnap.data().count;
                const mates = await this.cupRef(prev).collection('members').where('clanId', '==', m.clanId).get();
                const activeMembers = mates.docs.filter(d => (d.data().hours || 0) >= CLAN_CUP_MIN_HOURS).length;
                const joinedInTime = (m.joinedAt || 0) <= this.weekEndOf(prev) - CLAN_CUP_MIN_JOIN_BEFORE_END_MS;
                const bracket = joinedInTime ? this.rewardFor(place, total, activeMembers, m.hours || 0) : null;
                const income = GameFormulas.recalculateGlobalIncome(pdata.progress || {}) || (pdata.progress || {}).autoClicker || 0;
                const spec = bracket && CLAN_CUP_REWARDS[bracket];
                if (spec) {
                    reward = {
                        week: prev, bracket, tsp: Math.floor((spec.h || 0) * 3600 * income), hours: spec.h || 0,
                        boost: spec.boost ? { mult: spec.boost[0], hours: spec.boost[1] } : null,
                        tst: spec.tst || 0, skin: null
                    };
                }
                result = {
                    week: prev, clanId: m.clanId, place, total, clanPoints: Math.floor(clanPoints),
                    myPoints: Math.floor(m.points || 0), myHours: +(m.hours || 0).toFixed(1),
                    activeMembers, bracket, joinedInTime, reward
                };
            }
        }

        return db.runTransaction(async (tx) => {
            const d = await tx.get(playerRef);
            const data = d.data();
            if (data.clanCupSettled === prev) return data;
            const updates = { clanCupSettled: prev };
            if (result) {
                updates.clanCupResult = result;
                // незабранная награда прошлого кубка выдаётся автоматически
                if (data.clanCupReward) Object.assign(updates, LeagueRewards.apply(data.progress || {}, data.clanCupReward).updates);
                updates.clanCupReward = reward;
            }
            tx.update(playerRef, updates);
            return { ...data, ...updates };
        });
    },

    async getClanView(clanId, playerId) {
        const clanDoc = await db.collection('clans').doc(clanId).get();
        if (!clanDoc.exists) return null;
        const c = clanDoc.data();
        const week = LeagueSystem.weekKey();
        const [cupDoc, membersSnap] = await Promise.all([
            this.cupRef(week).collection('clans').doc(clanId).get(),
            this.cupRef(week).collection('members').where('clanId', '==', clanId).get()
        ]);
        const contrib = {};
        membersSnap.docs.forEach(d => { const m = d.data(); contrib[m.playerId] = m; });
        const members = Object.entries(c.members || {}).map(([pid, m]) => ({
            playerId: pid, name: m.name || 'Игрок', role: m.role || 'member', joinedAt: m.joinedAt || 0,
            points: Math.floor((contrib[pid] && contrib[pid].points) || 0),
            hours: +(((contrib[pid] && contrib[pid].hours) || 0)).toFixed(1),
            isMe: pid === playerId
        })).sort((a, b) => b.points - a.points || a.joinedAt - b.joinedAt);
        const clanPoints = cupDoc.exists ? (cupDoc.data().points || 0) : 0;
        let place = null;
        if (clanPoints > 0) {
            const higher = await this.cupRef(week).collection('clans').where('points', '>', clanPoints).count().get();
            place = higher.data().count + 1;
        }
        const total = (await this.cupRef(week).collection('clans').count().get()).data().count;
        return { ...this.publicClan(clanId, c), members, cup: { week, points: Math.floor(clanPoints), place, total } };
    }
};

// Общая обвязка для clan-эндпоинтов: проверка подписи и ID
async function clanAuth(req, res) {
    const { initData } = req.body || {};
    if (!verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN)) {
        res.status(403).json({ success: false, error: 'Неверная подпись.' });
        return null;
    }
    const playerId = getPlayerIdFromInitData(initData);
    if (!playerId) { res.status(400).json({ success: false, error: 'Не удалось получить ID.' }); return null; }
    return { playerId, name: LeagueSystem.displayName(initData) };
}
const CLAN_ERRORS = {
    PLAYER_NOT_FOUND: [404, 'Игрок не найден.'],
    ALREADY_IN_CLAN: [400, 'Вы уже состоите в клане.'],
    NOT_IN_CLAN: [400, 'Вы не состоите в клане.'],
    NOT_ENOUGH_TST: [400, `Нужно ${CLAN_CREATE_COST_TST} TST.`],
    BAD_NAME: [400, 'Название: 3–20 символов, буквы, цифры, пробел, - _ .'],
    NAME_TAKEN: [400, 'Такое название уже занято.'],
    BAD_EMBLEM: [400, 'Неверная эмблема.'],
    CLAN_NOT_FOUND: [404, 'Клан не найден.'],
    CLAN_FULL: [400, 'В клане нет мест.'],
    COOLDOWN: [400, 'После выхода из клана нужно подождать.'],
    NOT_LEADER: [403, 'Только лидер может это сделать.'],
    NOT_MEMBER: [400, 'Игрок не состоит в вашем клане.'],
    NO_REWARD: [400, 'Награда уже получена.']
};
function clanError(res, e, where) {
    const known = CLAN_ERRORS[e.message];
    if (known) return res.status(known[0]).json({ success: false, error: known[1], code: e.message, until: e.until });
    console.error(`Ошибка кланов (${where}):`, e);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
}

// Состояние кланов для игрока: свой клан, итоги кубка, стоимость создания
app.post('/api/clan/me', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const pdata = await ClanSystem.settle(auth.playerId);
        if (!pdata) throw new Error('PLAYER_NOT_FOUND');
        const clan = pdata.clan && pdata.clan.id ? await ClanSystem.getClanView(pdata.clan.id, auth.playerId) : null;
        res.json({
            success: true,
            clan,
            myRole: clan ? (pdata.clan.role || 'member') : null,
            createCost: CLAN_CREATE_COST_TST,
            maxMembers: CLAN_MAX_MEMBERS,
            emblems: CLAN_EMBLEMS,
            rejoinAt: (pdata.clanLeftAt || 0) + CLAN_REJOIN_COOLDOWN_MS,
            weekEndsAt: LeagueSystem.weekEndsAt(),
            cupRewards: CLAN_CUP_REWARDS,
            cupRules: { minHours: CLAN_CUP_MIN_HOURS, tstMinClans: CLAN_CUP_TST_MIN_CLANS, tstMinActive: CLAN_CUP_TST_MIN_ACTIVE },
            lastCupResult: pdata.clanCupResult || null,
            pendingCupReward: pdata.clanCupReward || null,
            tst: (pdata.progress || {}).tst || 0
        });
    } catch (e) { clanError(res, e, 'me'); }
});

// Список: рейтинг кубка недели + открытые кланы + поиск по названию
app.post('/api/clan/list', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const week = LeagueSystem.weekKey();
        const q = String(req.body.query || '').trim().toLowerCase().slice(0, 20);
        const cupSnap = await ClanSystem.cupRef(week).collection('clans').orderBy('points', 'desc').limit(30).get();
        const cupPoints = {};
        cupSnap.docs.forEach(d => { cupPoints[d.id] = d.data().points || 0; });
        let found;
        if (q) {
            found = await db.collection('clans').where('nameLower', '>=', q).where('nameLower', '<=', q + '\uf8ff').limit(20).get();
        } else {
            found = await db.collection('clans').where('open', '==', true).limit(30).get();
        }
        const cupIds = Object.keys(cupPoints);
        const cupDocs = cupIds.length ? await db.getAll(...cupIds.map(id => db.collection('clans').doc(id))) : [];
        const top = cupDocs.filter(d => d.exists).map(d => ({ ...ClanSystem.publicClan(d.id, d.data()), points: Math.floor(cupPoints[d.id]) }))
            .sort((a, b) => b.points - a.points).map((c, i) => ({ ...c, place: i + 1 }));
        const clans = found.docs.map(d => ({ ...ClanSystem.publicClan(d.id, d.data()), points: Math.floor(cupPoints[d.id] || 0) }))
            .filter(c => q || c.memberCount < c.maxMembers)
            .sort((a, b) => b.points - a.points || b.memberCount - a.memberCount);
        res.json({ success: true, week, top, clans });
    } catch (e) { clanError(res, e, 'list'); }
});

// Публичная карточка клана (для экрана приглашения)
app.post('/api/clan/info', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const id = String(req.body.clanId || '');
        if (!/^[A-Za-z0-9]{4,20}$/.test(id)) throw new Error('CLAN_NOT_FOUND');
        const view = await ClanSystem.getClanView(id, auth.playerId);
        if (!view) throw new Error('CLAN_NOT_FOUND');
        res.json({ success: true, clan: view });
    } catch (e) { clanError(res, e, 'info'); }
});

app.post('/api/clan/create', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const name = ClanSystem.validName(req.body.name);
        if (!name) throw new Error('BAD_NAME');
        const emblem = req.body.emblem;
        if (!CLAN_EMBLEMS.includes(emblem)) throw new Error('BAD_EMBLEM');
        const description = String(req.body.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const open = req.body.open !== false;
        const clanId = ClanSystem.newId();
        const playerRef = db.collection('players').doc(auth.playerId);
        const nameRef = db.collection('clanNames').doc(name.toLowerCase());
        const now = Date.now();
        const out = await db.runTransaction(async (tx) => {
            const [pDoc, nDoc] = await Promise.all([tx.get(playerRef), tx.get(nameRef)]);
            if (!pDoc.exists) throw new Error('PLAYER_NOT_FOUND');
            const pdata = pDoc.data();
            if (pdata.clan && pdata.clan.id) throw new Error('ALREADY_IN_CLAN');
            if (nDoc.exists) throw new Error('NAME_TAKEN');
            const tst = (pdata.progress || {}).tst || 0;
            if (tst < CLAN_CREATE_COST_TST) throw new Error('NOT_ENOUGH_TST');
            tx.set(db.collection('clans').doc(clanId), {
                name, nameLower: name.toLowerCase(), emblem, description, open,
                leaderId: auth.playerId, memberCount: 1, maxMembers: CLAN_MAX_MEMBERS, createdAt: now,
                members: { [auth.playerId]: { name: auth.name, role: 'leader', joinedAt: now } }
            });
            tx.set(nameRef, { clanId });
            tx.update(playerRef, { 'progress.tst': tst - CLAN_CREATE_COST_TST, clan: { id: clanId, role: 'leader', joinedAt: now } });
            ClanSystem.resetMemberCup(tx, auth.playerId, clanId, auth.name, now);
            return { newTst: tst - CLAN_CREATE_COST_TST };
        });
        res.json({ success: true, clanId, ...out });
    } catch (e) { clanError(res, e, 'create'); }
});

app.post('/api/clan/join', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const clanId = String(req.body.clanId || '');
        if (!/^[A-Za-z0-9]{4,20}$/.test(clanId)) throw new Error('CLAN_NOT_FOUND');
        const viaInvite = !!req.body.invite;
        const playerRef = db.collection('players').doc(auth.playerId);
        const clanRef = db.collection('clans').doc(clanId);
        const now = Date.now();
        await db.runTransaction(async (tx) => {
            const [pDoc, cDoc] = await Promise.all([tx.get(playerRef), tx.get(clanRef)]);
            if (!pDoc.exists) throw new Error('PLAYER_NOT_FOUND');
            if (!cDoc.exists) throw new Error('CLAN_NOT_FOUND');
            const pdata = pDoc.data(), c = cDoc.data();
            if (pdata.clan && pdata.clan.id) throw new Error('ALREADY_IN_CLAN');
            const until = (pdata.clanLeftAt || 0) + CLAN_REJOIN_COOLDOWN_MS;
            if (until > now) { const err = new Error('COOLDOWN'); err.until = until; throw err; }
            if (!c.open && !viaInvite) throw new Error('CLAN_NOT_FOUND');
            if ((c.memberCount || 0) >= (c.maxMembers || CLAN_MAX_MEMBERS)) throw new Error('CLAN_FULL');
            tx.update(clanRef, {
                memberCount: (c.memberCount || 0) + 1,
                [`members.${auth.playerId}`]: { name: auth.name, role: 'member', joinedAt: now }
            });
            tx.update(playerRef, { clan: { id: clanId, role: 'member', joinedAt: now } });
            ClanSystem.resetMemberCup(tx, auth.playerId, clanId, auth.name, now);
        });
        res.json({ success: true, clanId });
    } catch (e) { clanError(res, e, 'join'); }
});

// Выход: лидер передаёт роль самому "старому" участнику; последний участник распускает клан
app.post('/api/clan/leave', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const playerRef = db.collection('players').doc(auth.playerId);
        const now = Date.now();
        const out = await db.runTransaction(async (tx) => {
            const pDoc = await tx.get(playerRef);
            if (!pDoc.exists) throw new Error('PLAYER_NOT_FOUND');
            const pclan = pDoc.data().clan;
            if (!pclan || !pclan.id) throw new Error('NOT_IN_CLAN');
            const clanRef = db.collection('clans').doc(pclan.id);
            const cDoc = await tx.get(clanRef);
            tx.update(playerRef, { clan: null, clanLeftAt: now });
            if (!cDoc.exists) return { disbanded: true };
            const c = cDoc.data();
            const members = { ...(c.members || {}) };
            delete members[auth.playerId];
            const rest = Object.entries(members);
            if (!rest.length) {
                tx.delete(clanRef);
                tx.delete(db.collection('clanNames').doc(c.nameLower));
                return { disbanded: true };
            }
            const updates = { memberCount: rest.length, [`members.${auth.playerId}`]: admin.firestore.FieldValue.delete() };
            if (c.leaderId === auth.playerId) {
                const [newLeaderId] = rest.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
                updates.leaderId = newLeaderId;
                updates[`members.${newLeaderId}.role`] = 'leader';
                tx.update(db.collection('players').doc(newLeaderId), { 'clan.role': 'leader' });
            }
            tx.update(clanRef, updates);
            return { disbanded: false };
        });
        res.json({ success: true, ...out, rejoinAt: now + CLAN_REJOIN_COOLDOWN_MS });
    } catch (e) { clanError(res, e, 'leave'); }
});

app.post('/api/clan/kick', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const target = String(req.body.playerId || '');
        if (!target || target === auth.playerId) throw new Error('NOT_MEMBER');
        const playerRef = db.collection('players').doc(auth.playerId);
        await db.runTransaction(async (tx) => {
            const pDoc = await tx.get(playerRef);
            const pclan = pDoc.exists && pDoc.data().clan;
            if (!pclan || !pclan.id) throw new Error('NOT_IN_CLAN');
            const clanRef = db.collection('clans').doc(pclan.id);
            const targetRef = db.collection('players').doc(target);
            const [cDoc, tDoc] = await Promise.all([tx.get(clanRef), tx.get(targetRef)]);
            if (!cDoc.exists) throw new Error('CLAN_NOT_FOUND');
            const c = cDoc.data();
            if (c.leaderId !== auth.playerId) throw new Error('NOT_LEADER');
            if (!(c.members || {})[target]) throw new Error('NOT_MEMBER');
            tx.update(clanRef, { memberCount: Math.max(0, (c.memberCount || 1) - 1), [`members.${target}`]: admin.firestore.FieldValue.delete() });
            // исключённый игрок не получает кулдаун на вступление
            if (tDoc.exists) tx.update(targetRef, { clan: null });
        });
        res.json({ success: true });
    } catch (e) { clanError(res, e, 'kick'); }
});

app.post('/api/clan/update', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        const pDoc = await db.collection('players').doc(auth.playerId).get();
        const pclan = pDoc.exists && pDoc.data().clan;
        if (!pclan || !pclan.id) throw new Error('NOT_IN_CLAN');
        const clanRef = db.collection('clans').doc(pclan.id);
        await db.runTransaction(async (tx) => {
            const cDoc = await tx.get(clanRef);
            if (!cDoc.exists) throw new Error('CLAN_NOT_FOUND');
            if (cDoc.data().leaderId !== auth.playerId) throw new Error('NOT_LEADER');
            const updates = {};
            if (typeof req.body.open === 'boolean') updates.open = req.body.open;
            if (typeof req.body.description === 'string') updates.description = req.body.description.replace(/\s+/g, ' ').trim().slice(0, 120);
            if (req.body.emblem !== undefined) {
                if (!CLAN_EMBLEMS.includes(req.body.emblem)) throw new Error('BAD_EMBLEM');
                updates.emblem = req.body.emblem;
            }
            if (Object.keys(updates).length) tx.update(clanRef, updates);
        });
        res.json({ success: true });
    } catch (e) { clanError(res, e, 'update'); }
});

app.post('/api/clan/claim-cup', async (req, res) => {
    try {
        const auth = await clanAuth(req, res); if (!auth) return;
        await ClanSystem.settle(auth.playerId);
        const playerRef = db.collection('players').doc(auth.playerId);
        const result = await db.runTransaction(async (tx) => {
            const doc = await tx.get(playerRef);
            if (!doc.exists) throw new Error('PLAYER_NOT_FOUND');
            const data = doc.data();
            const progress = data.progress || {};
            if (!data.clanCupReward) throw new Error('NO_REWARD');
            const { updates, out } = LeagueRewards.apply(progress, data.clanCupReward);
            updates.clanCupReward = null;
            tx.update(playerRef, updates);
            return {
                granted: out,
                newTsp: updates['progress.tsp'] ?? (progress.tsp || 0),
                newTst: updates['progress.tst'] ?? (progress.tst || 0),
                incomeBoost: updates['progress.incomeBoost'] || progress.incomeBoost || null
            };
        });
        res.json({ success: true, ...result });
    } catch (e) { clanError(res, e, 'claim-cup'); }
});

// Health check (без изменений)
app.get('/api/health', (req, res) => res.json({ status: "ok", firebase: !!admin.apps.length }));

module.exports = app;