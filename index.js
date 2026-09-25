// PATH: gramjs-controller/index.js
require('dotenv').config();

const { Bot, InlineKeyboard } = require('grammy');
const { MongoClient } = require('mongodb');
const GramJSManager = require('./src/gramjs-manager');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || 'gramjs_controller';
const OWNER_ID = Number(process.env.OWNER_ID);

if (!BOT_TOKEN || !API_ID || !API_HASH || !MONGO_URI || !OWNER_ID) {
  console.error('❌ Missing env vars. Check .env file.');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const mongo = new MongoClient(MONGO_URI);
const gm = new GramJSManager(API_ID, API_HASH);

let sessionsCol;
let sudoCol;

// ─────────────────────────────────────────────────────────
//  DB
// ─────────────────────────────────────────────────────────
async function initDb() {
  await mongo.connect();
  const db = mongo.db(MONGO_DB);
  sessionsCol = db.collection('sessions');
  sudoCol = db.collection('sudo_users');
  await sessionsCol.createIndex({ userId: 1 }, { unique: true });
  await sudoCol.createIndex({ userId: 1 }, { unique: true });
  console.log('✅ MongoDB connected');
}

async function saveSession(userId, sessionString) {
  await sessionsCol.updateOne(
    { userId },
    { $set: { userId, sessionString, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function loadSession(userId) {
  const doc = await sessionsCol.findOne({ userId });
  return doc?.sessionString || null;
}

async function deleteSession(userId) {
  await sessionsCol.deleteOne({ userId });
}

async function getAllSessions() {
  return await sessionsCol.find().toArray();
}

// ───── Sudo users ─────
async function isSudo(userId) {
  if (userId === OWNER_ID) return true;
  const doc = await sudoCol.findOne({ userId });
  return Boolean(doc);
}

async function addSudo(userId, addedBy) {
  await sudoCol.updateOne(
    { userId },
    { $set: { userId, addedBy, addedAt: new Date() } },
    { upsert: true }
  );
}

async function removeSudo(userId) {
  const res = await sudoCol.deleteOne({ userId });
  return res.deletedCount > 0;
}

async function listSudo() {
  return await sudoCol.find().toArray();
}

// ─────────────────────────────────────────────────────────
//  Notify function — sends message to the correct user
// ─────────────────────────────────────────────────────────
gm.setNotify(async (userId, text) => {
  try {
    await bot.api.sendMessage(userId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error(`[notify] failed for ${userId}:`, err.message);
  }
});

// ─────────────────────────────────────────────────────────
//  Error handler
// ─────────────────────────────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`❌ Error while handling update ${ctx?.update?.update_id}:`);
  console.error(err.error?.message || err.message);
  if (ctx?.chat?.id) {
    ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────
//  Middleware — owner OR sudo users only
// ─────────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return;

  // Allow /addsudo and /rmsudo only for the main OWNER (not sudo users).
  const text = ctx.message?.text || '';
  if (text.startsWith('/addsudo') || text.startsWith('/rmsudo') || text.startsWith('/listsudo')) {
    if (uid !== OWNER_ID) {
      return ctx.reply('⛔️ Only the main owner can manage sudo users.');
    }
    return next();
  }

  const allowed = await isSudo(uid);
  if (!allowed) {
    return ctx.reply('⛔️ This bot is private.');
  }
  return next();
});

// ─────────────────────────────────────────────────────────
//  Menus
// ─────────────────────────────────────────────────────────
function mainMenu() {
  return new InlineKeyboard()
    .text('📱 My Account', 'acc:me').row()
    .text('👥 Groups & Channels', 'acc:groups').row()
    .text('📥 Login with Session', 'acc:login').row()
    .text('🔌 Logout', 'acc:logout').row();
}

// ─────────────────────────────────────────────────────────
//  /start
// ─────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const uid = ctx.from.id;
  const connected = gm.isConnected(uid);
  const status = connected ? '🟢 <b>Connected</b>' : '🔴 <b>Not connected</b>';
  const isOwner = uid === OWNER_ID ? ' 👑' : '';

  await ctx.reply(
    `👋 <b>GramJS Account Controller</b>${isOwner}\n\n` +
      `Status: ${status}\n\n` +
      'What would you like to do?',
    { parse_mode: 'HTML', reply_markup: mainMenu() }
  );
});

// ─────────────────────────────────────────────────────────
//  Callback router — uses ctx.from.id (per-user)
// ─────────────────────────────────────────────────────────
bot.callbackQuery('acc:me', async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  if (!gm.isConnected(uid)) {
    return ctx.editMessageText('⚠️ Not connected. Use /login first.', { reply_markup: mainMenu() });
  }
  try {
    const me = await gm.getMe(uid);
    const phone = me.phone ? `+${me.phone}` : '— (hidden by privacy)';
    const username = me.username ? `@${me.username}` : '—';
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || '—';
    await ctx.editMessageText(
      '📱 <b>My Account</b>\n\n' +
        `👤 Name: <b>${escapeHtml(name)}</b>\n` +
        `🆔 ID: <code>${me.id}</code>\n` +
        `🔗 Username: ${escapeHtml(username)}\n` +
        `📞 Phone: <code>${escapeHtml(phone)}</code>\n` +
        `⭐ Premium: ${me.premium ? '✅ Yes' : '❌ No'}`,
      { parse_mode: 'HTML', reply_markup: mainMenu() }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ ${escapeHtml(err.message)}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery('acc:groups', async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  if (!gm.isConnected(uid)) {
    return ctx.editMessageText('⚠️ Not connected. Use /login first.', { reply_markup: mainMenu() });
  }

  await ctx.editMessageText('⏳ Loading your groups and channels...');
  try {
    const dialogs = await gm.getDialogs(uid);
    const groups = [];
    const channels = [];

    for (const d of dialogs) {
      if (!d.entity) continue;
      if (d.isGroup && !d.isChannel) {
        groups.push({ title: d.title || d.name || 'Untitled', id: d.id?.toString() });
      } else if (d.isChannel) {
        channels.push({
          title: d.title || d.name || 'Untitled',
          id: d.id?.toString(),
          broadcast: d.entity.broadcast === true,
          megagroup: d.entity.megagroup === true,
        });
      }
    }

    const total = groups.length + channels.length;
    let text =
      `👥 <b>Your Chats</b>\n\n` +
      `📊 Total: <b>${total}</b>\n` +
      `👥 Groups: <b>${groups.length}</b>\n` +
      `📢 Channels: <b>${channels.length}</b>\n\n`;

    if (total === 0) {
      text += '<i>No groups or channels found.</i>';
    } else {
      if (groups.length) {
        text += '<b>👥 Groups:</b>\n';
        for (const g of groups.slice(0, 30)) {
          text += `• ${escapeHtml(g.title)}\n  <code>${g.id}</code>\n`;
        }
        if (groups.length > 30) text += `<i>... and ${groups.length - 30} more</i>\n`;
        text += '\n';
      }
      if (channels.length) {
        text += '<b>📢 Channels:</b>\n';
        for (const c of channels.slice(0, 30)) {
          const type = c.broadcast ? 'Channel' : (c.megagroup ? 'Supergroup' : 'Channel');
          text += `• ${escapeHtml(c.title)} <i>(${type})</i>\n  <code>${c.id}</code>\n`;
        }
        if (channels.length > 30) text += `<i>... and ${channels.length - 30} more</i>\n`;
      }
    }

    if (text.length > 4000) {
      text = text.slice(0, 3900) + '\n\n<i>(truncated)</i>';
    }

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: mainMenu() });
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${escapeHtml(err.message)}`, { reply_markup: mainMenu() });
  }
});

bot.callbackQuery('acc:login', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    '📥 <b>Login with Session</b>\n\n' +
      'Send me your <b>GramJS session string</b> as a text message.\n\n' +
      '⚠️ It will be deleted immediately after saving.',
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('acc:logout', async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await gm.disconnect(uid);
  await deleteSession(uid);
  await ctx.editMessageText(
    '✅ Logged out and session removed.',
    { reply_markup: mainMenu() }
  );
});

// ─────────────────────────────────────────────────────────
//  Commands
// ─────────────────────────────────────────────────────────
bot.command('login', async (ctx) => {
  await ctx.reply(
    '📥 Send me your <b>GramJS session string</b> as a text message.\n\n' +
      '⚠️ It will be deleted immediately after saving.',
    { parse_mode: 'HTML' }
  );
});

bot.command('me', async (ctx) => {
  const uid = ctx.from.id;
  if (!gm.isConnected(uid)) return ctx.reply('⚠️ Not connected. Use /login.');
  try {
    const me = await gm.getMe(uid);
    const phone = me.phone ? `+${me.phone}` : '—';
    const username = me.username ? `@${me.username}` : '—';
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || '—';
    await ctx.reply(
      '📱 <b>My Account</b>\n\n' +
        `👤 Name: <b>${escapeHtml(name)}</b>\n` +
        `🆔 ID: <code>${me.id}</code>\n` +
        `🔗 Username: ${escapeHtml(username)}\n` +
        `📞 Phone: <code>${escapeHtml(phone)}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

bot.command('groups', async (ctx) => {
  const uid = ctx.from.id;
  if (!gm.isConnected(uid)) return ctx.reply('⚠️ Not connected. Use /login.');
  try {
    const dialogs = await gm.getDialogs(uid);
    const total = dialogs.filter((d) => d.isGroup || d.isChannel).length;
    await ctx.reply(`📊 You are in <b>${total}</b> groups and channels.`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

bot.command('logout', async (ctx) => {
  const uid = ctx.from.id;
  await gm.disconnect(uid);
  await deleteSession(uid);
  await ctx.reply('✅ Logged out and session removed.');
});

bot.command('status', async (ctx) => {
  const uid = ctx.from.id;
  await ctx.reply(
    `Status: ${gm.isConnected(uid) ? '🟢 Connected' : '🔴 Not connected'}`,
    { reply_markup: mainMenu() }
  );
});

// ─────────────────────────────────────────────────────────
//  Sudo management (OWNER only)
// ─────────────────────────────────────────────────────────
bot.command('addsudo', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (!args[0]) {
    return ctx.reply(
      '📝 <b>Usage:</b> <code>/addsudo &lt;user_id&gt;</code>\n\n' +
        'Get the user ID from @userinfobot and paste it here.',
      { parse_mode: 'HTML' }
    );
  }
  const target = Number(args[0]);
  if (!Number.isSafeInteger(target)) {
    return ctx.reply('❌ Invalid user ID. Must be a number.');
  }
  if (target === OWNER_ID) {
    return ctx.reply('ℹ️ This user is already the main owner.');
  }
  const existing = await sudoCol.findOne({ userId: target });
  if (existing) {
    return ctx.reply(`ℹ️ User <code>${target}</code> is already a sudo user.`, { parse_mode: 'HTML' });
  }
  await addSudo(target, ctx.from.id);
  await ctx.reply(
    `✅ <b>Sudo user added</b>\n\n` +
      `🆔 <code>${target}</code>\n\n` +
      `They can now use the bot with their own Telegram account.`,
    { parse_mode: 'HTML' }
  );
  // Notify the new sudo user (best-effort)
  try {
    await bot.api.sendMessage(
      target,
      '🎉 You have been granted access to the GramJS Account Controller bot.\n\nSend /start to begin.'
    );
  } catch {}
});

bot.command('rmsudo', async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (!args[0]) {
    return ctx.reply(
      '📝 <b>Usage:</b> <code>/rmsudo &lt;user_id&gt;</code>',
      { parse_mode: 'HTML' }
    );
  }
  const target = Number(args[0]);
  if (!Number.isSafeInteger(target)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  if (target === OWNER_ID) {
    return ctx.reply('⚠️ Cannot remove the main owner.');
  }
  const removed = await removeSudo(target);
  if (!removed) {
    return ctx.reply(`ℹ️ User <code>${target}</code> is not a sudo user.`, { parse_mode: 'HTML' });
  }
  // Also disconnect their session, if any
  await gm.disconnect(target).catch(() => {});
  await deleteSession(target);
  await ctx.reply(
    `✅ <b>Sudo user removed</b>\n\n🆔 <code>${target}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('listsudo', async (ctx) => {
  const rows = await listSudo();
  let text = '👑 <b>Sudo Users</b>\n\n';
  text += `• <code>${OWNER_ID}</code> — <b>Main Owner</b>\n`;
  if (rows.length) {
    for (const r of rows) {
      text += `• <code>${r.userId}</code>\n`;
    }
  } else {
    text += '\n<i>No additional sudo users.</i>';
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// ─────────────────────────────────────────────────────────
//  Text handler — session string input (per-user)
// ─────────────────────────────────────────────────────────
bot.on('message:text', async (ctx, next) => {
  const text = (ctx.message.text || '').trim();

  if (text.startsWith('/')) return next();

  const looksLikeSession = text.length >= 100 && /^[A-Za-z0-9+/=_-]+$/.test(text);
  if (!looksLikeSession) return next();

  const uid = ctx.from.id;

  // Delete the message from chat immediately (security)
  try { await ctx.deleteMessage(); } catch {}

  const loading = await ctx.reply('⏳ Connecting with your session...');

  try {
    const client = await gm.connect(uid, text);

    // Re-register notify so OTP works
    gm.setNotify(async (userId, msg) => {
      try { await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }); } catch {}
    });

    const me = await client.getMe();
    await saveSession(uid, text);

    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      '✅ <b>Connected successfully!</b>\n\n' +
        `👤 ${escapeHtml([me.firstName, me.lastName].filter(Boolean).join(' ') || '—')}\n` +
        `🆔 <code>${me.id}</code>\n\n` +
        'Now any <b>OTP / login alert</b> from Telegram will be forwarded here automatically.',
      { parse_mode: 'HTML', reply_markup: mainMenu() }
    );
  } catch (err) {
    await ctx.api.editMessageText(
      loading.chat.id,
      loading.message_id,
      `❌ <b>Login failed</b>\n\n${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    );
  }
});

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────
async function boot() {
  await initDb();

  // Auto-reconnect ALL saved sessions
  const allSessions = await getAllSessions();
  if (allSessions.length) {
    console.log(`🔌 Reconnecting ${allSessions.length} saved session(s)...`);
    for (const s of allSessions) {
      try {
        await gm.connect(s.userId, s.sessionString);
        console.log(`   ✅ Reconnected ${s.userId}`);
      } catch (err) {
        console.warn(`   ⚠️ Failed for ${s.userId}: ${err.message}`);
      }
    }
  }

  await bot.api.setMyCommands([
    { command: 'start', description: 'Main menu' },
    { command: 'login', description: 'Login with session string' },
    { command: 'me', description: 'Show my account info' },
    { command: 'groups', description: 'Count groups & channels' },
    { command: 'status', description: 'Connection status' },
    { command: 'logout', description: 'Disconnect session' },
    { command: 'addsudo', description: 'Add sudo user (owner only)' },
    { command: 'rmsudo', description: 'Remove sudo user (owner only)' },
    { command: 'listsudo', description: 'List sudo users (owner only)' },
  ]);

  console.log('🤖 Bot starting...');
  await bot.start({
    onStart: (me) => console.log(`✅ Bot online: @${me.username}`),
  });
}

boot().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

process.once('SIGINT', async () => {
  await bot.stop();
  await mongo.close();
  process.exit(0);
});
