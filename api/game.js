const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
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

        await db.runTransaction(async (transaction) => {
            const playerDoc = await transaction.get(playerRef);
            // Игрок создаётся только через /api/load — здесь не создаём.
            if (!playerDoc.exists) throw new Error('PLAYER_NOT_FOUND');

            const progress = playerDoc.data().progress || {};
            knownLeague = playerDoc.data().league || null;
            const now = Date.now();

            // Сервер сам считает, сколько игрок мог заработать с прошлой синхронизации.
            // Сумма от клиента — только заявка, начисляется не больше потолка.
            const lastSync = toMillis(progress.lastIncomeSync) || toMillis(progress.lastSaved) || now;
            const elapsedSec = Math.min(Math.max((now - lastSync) / 1000, 0), MAX_SYNC_WINDOW_SEC);

            newAutoClicker = GameFormulas.recalculateGlobalIncome(progress);
            const clickPower = progress.clickPower || 1;
            const maxAllowed = elapsedSec * (newAutoClicker * MAX_INCOME_MULTIPLIER + clickPower * MAX_CLICKS_PER_SEC);

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

            if (offlineIncome > 0) await LeagueSystem.addPoints(playerId, offlineIncome, LeagueSystem.displayName(initData));

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
            if (league.week && league.groupId) {
                const snap = await tx.get(db.collection('leagueEntries').where('groupId', '==', league.groupId));
                const entries = snap.docs.map(d => d.data());
                const result = this.computeResult(entries, playerId, tier);
                if (result) {
                    lastResult = { ...result, week: league.week };
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
            const newLeague = { week, tier, groupId, name: name || league.name || 'Игрок', lastResult };
            tx.update(playerRef, { league: newLeague });
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
            lastResult: league.lastResult || null
        });
    } catch (error) {
        if (error.message === 'PLAYER_NOT_FOUND') return res.status(404).json({ success: false, error: 'Игрок не найден.' });
        console.error('Ошибка лиги:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// Health check (без изменений)
app.get('/api/health', (req, res) => res.json({ status: "ok", firebase: !!admin.apps.length }));

module.exports = app;