// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const { loadState, saveState, getDefaultState } = require('./state');

// ========== ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || process.env.ADMIN_CHAT_ID || '0');
const PHPSESSID = process.env.ZONESMS_PHPSESSID || '';


const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 8000);
// Auto-push is enabled: bot will fetch provider reports periodically and privately DM OTPs to the owner of each number.
let autoPushTimer = null;


if (!BOT_TOKEN) {
  console.error('Please set BOT_TOKEN in .env');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Please set ADMIN_ID (or ADMIN_CHAT_ID) in .env (your Telegram user ID).');
  process.exit(1);
}

// ========== STATE ==========
let state = loadState();
function persist() {
  saveState(state);
}

// ========== BOT ==========
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 500, autoStart: true, params: { timeout: 50 } },
  restartOnFailure: true,
});

bot.on('polling_error', (err) => {
  const msg = err.message || String(err);
  if (err.code === 'EFATAL' && msg.includes('ECONNRESET')) return;
  console.error('Polling error:', { code: err.code, message: msg, responseBody: err.response && err.response.body });
});

process.on('unhandledRejection', (err) => {
  const msg = (err && err.message) || String(err);
  if (msg.includes('read ECONNRESET')) return;
  console.error('Unhandled rejection:', err);
});

// ========== COMMON HELPERS ==========
function isAdmin(chatId) {
  return Number(chatId) === ADMIN_ID;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// digits only
function normalizeNumber(input = '') {
  return String(input).replace(/[^\d]/g, '');
}

function parseNumbersFromText(text = '') {
  return text
    .split(/\r?\n/)
    .map((l) => normalizeNumber(l.trim()))
    .filter(Boolean);
}

function ensureTeamUser(userId, name = '') {
  const key = String(userId);
  if (!state.teamUsers[key]) {
    state.teamUsers[key] = {
      name: name || `User_${key}`,
      totalPulled: 0,
      totalOtp: 0,
      otpNumbers: [],
      submittedNumbers: [],
      lastRequestAt: 0,
      lastAutoSentByNumber: {},
    };
  }
  const u = state.teamUsers[key];
  if (!Array.isArray(u.otpNumbers)) u.otpNumbers = [];
  if (!Array.isArray(u.submittedNumbers)) u.submittedNumbers = [];
  if (typeof u.totalPulled !== 'number') u.totalPulled = 0;
  if (typeof u.totalOtp !== 'number') u.totalOtp = 0;
  if (typeof u.lastRequestAt !== 'number') u.lastRequestAt = 0;
  // For older state.json files that don't have this field yet
  if (typeof u.lastAutoSentByNumber !== 'object' || !u.lastAutoSentByNumber) u.lastAutoSentByNumber = {};
  if (typeof u.name !== 'string') u.name = name || `User_${key}`;
}

function getUserName(uid, msg) {
  const key = String(uid);
  const stored = state.teamUsers?.[key]?.name;
  if (stored) return stored;
  const tgName = msg?.from?.first_name || msg?.from?.username || 'there';
  return tgName;
}


// ========== REQUEST COOLDOWN ==========
const REQUEST_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const USER_STATS_PAGE_SIZE = 10; // users per page for /user-stats
const REMOVE_USER_PAGE_SIZE = 20; // users per page for /removeuser
const CLEAR_SINGLE_STATS_PAGE_SIZE = 20; // users per page for /clear_single_stats

function getCooldownRemainingMs(uid) {
  const key = String(uid);
  const last = state.teamUsers?.[key]?.lastRequestAt || 0;
  const diff = Date.now() - Number(last || 0);
  if (!last || diff >= REQUEST_COOLDOWN_MS) return 0;
  return REQUEST_COOLDOWN_MS - diff;
}

function formatCooldown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  // matches your requested style: 00:00 hh:mm
  return `00:00 ${hh}:${mm}`;
}

// Remaining = assignedNumbers - used(otpNumbers)
function getUnusedAssignedNumbers(uid) {
  const key = String(uid);
  const assigned = Array.isArray(state.assignedNumbers[key]) ? state.assignedNumbers[key] : [];
  const usedSet = new Set((state.teamUsers?.[key]?.otpNumbers || []).map(normalizeNumber));
  return assigned.filter((n) => !usedSet.has(normalizeNumber(n)));
}

function getRemainingUnusedCount(uid) {
  return getUnusedAssignedNumbers(uid).length;
}

// Remaining to finish = assignedNumbers - submittedNumbers (unique)
function getRemainingToSubmitCount(uid) {
  const key = String(uid);
  const assigned = Array.isArray(state.assignedNumbers[key]) ? state.assignedNumbers[key] : [];
  const assignedSet = new Set(assigned.map(normalizeNumber));
  const submittedSet = new Set((state.teamUsers?.[key]?.submittedNumbers || []).map(normalizeNumber));
  let remaining = 0;
  for (const n of assignedSet) {
    if (!submittedSet.has(n)) remaining++;
  }
  return remaining;
}

// ========== PROVIDER (ZoneSMS) ==========
const ZONESMS_REPORT_URL = 'http://zonesms.net/client/ajax/dt_reports.php';
let sessionExpiredNotified = false;

function getLast3DaysRange() {
  const to = moment();
  const from = moment().subtract(3, 'days');
  return { from: from.format('YYYY-MM-DD HH:mm:ss'), to: to.format('YYYY-MM-DD HH:mm:ss') };
}

