require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONITOR_URL = process.env.MONITOR_URL || 'https://maysara.devops.uz/dashboard/home';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');

if (!BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in the environment or .env file!');
  process.exit(1);
}

// State variables
let isServerDown = false;
let botInstance = null;

// Helpers to read/write subscribers
function getSubscribers() {
  try {
    if (!fs.existsSync(SUBSCRIBERS_FILE)) {
      fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const data = fs.readFileSync(SUBSCRIBERS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading subscribers file:', err);
    return [];
  }
}

function saveSubscribers(subscribers) {
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2));
  } catch (err) {
    console.error('Error writing subscribers file:', err);
  }
}

function addSubscriber(chat) {
  const subs = getSubscribers();
  if (!subs.some(s => s.id === chat.id)) {
    subs.push({
      id: chat.id,
      title: chat.title || chat.username || `${chat.first_name || ''} ${chat.last_name || ''}`.trim() || 'Unknown Chat',
      type: chat.type,
      addedAt: new Date().toISOString()
    });
    saveSubscribers(subs);
    console.log(`[INFO] New subscriber added: ${chat.title || chat.username || chat.id} (${chat.type})`);
    return true;
  }
  return false;
}

function removeSubscriber(chatId) {
  const subs = getSubscribers();
  const filtered = subs.filter(s => s.id !== chatId);
  if (subs.length !== filtered.length) {
    saveSubscribers(filtered);
    console.log(`[INFO] Subscriber removed: ${chatId}`);
    return true;
  }
  return false;
}

// Bot Initialisation
try {
  botInstance = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('[INFO] Telegram Bot successfully initialized and polling started.');
} catch (error) {
  console.error('[FATAL] Failed to initialize Telegram Bot:', error);
  process.exit(1);
}

const bot = botInstance;

// Broadcast helper
async function broadcast(messageText, parseMode = 'HTML') {
  const subs = getSubscribers();
  if (subs.length === 0) {
    console.log('[INFO] Broadcast triggered but no subscribers registered.');
    return;
  }

  console.log(`[INFO] Broadcasting to ${subs.length} subscriber(s)...`);
  for (const sub of subs) {
    try {
      await bot.sendMessage(sub.id, messageText, { parse_mode: parseMode });
      console.log(`[SEND] Sent status update to chat: ${sub.title} (${sub.id})`);
    } catch (err) {
      console.error(`[ERROR] Failed to send message to ${sub.id}:`, err.message);
      // Remove subscriber if they blocked the bot or chat is not found
      if (
        err.message.includes('blocked') ||
        err.message.includes('chat not found') ||
        err.message.includes('deactivated') ||
        err.message.includes('kicked') ||
        err.message.includes('forbidden')
      ) {
        removeSubscriber(sub.id);
      }
    }
  }
}

// Bot Command Handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isNew = addSubscriber(msg.chat);

  let responseMsg = `👋 <b>Assalomu alaykum!</b>\n\n`;
  if (isNew) {
    responseMsg += `Ushbu chat server holatini tekshirish xabarlariga <b>muvaffaqiyatli a'zo bo'ldi</b>. ✅\n\n`;
  } else {
    responseMsg += `Ushbu chat allaqachon a'zolar ro'yxatida mavjud. 👌\n\n`;
  }

  responseMsg += `🖥️ <b>Kuzatilayotgan Server:</b> <code>${MONITOR_URL}</code>\n`;
  responseMsg += `⏱️ <b>Tekshiruv oralig'i:</b> <code>${CHECK_INTERVAL_MS / 1000} soniya</code>\n\n`;
  responseMsg += `<i>Agar server ishlamay qolsa (500+ xatolik yoki ulanish uzilsa), sizga darhol xabar yuboriladi.</i>`;

  bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML' }).catch(err => {
    console.error(`Error sending start response to ${chatId}:`, err.message);
  });
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  const wasRemoved = removeSubscriber(chatId);

  let responseMsg = '';
  if (wasRemoved) {
    responseMsg = `📴 Siz server holati bildirishnomalaridan <b>muvaffaqiyatli chiqdingiz</b>.`;
  } else {
    responseMsg = `⚠️ Siz bildirishnomalarga a'zo bo'lmagansiz.`;
  }

  bot.sendMessage(chatId, responseMsg, { parse_mode: 'HTML' }).catch(err => {
    console.error(`Error sending stop response to ${chatId}:`, err.message);
  });
});

