const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

app.use(express.json());
app.use(cors()); // Разрешаем запросы от игры

// ==========================================
// 1. ИНИЦИАЛИЗАЦИЯ FIREBASE
// ==========================================
try {
    if (!admin.apps.length) {
        let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
        // Очищаем ключ от возможных лишних символов
        privateKey = privateKey.replace(/\\n/g, '\n').replace(/"/g, '');
        
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
// 2. ФУНКЦИИ ВЕРИФИКАЦИИ TELEGRAM
// ==========================================
function verifyTelegramAuth(initData, botToken) {
    if (!initData || !botToken) return false;

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();
            
        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');
            
        return computedHash === hash;
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

// ==========================================
// 3. ЭНДПОИНТЫ API
// ==========================================

// СОХРАНЕНИЕ ПРОГРЕССА
app.post('/api/save', async (req, res) => {
    try {
        const { initData, progress } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        // Проверяем, что запрос реально от Телеграма
        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись Telegram.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId || !progress) {
            return res.status(400).json({ success: false, error: 'Отсутствуют данные или ID.' });
        }

        // Пишем в Firebase
        await db.collection('players').doc(playerId).set(
            { progress: progress, lastSaved: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true } // merge: true защищает от случайного затирания других полей
        );

        res.json({ success: true, message: 'Прогресс успешно сохранен!' });
    } catch (error) {
        console.error("Ошибка при сохранении:", error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// ЗАГРУЗКА ПРОГРЕССА
app.post('/api/load', async (req, res) => {
    try {
        const { initData } = req.body;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        // Защищаем загрузку (чтобы никто не мог скачать чужое сохранение, подставив чужой ID)
        if (!verifyTelegramAuth(initData, botToken)) {
            return res.status(403).json({ success: false, error: 'Неверная подпись Telegram.' });
        }

        const playerId = getPlayerIdFromInitData(initData);
        if (!playerId) {
            return res.status(400).json({ success: false, error: 'Не удалось получить ID игрока.' });
        }

        // Читаем из Firebase
        const doc = await db.collection('players').doc(playerId).get();

        if (doc.exists && doc.data().progress) {
            res.json({ success: true, progress: doc.data().progress });
        } else {
            // Если игрок новый
            res.json({ success: true, progress: null, message: 'Новый игрок. Сохранение не найдено.' });
        }
    } catch (error) {
        console.error("Ошибка при загрузке:", error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});

// ПРОВЕРКА РАБОТОСПОСОБНОСТИ СЕРВЕРА
app.get('/api/health', (req, res) => res.json({ status: "ok", firebase: !!admin.apps.length }));

module.exports = app;