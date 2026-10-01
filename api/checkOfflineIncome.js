const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        })
    });
}

const db = admin.firestore();

module.exports = async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }

    const now = Date.now();
    const fourHoursAgoMs = now - (4 * 60 * 60 * 1000);
    const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

    try {
        // progress.lastSaved — то же поле, что реально использует /api/load для
        // начисления оффлайн-дохода (обновляется на каждом действии игрока, не
        // только при открытии приложения, как верхнеуровневый lastSaved раньше).
        const snapshot = await db.collection('players')
            .where('progress.lastSaved', '<', fourHoursAgoMs)
            .get();

        if (snapshot.empty) {
            return res.status(200).send("No inactive players to notify.");
        }

        const promises = [];
        let notifiedCount = 0;

        for (const doc of snapshot.docs) {
            const player = doc.data();
            const playerId = doc.id;

            if (player.progress && player.progress.autoClicker > 0) {
                const lastNotified = player.lastNotified ? player.lastNotified.toDate().getTime() : 0;
                if (now - lastNotified < (12 * 60 * 60 * 1000)) {
                    continue; // Пропускаем, если недавно уведомляли
                }
                
                // --- НОВАЯ ЛОГИКА: РАССЧЕТ ОФФЛАЙН-ДОХОДА ---
                const lastSavedTime = player.progress.lastSaved;
                const diffInSeconds = Math.floor((now - lastSavedTime) / 1000);
                // Тот же лимит, что и в /api/load: базовые 3 часа или купленное улучшение
                const offlineLimit = player.progress.offlineLimit || 10800;
                const secondsToCalculate = Math.min(diffInSeconds, offlineLimit);
                const offlineIncome = Math.floor(secondsToCalculate * player.progress.autoClicker);

                // Отправляем уведомление, только если есть что забирать
                if (offlineIncome <= 0) {
                    continue;
                }
                // --- КОНЕЦ НОВОЙ ЛОГИКИ ---

                const messageData = {
                    chat_id: playerId,
                    // Одинарный * — legacy parse_mode: 'Markdown' не понимает GFM-style **bold**
                    text: `💰 *Ваша IT-империя ждет!*\n\nПока вас не было, компания заработала *${offlineIncome.toLocaleString('ru-RU')}$*!\n\nЗайдите в игру, чтобы забрать свой доход.`,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "🎮 Забрать доход!", web_app: { url: "https://tycoon03.vercel.app/" } }
                        ]]
                    }
                };

                promises.push(axios.post(`${TELEGRAM_API}/sendMessage`, messageData));
                promises.push(db.collection('players').doc(playerId).update({ 
                    lastNotified: admin.firestore.FieldValue.serverTimestamp() 
                }));
                notifiedCount++;
            }
        }

        if (promises.length > 0) {
            // allSettled, а не all: игрок, заблокировавший бота (403 от Telegram),
            // не должен обрывать отправку остальным и валить весь запуск в 500.
            const results = await Promise.allSettled(promises);
            const failed = results.filter(r => r.status === 'rejected').length;
            if (failed > 0) {
                console.warn(`${failed} операций из ${promises.length} завершились с ошибкой (вероятно, часть игроков заблокировала бота).`);
            }
        }
        
        const message = `Уведомления отправлены ${notifiedCount} игрокам.`;
        console.log(message);
        return res.status(200).send(message);

    } catch (error) {
        console.error("Ошибка при проверке оффлайн-дохода:", error);
        return res.status(500).send('Internal Server Error');
    }
};