const express = require('express');
const axios = require('axios'); // Импортируем axios
const app = express();
app.use(express.json());

// URL вашего игрового сервера на Vercel
const GAME_API_URL = 'https://tycoon03.vercel.app/api'; 

// Health check
app.get('/bot/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Webhook для Telegram
app.post('/bot/webhook', async (req, res) => {
  // Подлинность запроса: секрет, заданный в setWebhook(..., secret_token=...),
  // Telegram присылает в этом заголовке на КАЖДЫЙ вызов вебхука. Без
  // TELEGRAM_WEBHOOK_SECRET на Vercel сравнение идёт с undefined — все запросы
  // отклоняются (fail-closed), это ожидаемо и безопасно, а не баг.
  //
  // ВАЖНО ПРО ПОРЯДОК НАСТРОЙКИ: сначала задай TELEGRAM_WEBHOOK_SECRET в
  // Vercel и вызови setWebhook с тем же секретом, и только потом деплой этот
  // код — иначе бот временно перестанет отвечать на /start между деплоем и
  // настройкой секрета.
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    // Обработка команд /start и /game
    if (text.startsWith('/start') || text.startsWith('/game')) {
      
      // Если это /start с рефералом (через обычную ссылку бота)
      const textParts = text.split(' ');
      if (textParts.length > 1 && textParts[1].startsWith('ref_')) {
        const referrerId = textParts[1].replace('ref_', '');
        await axios.post(`${GAME_API_URL}/handle-start`, {
          userId: chatId,
          referrerId: referrerId
        }).catch(e => console.error("Ref error:", e.message));
      }

      // Отправляем сообщение с кнопкой запуска игры
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `🚀 *Ваша IT-империя ждет!*\n\nНажмите кнопку ниже, чтобы зайти в игру:`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '🎮 Играть',
              web_app: { url: `https://tycoon03.vercel.app/` } 
            }
          ]]
        }
      });
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).json({ ok: false });
  }
});

module.exports = app;