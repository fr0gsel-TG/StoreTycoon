const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const { createTonPayTransfer, verifySignature, TON } = require("@ton-pay/api");

// Инициализируем базу данных
admin.initializeApp();
const db = admin.firestore();

// 🔒 СЕКРЕТНЫЕ ЦЕНЫ ХРАНЯТСЯ ТОЛЬКО НА СЕРВЕРЕ!
// Хакер не сможет подменить цену, так как сервер берет её отсюда.
const PACKAGES = {
    "pack_50": { priceTON: 0.5, rewardTST: 50 },
    "pack_250": { priceTON: 2.0, rewardTST: 275 },
    "pack_1000": { priceTON: 5.0, rewardTST: 1150 }
};

// ==========================================
// ЭНДПОИНТ 1: Создание ссылки на оплату (Вызывает игра)
// ==========================================
exports.createInvoice = functions.https.onRequest((req, res) => {
    // cors разрешает запросы из браузера
    cors(req, res, async () => {
        try {
            const { playerId, packageId } = req.body;

            // 1. Проверяем, существует ли такой пакет
            if (!playerId || !packageId || !PACKAGES[packageId]) {
                return res.status(400).json({ error: "Неверные данные пакета" });
            }

            const pack = PACKAGES[packageId];

            // 2. Создаем платеж через SDK TonPay
            const transfer = await createTonPayTransfer({
                amount: pack.priceTON,
                asset: TON,
                commentToSender: `StoreTycoon: ${pack.rewardTST} 💎`,
                commentToRecipient: `Оплата пака ${packageId} от ${playerId}`,
            }, {
                chain: 'mainnet', // Используем основную сеть TON
                apiKey: process.env.TONPAY_API_KEY // Секретный ключ из .env
            });

            // 3. Сохраняем счет в нашу базу Firestore
            await db.collection("invoices").add({
                playerId: playerId,
                packageId: packageId,
                amountTST: pack.rewardTST,
                tonAmount: pack.priceTON,
                tonPayReference: transfer.reference,
                status: "pending",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 4. Отправляем игру ссылку на оплату
            return res.status(200).json({ paymentUrl: transfer.paymentLink });

        } catch (error) {
            console.error("Ошибка создания инвойса:", error);
            return res.status(500).json({ error: "Ошибка сервера при создании платежа" });
        }
    });
});

// ==========================================
// ЭНДПОИНТ 2: Вебхук об успешной оплате (Вызывает сервер TonPay)
// ==========================================
exports.tonpayWebhook = functions.https.onRequest(async (req, res) => {
    try {
        const signature = req.headers['x-tonpay-signature'];
        
        // 1. ЗАЩИТА: Проверяем подпись. Если это хакер — отклоняем!
        const isValid = verifySignature(req.body, signature, process.env.TONPAY_API_SECRET);
        
        if (!isValid) {
            console.warn("🚨 Попытка взлома! Неверная подпись вебхука.");
            return res.status(403).send('Forbidden');
        }

        const paymentData = req.body;

        // 2. Если TonPay говорит, что деньги получены
        if (paymentData.status === 'COMPLETED') {
            const invoicesRef = db.collection('invoices');
            // Ищем инвойс по уникальному номеру транзакции
            const snapshot = await invoicesRef.where('tonPayReference', '==', paymentData.reference).get();

            if (snapshot.empty) {
                return res.status(404).send('Инвойс не найден');
            }

            const invoiceDoc = snapshot.docs[0];
            const invoice = invoiceDoc.data();

            // 3. Защита от двойного начисления (выдаем награду только если статус pending)
            if (invoice.status === 'pending') {
                const batch = db.batch(); // Используем пакетное обновление для надежности

                // Меняем статус инвойса на оплаченный
                batch.update(invoiceDoc.ref, { status: 'paid' });

                // Начисляем кристаллы игроку
                const playerRef = db.collection('players').doc(invoice.playerId);
                batch.update(playerRef, {
                    tst: admin.firestore.FieldValue.increment(invoice.amountTST)
                });

                // Применяем изменения в базе
                await batch.commit();
                console.log(`✅ Начислено ${invoice.amountTST} TST игроку ${invoice.playerId}`);
            }
        }

        // Обязательно отвечаем TonPay, что мы всё поняли
        return res.status(200).send('OK');
    } catch (error) {
        console.error("Ошибка вебхука:", error);
        return res.status(500).send('Server Error');
    }
});