// PATH: gramjs-controller/generate-session.js
// Run: node generate-session.js
// Generates a GramJS session string for YOUR account.

require('dotenv').config();
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;

if (!API_ID || !API_HASH) {
  console.error('❌ API_ID and API_HASH must be set in .env');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

(async () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   GramJS Session Generator             ║');
  console.log('╚════════════════════════════════════════╝\n');

  const client = new TelegramClient(
    new StringSession(''),
    API_ID,
    API_HASH,
    { connectionRetries: 5, useWSS: false }
  );

  await client.start({
    phoneNumber: async () => {
      const phone = await ask('📞 Enter phone (+91xxxxxxxxxx): ');
      return phone.trim();
    },
    password: async () => {
      const pass = await ask('🔐 Enter 2FA password (if enabled, else press Enter): ');
      return pass;
    },
    phoneCode: async () => {
      const code = await ask('📩 Enter OTP code: ');
      return code.trim();
    },
    onError: (err) => {
      console.error('❌ Error:', err.message);
    },
  });

  console.log('\n✅ Login successful!\n');

  const me = await client.getMe();
  console.log(`👤 Name: ${[me.firstName, me.lastName].filter(Boolean).join(' ')}`);
  console.log(`🆔 ID: ${me.id}`);
  console.log(`🔗 Username: ${me.username ? '@' + me.username : '—'}\n`);

  const sessionString = client.session.save();

  console.log('══════════════ SESSION STRING (copy the whole thing) ══════════════');
  console.log(sessionString);
  console.log('════════════════════════════════════════════════════════════════════\n');
  console.log('⚠️ Keep this SECRET. Anyone with it can access your account.');

  await client.disconnect();
  rl.close();
  process.exit(0);
})().catch((err) => {
  console.error('Fatal:', err);
  rl.close();
  process.exit(1);
});