// Immediate Status Request Command
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  const startTime = Date.now();
  let statusInfo = '';

  try {
    const response = await axios.get(MONITOR_URL, {
      timeout: 10000,
      headers: { 'User-Agent': 'MaysaraHealthCheckerBot/1.0' },
      validateStatus: () => true // Receive response for any status code
    });

    const elapsed = Date.now() - startTime;
    const dateStr = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });

    if (response.status >= 500) {
      statusInfo = `🔴 <b>Serverda xatolik!</b>\n\n` +
                   `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                   `❌ <b>Holat:</b> Xato javobi qaytdi (Status: <b>${response.status}</b>)\n` +
                   `⏱️ <b>Javob vaqti:</b> <code>${elapsed} ms</code>\n` +
                   `📅 <b>Sana va vaqt:</b> <code>${dateStr}</code>`;
    } else {
      statusInfo = `🟢 <b>Server muvaffaqiyatli ishlamoqda!</b>\n\n` +
                   `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                   `✅ <b>Holat:</b> Ishchi holatda (Status: <b>${response.status}</b>)\n` +
                   `⏱️ <b>Javob vaqti:</b> <code>${elapsed} ms</code>\n` +
                   `📅 <b>Sana va vaqt:</b> <code>${dateStr}</code>`;
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const dateStr = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });

    statusInfo = `🔴 <b>Server o'chgan yoki ulanib bo'lmadi!</b>\n\n` +
                 `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                 `❌ <b>Xatolik:</b> <code>${err.message || 'Ulanish xatosi'}</code>\n` +
                 `⏱️ <b>Urinish vaqti:</b> <code>${elapsed} ms</code>\n` +
                 `📅 <b>Sana va vaqt:</b> <code>${dateStr}</code>`;
  }

  bot.sendMessage(chatId, statusInfo, { parse_mode: 'HTML' }).catch(err => {
    console.error(`Error sending status response to ${chatId}:`, err.message);
  });
});

// Periodic Server Monitoring Logic
async function monitorServer() {
  const startTime = Date.now();
  const dateStr = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });

  try {
    const response = await axios.get(MONITOR_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'MaysaraHealthCheckerBot/1.0' },
      validateStatus: () => true
    });

    const elapsed = Date.now() - startTime;

    // Check if it's a server error (500+)
    if (response.status >= 500) {
      if (!isServerDown) {
        isServerDown = true;
        const alertMsg = `⚠️ <b>SERVERDA XATOLIK ANIQLANDI!</b> ⚠️\n\n` +
                         `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                         `❌ <b>Holat:</b> Serverdan xato javob qaytdi (Status: <b>${response.status}</b>)\n` +
                         `⏱️ <b>Javob vaqti:</b> <code>${elapsed} ms</code>\n` +
                         `📅 <b>Vaqt:</b> <code>${dateStr}</code>\n\n` +
                         `<i>Tizim administratorlari ogohlantirildi. Server qayta tiklanishi kutilmoqda.</i>`;
        await broadcast(alertMsg);
      }
    } else {
      // Server returned success (<500), check if it recovered
      if (isServerDown) {
        isServerDown = false;
        const recoveryMsg = `✅ <b>SERVER QAYTA TIKLANDI!</b> ✅\n\n` +
                            `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                            `❇️ <b>Holat:</b> Ishchi holatga qaytdi (Status: <b>${response.status}</b>)\n` +
                            `⏱️ <b>Javob vaqti:</b> <code>${elapsed} ms</code>\n` +
                            `📅 <b>Vaqt:</b> <code>${dateStr}</code>\n\n` +
                            `<i>Server yana muvaffaqiyatli ishlamoqda.</i>`;
        await broadcast(recoveryMsg);
      }
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;

    // Axios error indicates network issues / timeout / server offline
    if (!isServerDown) {
      isServerDown = true;
      const alertMsg = `⚠️ <b>SERVER O'CHDI YOKI ULANIB BO'LMADI!</b> ⚠️\n\n` +
                       `🖥️ <b>Server:</b> <code>${MONITOR_URL}</code>\n` +
                       `❌ <b>Xatolik:</b> <code>${err.message || 'Tarmoq xatosi'}</code>\n` +
                       `⏱️ <b>Urinish vaqti:</b> <code>${elapsed} ms</code>\n` +
                       `📅 <b>Vaqt:</b> <code>${dateStr}</code>\n\n` +
                       `<i>Ulanish uzildi. Server muammosi bartaraf etilishini kuting.</i>`;
      await broadcast(alertMsg);
    }
  }
}

// Start Scheduler
console.log(`[INFO] Server health monitoring started. Interval: ${CHECK_INTERVAL_MS / 1000}s`);
setInterval(monitorServer, CHECK_INTERVAL_MS);

// Run an initial check on startup after a brief delay
setTimeout(monitorServer, 3000);

// Add a dummy HTTP server to bind to PORT for Render compatibility
const http = require('http');
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', message: 'Maysara Health Checker Bot is running.' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[INFO] HTTP server listening on port ${PORT} for Render health checks.`);
});
