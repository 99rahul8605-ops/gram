// PATH: gramjs-controller/src/gramjs-manager.js
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const SERVICE_ACCOUNT_ID = '777000'; // Telegram's official service account

/**
 * GramJS manager — one client per user, keeping them connected
 * and listening for OTP messages from Telegram's service account.
 */
class GramJSManager {
  constructor(apiId, apiHash) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.clients = new Map();  // userId -> { client, onMessageHandler }
    this.notifyFn = null;      // async (userId, text) => void
  }

  setNotify(fn) {
    this.notifyFn = fn;
  }

  /**
   * Connect a user's account using their session string.
   * Throws on invalid/revoked session.
   */
  async connect(userId, sessionString) {
    await this.disconnect(userId);

    const clean = String(sessionString || '').trim();
    if (!clean) throw new Error('Empty session string.');

    const client = new TelegramClient(
      new StringSession(clean),
      this.apiId,
      this.apiHash,
      { connectionRetries: 3, useWSS: false }
    );

    await client.connect();

    const authorized = await client.isUserAuthorized().catch(() => false);
    if (!authorized) {
      try { await client.disconnect(); } catch {}
      throw new Error('Session is invalid or has been revoked.');
    }

    // Listen for every new message; forward service-account messages to owner.
    const handler = async (event) => {
      try {
        const msg = event.message;
        if (!msg) return;

        const senderId =
          msg.senderId?.toString?.() ||
          msg.senderId?.userId?.toString?.() ||
          msg.fromId?.userId?.toString?.() ||
          null;

        if (senderId === SERVICE_ACCOUNT_ID) {
          const text = msg.text || msg.message || '(no text)';
          if (this.notifyFn) {
            await this.notifyFn(
              userId,
              `🔐 <b>OTP / Telegram alert received</b>\n\n<code>${escapeHtml(text)}</code>`
            );
          }
        }
      } catch (err) {
        // Never let a handler failure kill the client.
        console.error('[gramjs] handler error:', err.message);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
    this.clients.set(userId, { client, handler });
    return client;
  }

  async disconnect(userId) {
    const entry = this.clients.get(userId);
    if (!entry) return false;
    this.clients.delete(userId);
    try {
      await entry.client.disconnect();
    } catch {}
    return true;
  }

  isConnected(userId) {
    return this.clients.has(userId);
  }

  getClient(userId) {
    return this.clients.get(userId)?.client || null;
  }

  async getMe(userId) {
    const client = this.getClient(userId);
    if (!client) throw new Error('Not connected.');
    return await client.getMe();
  }

  async getDialogs(userId) {
    const client = this.getClient(userId);
    if (!client) throw new Error('Not connected.');
    return await client.getDialogs({ limit: 500 });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = GramJSManager;