async function notifySessionExpired() {
  const text =
    '⚠️ SMS provider session seems expired or logged out.\n\n' +
    'Please log in again in your browser, copy the new session cookie, ' +
    'update it in `.env` and restart the bot.';
  try {
    await bot.sendMessage(ADMIN_ID, text);
  } catch (e) {
    console.error('Failed to notify admin:', e.message || e);
  }
}

async function fetchReports({ from, to, length = 100, searchNumber = '' }) {
  const params = {
    fdate1: from,
    fdate2: to,
    ftermination: '',
    fclient: '',
    fnum: searchNumber || '',
    fcli: '',
    fgdate: 0,
    fgtermination: 0,
    fgclient: 0,
    fgnumber: 0,
    fgcli: 0,
    fg: 0,
    sEcho: 1,
    iColumns: 11,
    sColumns: ',,,,,,,,,,',
    iDisplayStart: 0,
    iDisplayLength: length,
    mDataProp_0: 0,
    mDataProp_1: 1,
    mDataProp_2: 2,
    mDataProp_3: 3,
    mDataProp_4: 4,
    mDataProp_5: 5,
    mDataProp_6: 6,
    mDataProp_7: 7,
    mDataProp_8: 8,
    mDataProp_9: 9,
    mDataProp_10: 10,
    sSearch: '',
    bRegex: false,
    iSortCol_0: 0,
    sSortDir_0: 'desc',
    iSortingCols: 1,
    _: Date.now(),
  };

  try {
    const res = await axios.get(ZONESMS_REPORT_URL, {
      params,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `PHPSESSID=${PHPSESSID}`,
        Referer: 'http://zonesms.net/client/Reports',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    if (typeof res.data === 'string') {
      const html = res.data;
      if (html.includes('Member Login') || html.includes('g-recaptcha') || html.includes('Zone SMS | Login')) {
        console.warn('Provider session seems expired (got login HTML).');
        if (!sessionExpiredNotified) {
          sessionExpiredNotified = true;
          await notifySessionExpired();
        }
        return [];
      }
      console.warn('Unexpected non-JSON response from provider.');
      return [];
    }

    const data = res.data;
    const rows = data.aaData || data.data || [];
    if (!Array.isArray(rows)) return [];

    sessionExpiredNotified = false;
    return rows;
  } catch (err) {
    console.error('fetchReports error:', err.message || err);
    return [];
  }
}

function extractOtp(message) {
  if (!message || typeof message !== 'string') return null;
  const nPattern = message.match(/n\/(\d{5})/i);
  if (nPattern) return nPattern[1];
  const softStandalone = message.match(/(^|[^0-9])(\d{5})(?!\d)/);
  if (softStandalone) return softStandalone[2];
  const anyFive = message.match(/\d{5}/);
  return anyFive ? anyFive[0] : null;
}

function formatOtpMessage({ otp, number, message }) {
  const cleanNumber = normalizeNumber(number);
  const safeOtp = escapeHtml(otp);
  const safeMsg = escapeHtml(message);
  const safeNum = escapeHtml(cleanNumber);

  return [
    '🆕 New OTP received -',
    '',
    `OTP: <code>${safeOtp}</code>`,
    '',
    `Message: ${safeMsg}`,
    '',
    `Number: <a href="tel:+${safeNum}">+${safeNum}</a>`,
    '',
    'Develop by <a href="https://t.me/glmsarwar">GSARWAR</a>',
  ].join('\n');
}

async function findLatestOtpForNumber(rawNumber) {
  const number = normalizeNumber(rawNumber);
  const { from, to } = getLast3DaysRange();

  const rows = await fetchReports({ from, to, length: 200, searchNumber: number });
  if (!rows.length) return null;

  let best = null;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 11) continue;

    const dateStr = row[0] || '';
    const numRaw = row[2];
    const msg = row[10];

    if (!numRaw || !msg) continue;

    const numDigits = normalizeNumber(numRaw);
    if (!numDigits) continue;

    if (!numDigits.endsWith(number) && !number.endsWith(numDigits)) continue;

    const otp = extractOtp(msg);
    if (!otp) continue;

    if (!best || dateStr > best.date) best = { date: dateStr, number: String(numRaw), message: msg, otp };
  }

  if (best) return best;

  // fallback: latest message (even if no otp)
  let fallback = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 11) continue;
    const dateStr = row[0] || '';
    const numRaw = row[2];
    const msg = row[10];
    if (!numRaw || !msg) continue;
    if (!fallback || dateStr > fallback.date) fallback = { date: dateStr, number: String(numRaw), message: msg, otp: null };
  }
  return fallback;
}



// ========== AUTO PUSH OTP (PRIVATE TO OWNER) ==========
function otpSignatureFromRow(parsed) {
  // signature to avoid pushing the same OTP repeatedly
  return `${parsed.otp || ''}|${parsed.date || ''}|${String(parsed.message || '').slice(0, 60)}`;
}

function parseProviderRow(row) {
  // ZoneSMS DataTables row format used in findLatestOtpForNumber:
  // [0]=date, [2]=number, [10]=message
  if (!Array.isArray(row) || row.length < 11) return null;
  const dateStr = row[0] || '';
  const numRaw = row[2] || '';
  const msg = row[10] || '';
  const numDigits = normalizeNumber(numRaw);
  if (!numDigits || !msg) return null;
  const otp = extractOtp(msg);
  if (!otp) return null;
  return { date: String(dateStr), numberRaw: String(numRaw), numberDigits: numDigits, message: String(msg), otp: String(otp) };
}

