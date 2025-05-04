
const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');


const express = require('express');
const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const URL = process.env.RENDER_EXTERNAL_URL;

bot.setWebHook(`${URL}/telegram`);

app.post('/telegram', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('✅ Kucoin Mint Tracker Webhook is running.');
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook server listening on port ${PORT}`);
});

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const PUBLIC_CHAT_ID = Number(process.env.PUBLIC_CHAT_ID);
const PRIVATE_CHAT_ID = Number(process.env.PRIVATE_CHAT_ID);
const BINANCE_CHAT_ID = Number(process.env.BINANCE_CHAT_ID);

const seenSignatures = new Set();
const activeWatchers = new Map();

setInterval(() => {
  console.log('📡 Global ping');
}, 180000);

bot.on('message', (msg) => {
  console.log('📥 ВХОДЯЩЕЕ СООБЩЕНИЕ:');
  console.log(JSON.stringify(msg, null, 2));
  try {
    const text = msg.text;
    const senderId = msg.chat.id;
    if (!text || senderId !== PUBLIC_CHAT_ID) return;

    let label = null;
    if (text.includes('Кук-3') && text.includes('68.99')) {
      label = 'Кук-3';
    } else if (text.includes('Кук-1')) {
      label = 'Кук-1';
    } else if (text.includes('Бинанс') && (text.includes('99.99') || text.includes('99.999'))) {
      label = 'Бинанс';
    } else return;

    
    let wallet = null;
    const links = msg.entities?.filter(e => e.type === 'text_link' && e.url?.includes('solscan.io/account/'));
    if (links?.length >= 2) {
      const match = links[1].url.match(/account\/(\w{32,44})/);
      wallet = match?.[1];
    }
    if (!wallet) return;


    const targetChat = label === 'Бинанс' ? BINANCE_CHAT_ID : PRIVATE_CHAT_ID;
    const alertMsg = `⚠️ [${label}] Обнаружен перевод ${label === 'Кук-3' ? '68.99' : '99.99'} SOL\n💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`;
    bot.sendMessage(targetChat, alertMsg, { parse_mode: 'HTML' });

    watchMint(wallet, label, targetChat);
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err.message);
  }
});


bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  const list = Array.from(activeWatchers.entries());
  if (!list.length) {
    bot.sendMessage(chatId, '📭 Нет активных слежений.');
  } else {
    const formatted = list.map(([wallet, meta]) => `${meta.label}: ${wallet}`).join('\n');
    bot.sendMessage(chatId, `📋 Активные адреса:\n<code>${formatted}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  const wallet = match[1].trim();
  const meta = activeWatchers.get(wallet);
  if (meta) {
    meta.ws.close();
    activeWatchers.delete(wallet);
    bot.sendMessage(chatId, `❌ Слежение остановлено: <code>${meta.label}: ${wallet}</code>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(chatId, `⚠️ Адрес <code>${wallet}</code> не отслеживается.`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/delete$/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  for (const [wallet, meta] of activeWatchers.entries()) {
    meta.ws.close();
    activeWatchers.delete(wallet);
  }
  bot.sendMessage(chatId, '🧹 Все слежения остановлены.');
});



bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  bot.sendMessage(chatId, '👋 Панель управления', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Список адресов', callback_data: 'list' }],
        [{ text: '🧹 Удалить все', callback_data: 'delete_all' }]
      ]
    }
  });
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'list') {
    const list = Array.from(activeWatchers.entries());
    if (!list.length) {
      bot.sendMessage(chatId, '📭 Нет активных адресов.');
    } else {
      const buttons = list.map(([addr, meta]) => ([{ text: `❌ ${meta.label}: ${addr}`, callback_data: `delete_${addr}` }]));
      bot.sendMessage(chatId, '📋 Активные адреса:', {
        reply_markup: {
          inline_keyboard: [...buttons, [{ text: '🧹 Удалить все', callback_data: 'delete_all' }]]
        }
      });
    }
  } else if (data === 'delete_all') {
    for (const [wallet, meta] of activeWatchers.entries()) {
      meta.ws.close();
      activeWatchers.delete(wallet);
    }
    bot.sendMessage(chatId, '🧹 Все слежения остановлены.');
  } else if (data.startsWith('delete_')) {
    const wallet = data.replace('delete_', '');
    const meta = activeWatchers.get(wallet);
    if (meta) {
      meta.ws.close();
      activeWatchers.delete(wallet);
      bot.sendMessage(chatId, `❌ Слежение остановлено: <code>${meta.label}: ${wallet}</code>`, { parse_mode: 'HTML' });
    }
  }
});



bot.onText(/\/inspect/, (msg) => {
  const chatId = msg.chat.id;
  if (!msg.reply_to_message) {
    bot.sendMessage(chatId, '❗ Используйте команду /inspect в ответ на сообщение.');
    return;
  }

  try {
    const inspected = JSON.stringify(msg.reply_to_message, null, 2);
    console.log("🕵️ INSPECTED MESSAGE:");
    console.log(inspected);
    bot.sendMessage(chatId, '📤 Структура сообщения отправлена в консоль Render.');
  } catch (e) {
    bot.sendMessage(chatId, '❌ Ошибка при обработке сообщения.');
    console.error('Inspect error:', e.message);
  }
});


function watchMint(wallet, label, targetChat) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, { ws, label });

  const timeout = setTimeout(() => {
    const msg = `⌛ [${label}] Mint не обнаружен. Завершено слежение за <code>${wallet}</code>`;
    bot.sendMessage(targetChat, msg, { parse_mode: 'HTML' });
    ws.close();
    activeWatchers.delete(wallet);
  }, 20 * 60 * 60 * 1000);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`📡 [${label}] Ping ${wallet}`);
    }
  }, 180000);

  ws.on('open', () => {
    console.log(`✅ [${label}] Слежение начато за ${wallet}`);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [wallet] }, { commitment: 'confirmed', encoding: 'jsonParsed' }]
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const logs = msg?.params?.result?.value?.logs || [];
      const sig = msg?.params?.result?.value?.signature;
      const mentions = msg?.params?.result?.value?.mentions || [];

      if (!sig || seenSignatures.has(sig)) return;
      if (!logs.some(log => log.includes('InitializeMint'))) return;

      const mintAddress = mentions[0] || 'неизвестен';
      seenSignatures.add(sig);
      clearTimeout(timeout);
      clearInterval(pingInterval);

      const mintMsg = `✅ [${label}] Mint выполнен!\n🧾 Контракт: <code>${mintAddress}</code>`;
      bot.sendMessage(targetChat, mintMsg, { parse_mode: 'HTML' });

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      console.error(`⚠️ Ошибка обработки mint-сообщения: ${e.message}`);
    }
  });

  ws.on('error', (e) => {
    console.error(`💥 WebSocket ошибка: ${e.message}`);
    clearInterval(pingInterval);
    ws.close();
    activeWatchers.delete(wallet);
  });

  ws.on('close', () => {
    console.log(`❌ [${label}] WebSocket закрыт: ${wallet}`);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
  });
}
