const express = require('express');
const app = express();
app.use(express.json());

// Health check
app.get('/bot/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Webhook для Telegram
app.post('/bot/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (message && message.text === '/game') {
      const chatId = message.chat.id;
      
      // Отправляем сообщение с кнопкой, открывающей Web App
      const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || '7724093672:AAFIGIE309gvO7PCdYogX1BrqmDUFNAtug8'}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🎮 *StoreTycoon: IT Empire*\n\nПострой свою IT-империю прямо в Telegram!`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: '🎮 Играть в Telegram',
                web_app: { url: `https://tycoon03.vercel.app/?tg=${chatId}` }
              }
            ]]
          }
        })
      });
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ ok: false });
  }
});

module.exports = app;