async function buildLatestOtpMapLast3Days() {
  const { from, to } = getLast3DaysRange();
  // Fetch a recent window of reports once, then map -> latest OTP per number.
  // Increase length if you expect many reports; keep reasonable to avoid provider overload.
  const rows = await fetchReports({ from, to, length: 1000, searchNumber: '' });
  const map = new Map(); // numberDigits -> parsed
  for (const row of rows) {
    const parsed = parseProviderRow(row);
    if (!parsed) continue;
    const existing = map.get(parsed.numberDigits);
    if (!existing || parsed.date > existing.date) map.set(parsed.numberDigits, parsed);
  }
  return map;
}

async function autoPushTick() {
  try {
    const latestMap = await buildLatestOtpMapLast3Days();
    if (!latestMap.size) return;

    let changed = false;

    // For each user, check their assigned numbers and:
    // 1) update OTP counting based on arrivals
    // 2) send OTP to the owner privately (DM) if not sent yet
    for (const uid of Object.keys(state.assignedNumbers || {})) {
      if (!state.teamUsers[uid]) continue;
      ensureTeamUser(uid);

      const userInfo = state.teamUsers[uid];
      const assigned = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
      if (!assigned.length) continue;

      for (const rawNum of assigned) {
        const n = normalizeNumber(rawNum);
        if (!n) continue;

        const parsed = latestMap.get(n);
        if (!parsed) continue;

        // Count OTP based on actual OTP arrival from assigned numbers
        if (!userInfo.otpNumbers.includes(n)) {
          userInfo.otpNumbers.push(n);
          userInfo.totalOtp = (userInfo.totalOtp || 0) + 1;
          changed = true;
        }

        // Auto-push only to owner (private chat with the bot)
        const sig = otpSignatureFromRow(parsed);
        if (userInfo.lastAutoSentByNumber[n] !== sig) {
          userInfo.lastAutoSentByNumber[n] = sig;
          changed = true;

          const reply = formatOtpMessage({
            otp: parsed.otp,
            number: parsed.numberRaw || n,
            message: parsed.message,
          });

          // NOTE: This delivers the message in the user's private chat with THIS bot.
          bot.sendMessage(Number(uid), reply, { parse_mode: 'HTML', disable_web_page_preview: true })
            .catch(() => {
              // If user hasn't started the bot yet, Telegram will block the DM.
              // We silently ignore to avoid spam.
            });
        }
      }
    }

    if (changed) persist();
  } catch (err) {
    console.error('autoPushTick error:', err.message || err);
  }
}

function startAutoPush() {
  if (autoPushTimer) clearInterval(autoPushTimer);
  autoPushTimer = setInterval(autoPushTick, WATCH_INTERVAL_MS);
  console.log(`Auto-push enabled: checking OTPs every ${WATCH_INTERVAL_MS}ms`);
}

// Start auto-push immediately
startAutoPush();

// ========== BOT-SPECIFIC SESSIONS ==========
const addNumberSessions = new Map(); // admin_chat_id -> { numbers: Set<string> }
const addUserSessions = new Map();   // admin_chat_id -> true

// ========== PUBLIC COMMANDS ==========
bot.onText(/\/start\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  const name = getUserName(uid, msg);
  bot.sendMessage(chatId, `👋 Welcome ${escapeHtml(name)} to GS Power Bot.`, { parse_mode: 'HTML' });
});

bot.onText(/\/about\b/i, (msg) => {
  const chatId = msg.chat.id;
  const lines = ['🤖 <b>GS Power Bot</b>', 'OTP helper for assigned numbers.', 'Developer: <b>GSARWAR</b>'];
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/whoami\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const name = (`${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim()) || msg.from?.username || 'Unknown';
  const text =
    `👤 Your Telegram ID: <code>${uid}</code>\n` +
    `Name: <b>${escapeHtml(name)}</b>\n` +
    (isAdmin(uid) ? '\nYou are <b>ADMIN</b> of this bot.' : '');
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/\/history\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);

  if (!state.teamUsers[uid]) {
    return bot.sendMessage(chatId, '❌ You are not registered in the team.\nAsk admin to add you first.');
  }

  const info = state.teamUsers[uid];
  const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
  const unused = getUnusedAssignedNumbers(uid);

  const text =
    `📊 <b>Your History</b>\n\n` +
    `Name: <b>${escapeHtml(info.name || 'N/A')}</b>\n` +
    `Pulled numbers (approved): <b>${info.totalPulled || 0}</b>\n` +
    `Unique OTP numbers: <b>${info.totalOtp || 0}</b>\n` +
    `Currently assigned: <b>${assignedAll.length}</b>\n` +
    `Remaining (to submit): <b>${getRemainingToSubmitCount(uid)}</b>\n` +
    `Remaining (unused/no OTP yet): <b>${unused.length}</b>`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// /number_request (and /request alias)
function openRequestMenu(chatId, uid) {
  if (!isAdmin(chatId) && !state.teamUsers[uid]) {
    return bot.sendMessage(chatId, '❌ You are not registered.\nPlease contact admin to be added before requesting numbers.');
  }

  // Cooldown: user can request again only after 30 minutes from previous request
  if (!isAdmin(chatId)) {
    const cd = getCooldownRemainingMs(uid);
    if (cd > 0) {
      return bot.sendMessage(chatId, `⏳ You can send request after <b>${formatCooldown(cd)}</b>`, { parse_mode: 'HTML' });
    }
  }


  const pending = state.pullRequests.find((r) => r.userId === uid && r.status === 'pending');
  if (pending) {
    return bot.sendMessage(
      chatId,
      `⏳ You already have a pending request (#${pending.id}) for <b>${pending.amount}</b> numbers.\nUse /cancel to cancel it.`,
      { parse_mode: 'HTML' }
    );
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '10', callback_data: 'req:10' }, { text: '20 (auto)', callback_data: 'req:20' }],
        [{ text: '50', callback_data: 'req:50' }, { text: '100', callback_data: 'req:100' }],
        [{ text: '500', callback_data: 'req:500' }, { text: '1000', callback_data: 'req:1000' }, { text: '2000', callback_data: 'req:2000' }],
      ],
    },
  };

  bot.sendMessage(chatId, '📥 Select how many numbers you want to pull:', keyboard);
}

bot.onText(/\/number_request\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  openRequestMenu(chatId, uid);
});

bot.onText(/\/request\b/i, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'ℹ️ Renamed: use /number_request.');
  const uid = String(msg.from.id);
  openRequestMenu(chatId, uid);
});

bot.onText(/\/cancel\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);

  // admin sessions
  if (isAdmin(chatId) && addNumberSessions.has(chatId)) {
    addNumberSessions.delete(chatId);
    return bot.sendMessage(chatId, '❌ /addnumber session cancelled. No new numbers were saved.');
  }
  if (isAdmin(chatId) && addUserSessions.has(chatId)) {
    addUserSessions.delete(chatId);
    return bot.sendMessage(chatId, '❌ /adduser session cancelled.');
  }

  // cancel pending request
  const req = state.pullRequests.find((r) => r.userId === uid && r.status === 'pending');
  if (!req) return bot.sendMessage(chatId, 'ℹ️ You have no pending pull request to cancel.');

  req.status = 'cancelled';
  persist();
  bot.sendMessage(chatId, `✅ Your request for <b>${req.amount}</b> numbers has been cancelled.`, { parse_mode: 'HTML' });
});

// ========== ADMIN PANEL (hidden commands) ==========
bot.onText(/\/admin\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ You are not authorized to access the admin panel.');

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: '👤 /adduser' }, { text: '🗑️ /removeuser' }],
        [{ text: '➕ /addnumber' }, { text: '📊 /stats' }],
        [{ text: '👥 /user_stats' }, { text: '🧹 /erasenumbers' }],
        [{ text: '🧽 /clearuser_stats' }, { text: '🧼 /clear_single_stats' }],
        [{ text: '♻️ /reset' }, { text: '❌ Close' }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };

  bot.sendMessage(chatId, '🛠️ <b>Admin Panel</b>', { parse_mode: 'HTML', ...keyboard });
});

bot.onText(/^❌\s*Close\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  bot.sendMessage(chatId, '✅ Admin panel closed.', { reply_markup: { remove_keyboard: true } });
});

// ========== ADMIN COMMANDS ==========
bot.onText(/\/adduser\b(?:\s+(.+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /adduser.');

  const args = (match[1] || '').trim();

  if (args) {
    const parts = args.split(/\s+/);
    const idPart = parts.shift();
    const userId = Number(idPart);
    const name = parts.join(' ') || `User_${idPart}`;

    if (!userId || isNaN(userId)) {
      return bot.sendMessage(
        chatId,
        '❌ Invalid Telegram ID. Example:\n<code>/adduser 6085016532 Mr X</code>',
        { parse_mode: 'HTML' }
      );
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();

    return bot.sendMessage(
      chatId,
      `✅ Added/updated team user:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`,
      { parse_mode: 'HTML' }
    );
  }

  addUserSessions.set(chatId, true);
  bot.sendMessage(
    chatId,
    '👥 <b>Add User Mode</b>\n\nSend:\n<code>&lt;telegram_id&gt; &lt;name&gt;</code>\nExample:\n<code>6085016532 Mr X</code>\n\nUse /cancel to exit.',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/removeuser\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /removeuser.');

  const entries = Object.entries(state.teamUsers)
    .sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));

  if (!entries.length) return bot.sendMessage(chatId, 'No team users found.');

  const pageSize = REMOVE_USER_PAGE_SIZE || 20;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const rows = slice.map(([uid, info]) => ([
    { text: `${info.name || 'User'} (ID: ${uid})`, callback_data: `removeUser:${uid}` }
  ]));

  const nav = [];
  if (page > 1) nav.push({ text: '⬅ Prev', callback_data: `removeUserPage:${page - 1}` });
  if (page < totalPages) nav.push({ text: 'Next ➡', callback_data: `removeUserPage:${page + 1}` });
  if (nav.length) rows.push(nav);

  bot.sendMessage(chatId, `🗑️ Select a user to remove (Page ${page}/${totalPages}):`, {
    reply_markup: { inline_keyboard: rows },
  });
});

// new: clear single user stats (admin)
bot.onText(/\/clear_single_stats\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /clear_single_stats.');

  const entries = Object.entries(state.teamUsers)
    .sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));

  if (!entries.length) return bot.sendMessage(chatId, 'No team users found.');

  const pageSize = REMOVE_USER_PAGE_SIZE || 20; // reuse 20/page for lists
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const rows = slice.map(([uid, info]) => ([
    { text: `🧼 ${info.name || 'User'} (ID: ${uid})`, callback_data: `clearSingle:${uid}` }
  ]));

  const nav = [];
  if (page > 1) nav.push({ text: '⬅ Prev', callback_data: `clearSinglePage:${page - 1}` });
  if (page < totalPages) nav.push({ text: 'Next ➡', callback_data: `clearSinglePage:${page + 1}` });
  if (nav.length) rows.push(nav);

  bot.sendMessage(chatId, `🧼 Select a user to clear stats (Page ${page}/${totalPages}):`, {
    reply_markup: { inline_keyboard: rows },
  });
});

bot.onText(/\/addnumber\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /addnumber.');

  addNumberSessions.set(chatId, { numbers: new Set() });

  bot.sendMessage(
    chatId,
    '➕ <b>Add Numbers Mode</b>\n\nSend numbers (one per line). You can send multiple messages.\nWhen finished: <b>/done</b>\nCancel: <b>/cancel</b>',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/done\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /done.');

  const session = addNumberSessions.get(chatId);
  if (!session) return bot.sendMessage(chatId, 'ℹ️ No active /addnumber session.');

  const newNumbers = Array.from(session.numbers).map(normalizeNumber).filter(Boolean);

  // Deduplicate vs existing pool and assignments (normalized)
  const used = new Set(state.availableNumbers.map(normalizeNumber));
  for (const arr of Object.values(state.assignedNumbers)) {
    if (Array.isArray(arr)) for (const n of arr) used.add(normalizeNumber(n));
  }

  const toAdd = [];
  for (const n of newNumbers) {
    if (!used.has(n)) {
      used.add(n);
      toAdd.push(n);
    }
  }

  state.availableNumbers.push(...toAdd);
  persist();
  addNumberSessions.delete(chatId);

  bot.sendMessage(
    chatId,
    `✅ Added <b>${toAdd.length}</b> numbers.\n📦 Available pool: <b>${state.availableNumbers.length}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /stats.');

  const totalAvailable = state.availableNumbers.length;

  let totalAssigned = 0;
  for (const arr of Object.values(state.assignedNumbers)) if (Array.isArray(arr)) totalAssigned += arr.length;

  let totalOtps = 0;
  for (const u of Object.values(state.teamUsers)) totalOtps += Number(u?.totalOtp || 0);

  const lines = [
    '📊 <b>Global Stats</b>',
    '',
    `📦 Available numbers: <b>${totalAvailable}</b>`,
    `📤 Assigned numbers (total): <b>${totalAssigned}</b>`,
    `🔐 Total OTPs (unique per number): <b>${totalOtps}</b>`,
  ];

  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/user[-_]?stats\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /user_stats.');

  const entries = Object.entries(state.teamUsers)
    .sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));

  if (!entries.length) return bot.sendMessage(chatId, 'No team users registered yet.');

  const pageSize = USER_STATS_PAGE_SIZE || 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const lines = [`📊 <b>User Stats</b> (Page ${page}/${totalPages})`, ''];

  for (const [uid, info] of slice) {
    const name = info.name || `User_${uid}`;
    const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
    const unused = getUnusedAssignedNumbers(uid);

    lines.push(
      `ID: <code>${uid}</code> | <b>${escapeHtml(name)}</b>\n` +
        `Pulled: <b>${info.totalPulled || 0}</b> | OTPs: <b>${info.totalOtp || 0}</b>\n` +
        `Assigned: <b>${assignedAll.length}</b> | Unused: <b>${unused.length}</b>\n`
    );
  }

  const nav = [];
  if (page > 1) nav.push({ text: '⬅ Prev', callback_data: `userStatsPage:${page - 1}` });
  if (page < totalPages) nav.push({ text: 'Next ➡', callback_data: `userStatsPage:${page + 1}` });

  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
  });
});

bot.onText(/\/erasenumbers\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /erasenumbers.');
  const before = state.availableNumbers.length;
  state.availableNumbers = [];
  persist();
  bot.sendMessage(chatId, `🧹 Erased all available numbers.\nPrevious available count: <b>${before}</b>.`, { parse_mode: 'HTML' });
});

// clear all users' stats (admin) but keep allowed user list
bot.onText(/\/clearuser_stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /clearuser_stats.');

  // Return ONLY unused assigned numbers back to pool
  for (const uid of Object.keys(state.teamUsers)) {
    const unused = getUnusedAssignedNumbers(uid);
    if (unused.length) state.availableNumbers.push(...unused);
  }

  // Deduplicate pool
  const seen = new Set();
  state.availableNumbers = state.availableNumbers
    .map(normalizeNumber)
    .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

  // Clear assignments & requests
  state.assignedNumbers = {};
  state.pullRequests = [];
  state.nextRequestId = 1;

  // Reset per-user stats
  for (const uid of Object.keys(state.teamUsers)) {
    ensureTeamUser(uid);
    state.teamUsers[uid].totalPulled = 0;
    state.teamUsers[uid].totalOtp = 0;
    state.teamUsers[uid].otpNumbers = [];
    state.teamUsers[uid].submittedNumbers = [];
  }

  persist();
  bot.sendMessage(chatId, '✅ All user stats cleared.\nUnused assignments returned to the pool.\nUsers must request again.');
});

// reset bot data but keep allowed users
bot.onText(/\/reset\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Only admin can use /reset.');

  const keptUsers = state.teamUsers || {};
  state = getDefaultState();
  state.teamUsers = keptUsers;

  // reset per-user stats
  for (const uid of Object.keys(state.teamUsers)) {
    ensureTeamUser(uid);
    state.teamUsers[uid].totalPulled = 0;
    state.teamUsers[uid].totalOtp = 0;
    state.teamUsers[uid].otpNumbers = [];
    state.teamUsers[uid].submittedNumbers = [];
  }

  persist();
  bot.sendMessage(chatId, '♻️ Bot data reset completed.\n✅ Allowed user list is kept.');
});

// ========== CALLBACK QUERIES ==========
bot.on('callback_query', async (query) => {
  const { data } = query;
  const fromId = query.from.id;
  const uid = String(fromId);
  const msgId = query.message?.message_id;
  const chatId = query.message?.chat.id;

  if (!data || !chatId) return;

  
  // pagination buttons (inline)
  if (data.startsWith('removeUserPage:')) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: 'Admin only', show_alert: true });
    const page = Number(data.split(':')[1] || '1') || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
    const pageSize = REMOVE_USER_PAGE_SIZE || 20;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const rows = slice.map(([u, info]) => ([
      { text: `${info.name || 'User'} (ID: ${u})`, callback_data: `removeUser:${u}` }
    ]));

    const nav = [];
    if (p > 1) nav.push({ text: '⬅ Prev', callback_data: `removeUserPage:${p - 1}` });
    if (p < totalPages) nav.push({ text: 'Next ➡', callback_data: `removeUserPage:${p + 1}` });
    if (nav.length) rows.push(nav);

    await bot.editMessageText(`🗑️ Select a user to remove (Page ${p}/${totalPages}):`, {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('clearSinglePage:')) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: 'Admin only', show_alert: true });
    const page = Number(data.split(':')[1] || '1') || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
    const pageSize = REMOVE_USER_PAGE_SIZE || 20;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const rows = slice.map(([u, info]) => ([
      { text: `🧼 ${info.name || 'User'} (ID: ${u})`, callback_data: `clearSingle:${u}` }
    ]));

    const nav = [];
    if (p > 1) nav.push({ text: '⬅ Prev', callback_data: `clearSinglePage:${p - 1}` });
    if (p < totalPages) nav.push({ text: 'Next ➡', callback_data: `clearSinglePage:${p + 1}` });
    if (nav.length) rows.push(nav);

    await bot.editMessageText(`🧼 Select a user to clear stats (Page ${p}/${totalPages}):`, {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('userStatsPage:')) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: 'Admin only', show_alert: true });
    const page = Number(data.split(':')[1] || '1') || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
    const pageSize = USER_STATS_PAGE_SIZE || 10;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const lines = [`📊 <b>User Stats</b> (Page ${p}/${totalPages})`, ''];
    for (const [u, info] of slice) {
      const name = info.name || `User_${u}`;
      const assignedAll = Array.isArray(state.assignedNumbers[u]) ? state.assignedNumbers[u] : [];
      const unused = getUnusedAssignedNumbers(u);
      lines.push(
        `ID: <code>${u}</code> | <b>${escapeHtml(name)}</b>\n` +
        `Pulled: <b>${info.totalPulled || 0}</b> | OTPs: <b>${info.totalOtp || 0}</b>\n` +
        `Assigned: <b>${assignedAll.length}</b> | Unused: <b>${unused.length}</b>\n`
      );
    }

    const nav = [];
    if (p > 1) nav.push({ text: '⬅ Prev', callback_data: `userStatsPage:${p - 1}` });
    if (p < totalPages) nav.push({ text: 'Next ➡', callback_data: `userStatsPage:${p + 1}` });

    await bot.editMessageText(lines.join('\n'), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
    }).catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

// request buttons
  if (data.startsWith('req:')) {
    const amount = Number(data.split(':')[1] || '0');
    if (!amount || amount <= 0) {
      return bot.answerCallbackQuery(query.id, { text: 'Invalid amount.' });
    }

    if (!isAdmin(fromId) && !state.teamUsers[uid]) {
      return bot.answerCallbackQuery(query.id, { text: 'You are not registered. Ask admin first.', show_alert: true });
    }
    // Cooldown: user can request again only after 30 minutes from previous request
    if (!isAdmin(fromId)) {
      ensureTeamUser(uid);
      const cd = getCooldownRemainingMs(uid);
      if (cd > 0) {
        return bot.answerCallbackQuery(query.id, {
          text: `You can send request after ${formatCooldown(cd)}`,
          show_alert: true,
        });
      }
    }

    const pending = state.pullRequests.find((r) => r.userId === uid && r.status === 'pending');
    if (pending) {
      return bot.answerCallbackQuery(query.id, { text: `Pending request (#${pending.id}) exists. Use /cancel.`, show_alert: true });
    }

    const createdAt = new Date().toISOString();
    const reqId = state.nextRequestId++;

    // auto-approve ONLY for 20
    if (amount === 20) {
      ensureTeamUser(uid);
      state.teamUsers[uid].lastRequestAt = Date.now();

      const available = state.availableNumbers.length;
      const assignCount = Math.min(available, amount);

      const assigned = state.availableNumbers.splice(0, assignCount);
      state.assignedNumbers[uid] = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
      state.assignedNumbers[uid].push(...assigned);

      state.teamUsers[uid].totalPulled += assignCount;
      state.teamUsers[uid].submittedNumbers = [];

      state.pullRequests.push({ id: reqId, userId: uid, amount, status: 'approved', createdAt });
      persist();

      bot.answerCallbackQuery(query.id, { text: 'Auto-approved (20).' });

      // edit menu message
      if (chatId && msgId) {
        bot.editMessageText(
          `✅ Auto-approved request #${reqId}.\nRequested: <b>${amount}</b>\nAssigned: <b>${assignCount}</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
        ).catch(() => {});
      }

      // DM summary + numbers (copy-friendly)
      if (assignCount > 0) {
        const plainNumbers = assigned.join('\n');
        bot.sendMessage(Number(uid), `✅ Your request is auto-approved.\nRequested: <b>${amount}</b>\nAssigned: <b>${assignCount}</b>`, { parse_mode: 'HTML' }).catch(() => {});
        bot.sendMessage(Number(uid), plainNumbers).catch(() => {});
      } else {
        bot.sendMessage(Number(uid), `⚠️ Pool is empty right now. Please try later.`, { parse_mode: 'HTML' }).catch(() => {});
      }

      return;
    }

    // pending approval for >20 (or other)
    ensureTeamUser(uid);
    state.teamUsers[uid].lastRequestAt = Date.now();
    state.pullRequests.push({ id: reqId, userId: uid, amount, status: 'pending', createdAt });
    persist();

    bot.answerCallbackQuery(query.id, { text: `Request created for ${amount}.` });

    bot.editMessageText(`📥 Request created for <b>${amount}</b> numbers.\nPlease wait for admin approval.`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
    }).catch(() => {});

    const name = state.teamUsers?.[uid]?.name || query.from.username || `User_${uid}`;

    const kb = {
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Approve ${amount}`, callback_data: `approveReq:${reqId}` },
          { text: `❌ Reject`, callback_data: `rejectReq:${reqId}` },
        ]],
      },
    };

    bot.sendMessage(
      ADMIN_ID,
      `📥 <b>New pull request</b>\n\nFrom: <b>${escapeHtml(name)}</b>\nID: <code>${uid}</code>\nRequested: <b>${amount}</b> numbers.`,
      { parse_mode: 'HTML', ...kb }
    ).catch(() => {});
    return;
  }

  // approve request (admin)
  if (data.startsWith('approveReq:')) {
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Only admin can approve.', show_alert: true });
    }

    const id = Number(data.split(':')[1] || '0');
    const req = state.pullRequests.find((r) => r.id === id);
    if (!req || req.status !== 'pending') {
      return bot.answerCallbackQuery(query.id, { text: 'Request not found or already processed.', show_alert: true });
    }

    const targetUid = req.userId;

    // Enforce remaining restriction (admin approval should not bypass)
    const remaining = getRemainingToSubmitCount(targetUid);
    if (remaining > 0) {
      return bot.answerCallbackQuery(query.id, { text: `User still has ${remaining} remaining numbers.`, show_alert: true });
    }

    ensureTeamUser(targetUid);

    const available = state.availableNumbers.length;
    const requested = req.amount;
    const assignCount = Math.min(available, requested);

    const assigned = state.availableNumbers.splice(0, assignCount);
    state.assignedNumbers[targetUid] = Array.isArray(state.assignedNumbers[targetUid]) ? state.assignedNumbers[targetUid] : [];
    state.assignedNumbers[targetUid].push(...assigned);

    state.teamUsers[targetUid].totalPulled += assignCount;
    state.teamUsers[targetUid].submittedNumbers = [];
    req.status = 'approved';
    persist();

    bot.answerCallbackQuery(query.id, { text: 'Request approved.' });

    if (chatId && msgId) {
      bot.editMessageText(
        `✅ Approved request #${req.id}.\nUser: <code>${targetUid}</code>\nRequested: ${requested}\nAssigned: ${assignCount}\nRemaining in pool: ${state.availableNumbers.length}`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      ).catch(() => {});
    }

    bot.sendMessage(
      Number(targetUid),
      `✅ Your request is approved.\nRequested: <b>${requested}</b>\nAssigned: <b>${assignCount}</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    if (assignCount > 0) {
      bot.sendMessage(Number(targetUid), assigned.join('\n')).catch(() => {});
    }
    return;
  }

  // reject request (admin)
  if (data.startsWith('rejectReq:')) {
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Only admin can reject.', show_alert: true });
    }

    const id = Number(data.split(':')[1] || '0');
    const req = state.pullRequests.find((r) => r.id === id);
    if (!req || req.status !== 'pending') {
      return bot.answerCallbackQuery(query.id, { text: 'Request not found or already processed.', show_alert: true });
    }

    req.status = 'rejected';
    persist();

    bot.answerCallbackQuery(query.id, { text: 'Request rejected.' });

    if (chatId && msgId) {
      bot.editMessageText(
        `❌ Rejected request #${req.id}.\nUser: <code>${req.userId}</code>\nRequested: ${req.amount}`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      ).catch(() => {});
    }

    bot.sendMessage(Number(req.userId), `❌ Your request for <b>${req.amount}</b> numbers has been rejected.`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  // remove user (admin) - return ONLY unused numbers
  if (data.startsWith('removeUser:')) {
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Only admin can remove users.', show_alert: true });
    }

    const targetUid = data.split(':')[1];
    if (!targetUid || !state.teamUsers[targetUid]) {
      return bot.answerCallbackQuery(query.id, { text: 'User not found.', show_alert: true });
    }

    const unused = getUnusedAssignedNumbers(targetUid);
    if (unused.length) state.availableNumbers.push(...unused);

    delete state.assignedNumbers[targetUid];
    const removedInfo = state.teamUsers[targetUid];
    delete state.teamUsers[targetUid];

    // remove their pending requests too
    state.pullRequests = state.pullRequests.map((r) => (r.userId === targetUid && r.status === 'pending' ? { ...r, status: 'cancelled' } : r));

    // dedupe pool
    const seen = new Set();
    state.availableNumbers = state.availableNumbers
      .map(normalizeNumber)
      .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: 'User removed.' });

    bot.editMessageText('✅ User removed.\n♻️ Only unused numbers returned to pool.', { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot.sendMessage(
      ADMIN_ID,
      `👤 Removed user:\nID: <code>${targetUid}</code>\nName: <b>${escapeHtml(removedInfo.name || '')}</b>\nReturned unused: <b>${unused.length}</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  // clear single user stats (admin) - keep user allowed
  if (data.startsWith('clearSingle:')) {
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Only admin can do this.', show_alert: true });
    }

    const targetUid = data.split(':')[1];
    if (!targetUid || !state.teamUsers[targetUid]) {
      return bot.answerCallbackQuery(query.id, { text: 'User not found.', show_alert: true });
    }

    // return ONLY unused numbers
    const unused = getUnusedAssignedNumbers(targetUid);
    if (unused.length) state.availableNumbers.push(...unused);

    // clear assignments and stats
    delete state.assignedNumbers[targetUid];

    ensureTeamUser(targetUid);
    state.teamUsers[targetUid].totalPulled = 0;
    state.teamUsers[targetUid].totalOtp = 0;
    state.teamUsers[targetUid].otpNumbers = [];
    state.teamUsers[targetUid].submittedNumbers = [];

    // cancel any pending requests for this user
    for (const r of state.pullRequests) {
      if (r.userId === targetUid && r.status === 'pending') r.status = 'cancelled';
    }

    // dedupe pool
    const seen = new Set();
    state.availableNumbers = state.availableNumbers
      .map(normalizeNumber)
      .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: 'Cleared.' });
    bot.editMessageText(`✅ Cleared stats for user ID: ${targetUid}\nReturned unused: ${unused.length}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    return;
  }
});

// ========== MESSAGE HANDLER ==========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // ignore commands
  if (text.startsWith('/')) return;

  const uid = String(msg.from.id);

  // admin /addnumber session
  if (isAdmin(chatId) && addNumberSessions.has(chatId)) {
    const session = addNumberSessions.get(chatId);
    const numbers = parseNumbersFromText(text);
    if (!numbers.length) {
      return bot.sendMessage(chatId, 'No valid numbers found. Send again or /done.');
    }
    for (const n of numbers) session.numbers.add(n);

    return bot.sendMessage(
      chatId,
      `📥 Captured <b>${numbers.length}</b> numbers.\nSession total: <b>${session.numbers.size}</b>\nSend more or /done.`,
      { parse_mode: 'HTML' }
    );
  }

  // admin /adduser session
  if (isAdmin(chatId) && addUserSessions.has(chatId)) {
    const parts = text.split(/\s+/);
    const idPart = parts.shift();
    const userId = Number(idPart);
    const name = parts.join(' ') || `User_${idPart}`;

    if (!userId || isNaN(userId)) {
      return bot.sendMessage(chatId, '❌ Invalid Telegram ID.\nExample:\n<code>6085016532 Mr X</code>', { parse_mode: 'HTML' });
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();
    addUserSessions.delete(chatId);

    return bot.sendMessage(chatId, `✅ Added/updated:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`, { parse_mode: 'HTML' });
  }

  // OTP lookup must contain digits
  if (!/\d{5,}/.test(text)) return;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return bot.sendMessage(
      chatId,
      '⚠️ Please send only <b>one number</b> per message for OTP lookup.',
      { parse_mode: 'HTML' }
    );
  }

  const numberText = lines[0];
  const normalizedInput = normalizeNumber(numberText);
  if (!normalizedInput) return;

  // only team users or admin
  if (!isAdmin(chatId) && !state.teamUsers[uid]) {
    return bot.sendMessage(chatId, '❌ You are not registered to use OTP lookup.\nAsk admin to add you.');
  }

  // Non-admins can only query numbers assigned to them (even if already used)
  if (!isAdmin(chatId)) {
    const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
    const assignedSet = new Set(assignedAll.map(normalizeNumber));
    if (!assignedSet.has(normalizedInput)) {
      return bot.sendMessage(chatId, '❌ This number is not assigned to you.\nSubmit only numbers you pulled via this bot.');
    }
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const result = await findLatestOtpForNumber(numberText);

    if (!result) {
      return bot.sendMessage(chatId, `No OTP found for number: <code>${escapeHtml(numberText)}</code> in the last 3 days.`, { parse_mode: 'HTML' });
    }

    if (!result.otp) {
      return bot.sendMessage(
        chatId,
        `Message found for <code>${escapeHtml(numberText)}</code> but no 5-digit OTP.\n\n<pre>${escapeHtml(result.message)}</pre>`,
        { parse_mode: 'HTML' }
      );
    }

    // count OTP once per number for non-admin
    if (!isAdmin(chatId)) {
      ensureTeamUser(uid);
      const userInfo = state.teamUsers[uid];
      const key = normalizedInput;

      if (!userInfo.otpNumbers.includes(key)) {
        userInfo.otpNumbers.push(key);
        userInfo.totalOtp += 1;
        persist();
      }
    }

    const reply = formatOtpMessage({ otp: result.otp, number: result.number, message: result.message });
    return bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('Error while searching OTP:', err.message || err);
    return bot.sendMessage(chatId, 'Something went wrong while fetching OTP.');
  }
});

console.log('GS Power Bot started…');