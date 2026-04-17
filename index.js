// index.js (IPRN version, same structure/logic as bot-1)
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const moment = require("moment");
const { loadState, saveState, getDefaultState } = require("./state");

// ========== ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || process.env.ADMIN_CHAT_ID || "0");

// IPRN tokens (support both styles)
const IPRN_TOKENS = [
  process.env.IPRN_TOKEN_1,
  process.env.IPRN_TOKEN_2,
  process.env.IPRN_TOKEN_3,
  process.env.TOKEN_1,
  process.env.TOKEN_2,
  process.env.TOKEN_3,
]
  .filter(Boolean)
  .map((t) => {
    const s = String(t).trim();
    if (!s) return "";
    return s.toLowerCase().startsWith("bearer ") ? s : `Bearer ${s}`;
  })
  .filter(Boolean);

const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 8000);

// Provider paging controls (IPRN)
const IPRN_PER_PAGE = Number(process.env.IPRN_PER_PAGE || 50); // bot-2 used 12; 50 reduces pages
const IPRN_MAX_PAGES = Number(process.env.IPRN_MAX_PAGES || 25);
const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT || 25000);
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || 200);

// ========== VALIDATION ==========
if (!BOT_TOKEN) {
  console.error("Please set BOT_TOKEN (or TELEGRAM_BOT_TOKEN) in .env");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("Please set ADMIN_ID (or ADMIN_CHAT_ID) in .env (your Telegram user ID).");
  process.exit(1);
}
if (!IPRN_TOKENS.length) {
  console.error("Please set IPRN_TOKEN_1 (or TOKEN_1) in .env (Bearer token for IPRN).");
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

bot.on("polling_error", (err) => {
  const msg = err.message || String(err);
  if (err.code === "EFATAL" && msg.includes("ECONNRESET")) return;
  console.error("Polling error:", {
    code: err.code,
    message: msg,
    responseBody: err.response && err.response.body,
  });
});

process.on("unhandledRejection", (err) => {
  const msg = (err && err.message) || String(err);
  if (msg.includes("read ECONNRESET")) return;
  console.error("Unhandled rejection:", err);
});

// ========== COMMON HELPERS ==========
function isAdmin(chatId) {
  return Number(chatId) === ADMIN_ID;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// digits only
function normalizeNumber(input = "") {
  return String(input).replace(/[^\d]/g, "");
}

function parseNumbersFromText(text = "") {
  return text
    .split(/\r?\n/)
    .map((l) => normalizeNumber(l.trim()))
    .filter(Boolean);
}

function ensureTeamUser(userId, name = "") {
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
  if (typeof u.totalPulled !== "number") u.totalPulled = 0;
  if (typeof u.totalOtp !== "number") u.totalOtp = 0;
  if (typeof u.lastRequestAt !== "number") u.lastRequestAt = 0;
  if (typeof u.lastAutoSentByNumber !== "object" || !u.lastAutoSentByNumber) u.lastAutoSentByNumber = {};
  if (typeof u.name !== "string") u.name = name || `User_${key}`;
}

function getUserName(uid, msg) {
  const key = String(uid);
  const stored = state.teamUsers?.[key]?.name;
  if (stored) return stored;
  const tgName = msg?.from?.first_name || msg?.from?.username || "there";
  return tgName;
}

// ========== REQUEST COOLDOWN ==========
const REQUEST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const USER_STATS_PAGE_SIZE = 10;
const REMOVE_USER_PAGE_SIZE = 20;
const CLEAR_SINGLE_STATS_PAGE_SIZE = 20;

function getCooldownRemainingMs(uid) {
  const key = String(uid);
  const last = state.teamUsers?.[key]?.lastRequestAt || 0;
  const diff = Date.now() - Number(last || 0);
  if (!last || diff >= REQUEST_COOLDOWN_MS) return 0;
  return REQUEST_COOLDOWN_MS - diff;
}

function formatCooldown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  return `00:00 ${hh}:${mm}`;
}

// Remaining = assignedNumbers - used(otpNumbers)
function getUnusedAssignedNumbers(uid) {
  const key = String(uid);
  const assigned = Array.isArray(state.assignedNumbers[key]) ? state.assignedNumbers[key] : [];
  const usedSet = new Set((state.teamUsers?.[key]?.otpNumbers || []).map(normalizeNumber));
  return assigned.filter((n) => !usedSet.has(normalizeNumber(n)));
}

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

// ========== PROVIDER (IPRN) ==========
const IPRN_URL = "https://api.iprn.pro/api/public/v1/stock/edr-account";
let iprnAuthNotified = false;

function getLastDaysRange(days = 8) {
  const to = moment();
  const from = moment().subtract(days, "days");
  return { from: from.toISOString(), to: to.toISOString() };
}

async function notifyIprnAuthIssueOnce() {
  if (iprnAuthNotified) return;
  iprnAuthNotified = true;
  const text =
    "⚠️ IPRN token seems invalid/expired (401/403).\n\n" +
    "Please update your Bearer token(s) in `.env` (IPRN_TOKEN_1/2/3) and restart the bot.";
  try {
    await bot.sendMessage(ADMIN_ID, text);
  } catch (e) {
    console.error("Failed to notify admin:", e.message || e);
  }
}

function extractOtp(message) {
  if (!message || typeof message !== "string") return null;

  // 1) Pattern "n/12345"
  const nPattern = message.match(/n\/(\d{5})/i);
  if (nPattern) return nPattern[1];

  // 2) Standalone 5 digits (not part of a longer number)
  const softStandalone = message.match(/(^|[^0-9])(\d{5})(?!\d)/);
  if (softStandalone) return softStandalone[2];

  // 3) fallback: any 5 digits
  const anyFive = message.match(/\d{5}/);
  return anyFive ? anyFive[0] : null;
}

function formatOtpMessage({ otp, number, message }) {
  const cleanNumber = normalizeNumber(number);
  const safeOtp = escapeHtml(otp);
  const safeMsg = escapeHtml(message);
  const safeNum = escapeHtml(cleanNumber);

  return [
    "🆕 New OTP received -",
    "",
    `OTP: <code>${safeOtp}</code>`,
    "",
    `Message: ${safeMsg}`,
    "",
    `Number: <a href="tel:+${safeNum}">+${safeNum}</a>`,
    "",
    'Develop by <a href="https://t.me/glmsarwar">GSARWAR</a>',
  ].join("\n");
}

// matching rule (kept from your bot-2): full match OR last-9 match
function isNumberMatch(providerDigits, targetDigits) {
  const b = normalizeNumber(providerDigits);
  const target = normalizeNumber(targetDigits);
  if (!b || !target) return false;
  if (b === target) return true;

  const endsWith9 = target.length >= 9 ? target.slice(-9) : target;
  return b.endsWith(endsWith9);
}

async function fetchIprnPage(token, page, perPage, fromIso, toIso) {
  try {
    const resp = await axios.get(IPRN_URL, {
      headers: {
        Authorization: token,
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: "https://iprn.pro/",
      },
      params: {
        type: "sms",
        stock_account: 0,
        perPage,
        page,
        sortColumn: "created_at",
        sortDirection: "desc",
        "period[0]": fromIso,
        "period[1]": toIso,
      },
      timeout: AXIOS_TIMEOUT,
    });

    const rows = resp?.data?.data;
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) await notifyIprnAuthIssueOnce();
    // return empty so caller can try next token/page safely
    return [];
  }
}

function parseProviderRowIprn(row) {
  // expected: { created_at, b_number, message, ... }
  const createdAt = String(row?.created_at || "");
  const numRaw = String(row?.b_number || "");
  const msg = String(row?.message || "");

  const numDigits = normalizeNumber(numRaw);
  if (!createdAt || !numDigits || !msg) return null;

  const otp = extractOtp(msg);
  if (!otp) return null;

  return {
    date: createdAt, // ISO string
    numberRaw: numRaw,
    numberDigits: numDigits,
    message: msg,
    otp: String(otp),
  };
}

async function findLatestOtpForNumber(rawNumber) {
  const target = normalizeNumber(rawNumber);
  if (!target) return null;

  const { from, to } = getLastDaysRange(8);
  let best = null;
  let fallback = null;

  for (const token of IPRN_TOKENS) {
    for (let page = 1; page <= Math.max(2, IPRN_MAX_PAGES); page++) {
      const rows = await fetchIprnPage(token, page, IPRN_PER_PAGE, from, to);
      if (!rows.length) break;

      for (const row of rows) {
        const createdAt = String(row?.created_at || "");
        const numRaw = String(row?.b_number || "");
        const msg = String(row?.message || "");
        const numDigits = normalizeNumber(numRaw);

        if (!createdAt || !numDigits || !msg) continue;
        if (!isNumberMatch(numDigits, target)) continue;

        const otp = extractOtp(msg);

        // track fallback = latest message (even if no otp)
        if (!fallback || createdAt > fallback.date) {
          fallback = { date: createdAt, number: numRaw, message: msg, otp: otp || null };
        }

        if (!otp) continue;
        if (!best || createdAt > best.date) {
          best = { date: createdAt, number: numRaw, message: msg, otp };
        }
      }

      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }

    // if we already found a good one with this token, no need next token
    if (best) break;
  }

  return best || fallback;
}

// ========== AUTO PUSH OTP (PRIVATE TO OWNER) ==========
function otpSignatureFromParsed(parsed) {
  return `${parsed.otp || ""}|${parsed.date || ""}|${String(parsed.message || "").slice(0, 60)}`;
}

function safeAssigned(uid) {
  const arr = state.assignedNumbers?.[uid];
  return Array.isArray(arr) ? arr : [];
}

async function autoPushTick() {
  try {
    // 1) Build number -> owner map
    const numberOwnerMap = new Map(); // number -> uid
    for (const uid in state.assignedNumbers) {
      ensureTeamUser(uid);
      for (const n of safeAssigned(uid)) {
        numberOwnerMap.set(normalizeNumber(n), String(uid));
      }
    }
    if (numberOwnerMap.size === 0) return;

    const pending = new Set(numberOwnerMap.keys());
    const latestOtpByNumber = new Map(); // numberDigits -> parsed

    const { from, to } = getLastDaysRange(8);

    // 2) Paginated fetch from IPRN
    // Try token by token; within token, page by page; stop early if pending empty
    for (const token of IPRN_TOKENS) {
      if (pending.size === 0) break;

      for (let page = 1; page <= IPRN_MAX_PAGES; page++) {
        if (pending.size === 0) break;

        const rows = await fetchIprnPage(token, page, IPRN_PER_PAGE, from, to);
        if (!rows.length) break;

        for (const row of rows) {
          const parsed = parseProviderRowIprn(row);
          if (!parsed) continue;

          // We compare using normalized assigned keys
          // Provider numberDigits may include country prefix; so we check match using last-9 rule
          // To map to the owner's "assigned number", we must find which pending number matches this provider row.
          // We'll do a quick scan (still fast because pending size is limited by assigned pool).
          let matchedAssigned = null;
          for (const assignedNum of pending) {
            if (isNumberMatch(parsed.numberDigits, assignedNum)) {
              matchedAssigned = assignedNum;
              break;
            }
          }
          if (!matchedAssigned) continue;

          const prev = latestOtpByNumber.get(matchedAssigned);
          if (!prev || parsed.date > prev.date) {
            latestOtpByNumber.set(matchedAssigned, {
              ...parsed,
              numberDigits: matchedAssigned, // normalize map key to assigned number
            });
          }
        }

        // remove found numbers
        for (const num of latestOtpByNumber.keys()) pending.delete(num);

        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    }

    let changed = false;

    // 3) Deliver + count (owner only)
    for (const [assignedNumber, parsed] of latestOtpByNumber.entries()) {
      const uid = numberOwnerMap.get(assignedNumber);
      if (!uid) continue;

      ensureTeamUser(uid);
      const user = state.teamUsers[uid];

      // count OTP once per number
      if (!user.otpNumbers.includes(assignedNumber)) {
        user.otpNumbers.push(assignedNumber);
        user.totalOtp += 1;
        changed = true;
      }

      // prevent duplicate auto-push for same OTP message
      const sig = otpSignatureFromParsed(parsed);
      if (user.lastAutoSentByNumber[assignedNumber] !== sig) {
        user.lastAutoSentByNumber[assignedNumber] = sig;

        bot
          .sendMessage(Number(uid), `🆕 OTP RECEIVED\n\nOTP: ${parsed.otp}\nNumber: ${assignedNumber}`)
          .catch(() => {});
        changed = true;
      }
    }

    if (changed) persist();
  } catch (err) {
    console.error("autoPushTick error:", err.message || err);
  }
}

let autoPushTimer = null;
function startAutoPush() {
  if (autoPushTimer) clearInterval(autoPushTimer);
  autoPushTimer = setInterval(autoPushTick, WATCH_INTERVAL_MS);
  console.log(`Auto-push enabled: checking OTPs every ${WATCH_INTERVAL_MS}ms`);
}

// Start auto-push immediately
startAutoPush();

// ========== BOT-SPECIFIC SESSIONS ==========
const addNumberSessions = new Map();
const addUserSessions = new Map();
const broadcastSessions = new Map();

// ========== PUBLIC COMMANDS ==========
bot.onText(/\/start\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  const name = getUserName(uid, msg);
  bot.sendMessage(chatId, `👋 Welcome ${escapeHtml(name)} to GS Power Bot.`, { parse_mode: "HTML" });
});

bot.onText(/\/about\b/i, (msg) => {
  const chatId = msg.chat.id;
  const lines = ["🤖 <b>GS Power Bot</b>", "OTP helper for assigned numbers.", "Developer: <b>GSARWAR</b>"];
  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
});

bot.onText(/\/whoami\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const name = (`${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim()) || msg.from?.username || "Unknown";
  const text =
    `👤 Your Telegram ID: <code>${uid}</code>\n` +
    `Name: <b>${escapeHtml(name)}</b>\n` +
    (isAdmin(uid) ? "\nYou are <b>ADMIN</b> of this bot." : "");
  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
});

bot.onText(/\/history\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);

  if (!state.teamUsers[uid]) {
    return bot.sendMessage(chatId, "❌ You are not registered in the team.\nAsk admin to add you first.");
  }

  const info = state.teamUsers[uid];
  const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
  const unused = getUnusedAssignedNumbers(uid);

  const text =
    `📊 <b>Your History</b>\n\n` +
    `Name: <b>${escapeHtml(info.name || "N/A")}</b>\n` +
    `Pulled numbers (approved): <b>${info.totalPulled || 0}</b>\n` +
    `Unique OTP numbers: <b>${info.totalOtp || 0}</b>\n` +
    `Currently assigned: <b>${assignedAll.length}</b>\n` +
    `Remaining (to submit): <b>${getRemainingToSubmitCount(uid)}</b>\n` +
    `Remaining (unused/no OTP yet): <b>${unused.length}</b>`;

  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
});

// /number_request (and /request alias)
function openRequestMenu(chatId, uid) {
  if (!isAdmin(chatId) && !state.teamUsers[uid]) {
    return bot.sendMessage(chatId, "❌ You are not registered.\nPlease contact admin to be added before requesting numbers.");
  }

  // Cooldown
  if (!isAdmin(chatId)) {
    const cd = getCooldownRemainingMs(uid);
    if (cd > 0) {
      return bot.sendMessage(chatId, `⏳ You can send request after <b>${formatCooldown(cd)}</b>`, { parse_mode: "HTML" });
    }
  }

  const pending = state.pullRequests.find((r) => r.userId === uid && r.status === "pending");
  if (pending) {
    return bot.sendMessage(
      chatId,
      `⏳ You already have a pending request (#${pending.id}) for <b>${pending.amount}</b> numbers.\nUse /cancel to cancel it.`,
      { parse_mode: "HTML" }
    );
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "10", callback_data: "req:10" }, { text: "20 (auto)", callback_data: "req:20" }],
        [{ text: "50", callback_data: "req:50" }, { text: "100", callback_data: "req:100" }],
        [
          { text: "500", callback_data: "req:500" },
          { text: "1000", callback_data: "req:1000" },
          { text: "2000", callback_data: "req:2000" },
        ],
      ],
    },
  };

  bot.sendMessage(chatId, "📥 Select how many numbers you want to pull:", keyboard);
}

bot.onText(/\/number_request\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  openRequestMenu(chatId, uid);
});

bot.onText(/\/request\b/i, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "ℹ️ Renamed: use /number_request.");
  const uid = String(msg.from.id);
  openRequestMenu(chatId, uid);
});

bot.onText(/\/cancel\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);

  // admin sessions
  if (isAdmin(chatId) && addNumberSessions.has(chatId)) {
    addNumberSessions.delete(chatId);
    return bot.sendMessage(chatId, "❌ /addnumber session cancelled. No new numbers were saved.");
  }
  if (isAdmin(chatId) && addUserSessions.has(chatId)) {
    addUserSessions.delete(chatId);
    return bot.sendMessage(chatId, "❌ /adduser session cancelled.");
  }
  if (isAdmin(chatId) && broadcastSessions.has(chatId)) {
    broadcastSessions.delete(chatId);
    return bot.sendMessage(chatId, "❌ Broadcast cancelled.");
  }

  // cancel pending request
  const req = state.pullRequests.find((r) => r.userId === uid && r.status === "pending");
  if (!req) return bot.sendMessage(chatId, "ℹ️ You have no pending pull request to cancel.");

  req.status = "cancelled";
  persist();
  bot.sendMessage(chatId, `✅ Your request for <b>${req.amount}</b> numbers has been cancelled.`, { parse_mode: "HTML" });
});

// ========== ADMIN PANEL (hidden commands) ==========
bot.onText(/\/admin\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ You are not authorized to access the admin panel.");

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "👤 /adduser" }, { text: "🗑️ /removeuser" }],
        [{ text: "➕ /addnumber" }, { text: "📊 /stats" }],
        [{ text: "📢 /broadcast" }, { text: "👥 /user_stats" }],
        [{ text: "🧹 /erasenumbers" }, { text: "🧽 /clearuser_stats" }],
        [{ text: "🧼 /clear_single_stats" }, { text: "♻️ /reset" }],
        [{ text: "❌ Close" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };

  bot.sendMessage(chatId, "🛠️ <b>Admin Panel</b>", { parse_mode: "HTML", ...keyboard });
});

bot.onText(/^❌\s*Close\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  bot.sendMessage(chatId, "✅ Admin panel closed.", { reply_markup: { remove_keyboard: true } });
});

// ========== ADMIN COMMANDS ==========
bot.onText(/\/adduser\b(?:\s+(.+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /adduser.");

  const args = (match[1] || "").trim();

  if (args) {
    const parts = args.split(/\s+/);
    const idPart = parts.shift();
    const userId = Number(idPart);
    const name = parts.join(" ") || `User_${idPart}`;

    if (!userId || isNaN(userId)) {
      return bot.sendMessage(chatId, "❌ Invalid Telegram ID. Example:\n<code>/adduser 6085016532 Mr X</code>", {
        parse_mode: "HTML",
      });
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();

    return bot.sendMessage(chatId, `✅ Added/updated team user:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`, {
      parse_mode: "HTML",
    });
  }

  addUserSessions.set(chatId, true);
  bot.sendMessage(
    chatId,
    "👥 <b>Add User Mode</b>\n\nSend:\n<code>&lt;telegram_id&gt; &lt;name&gt;</code>\nExample:\n<code>6085016532 Mr X</code>\n\nUse /cancel to exit.",
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/removeuser\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /removeuser.");

  const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
  if (!entries.length) return bot.sendMessage(chatId, "No team users found.");

  const pageSize = REMOVE_USER_PAGE_SIZE || 20;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const rows = slice.map(([uid, info]) => [
    { text: `${info.name || "User"} (ID: ${uid})`, callback_data: `removeUser:${uid}` },
  ]);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `removeUserPage:${page - 1}` });
  if (page < totalPages) nav.push({ text: "Next ➡", callback_data: `removeUserPage:${page + 1}` });
  if (nav.length) rows.push(nav);

  bot.sendMessage(chatId, `🗑️ Select a user to remove (Page ${page}/${totalPages}):`, {
    reply_markup: { inline_keyboard: rows },
  });
});

bot.onText(/\/clear_single_stats\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /clear_single_stats.");

  const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
  if (!entries.length) return bot.sendMessage(chatId, "No team users found.");

  const pageSize = CLEAR_SINGLE_STATS_PAGE_SIZE || 20;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const rows = slice.map(([uid, info]) => [
    { text: `🧼 ${info.name || "User"} (ID: ${uid})`, callback_data: `clearSingle:${uid}` },
  ]);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `clearSinglePage:${page - 1}` });
  if (page < totalPages) nav.push({ text: "Next ➡", callback_data: `clearSinglePage:${page + 1}` });
  if (nav.length) rows.push(nav);

  bot.sendMessage(chatId, `🧼 Select a user to clear stats (Page ${page}/${totalPages}):`, {
    reply_markup: { inline_keyboard: rows },
  });
});

bot.onText(/\/addnumber\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /addnumber.");

  addNumberSessions.set(chatId, { numbers: new Set() });

  bot.sendMessage(
    chatId,
    "➕ <b>Add Numbers Mode</b>\n\nSend numbers (one per line). You can send multiple messages.\nWhen finished: <b>/done</b>\nCancel: <b>/cancel</b>",
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/broadcast\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /broadcast.");
  broadcastSessions.set(chatId, true);
  bot.sendMessage(chatId, "📢 <b>Broadcast</b>\n\nSend the message you want to send to <b>all users</b>.\nCancel: <b>/cancel</b>", {
    parse_mode: "HTML",
  });
});

bot.onText(/\/done\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /done.");

  const session = addNumberSessions.get(chatId);
  if (!session) return bot.sendMessage(chatId, "ℹ️ No active /addnumber session.");

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

  bot.sendMessage(chatId, `✅ Added <b>${toAdd.length}</b> numbers.\n📦 Available pool: <b>${state.availableNumbers.length}</b>`, {
    parse_mode: "HTML",
  });
});

bot.onText(/\/stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /stats.");

  const totalAvailable = state.availableNumbers.length;

  let totalAssigned = 0;
  for (const arr of Object.values(state.assignedNumbers)) if (Array.isArray(arr)) totalAssigned += arr.length;

  let totalOtps = 0;
  for (const u of Object.values(state.teamUsers)) totalOtps += Number(u?.totalOtp || 0);

  const lines = [
    "📊 <b>Global Stats</b>",
    "",
    `📦 Available numbers: <b>${totalAvailable}</b>`,
    `📤 Assigned numbers (total): <b>${totalAssigned}</b>`,
    `🔐 Total OTPs (unique per number): <b>${totalOtps}</b>`,
  ];

  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
});

bot.onText(/\/user[-_]?stats\b(?:\s+(\d+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /user_stats.");

  const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
  if (!entries.length) return bot.sendMessage(chatId, "No team users registered yet.");

  const pageSize = USER_STATS_PAGE_SIZE || 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(match?.[1] || 1)));

  const start = (page - 1) * pageSize;
  const slice = entries.slice(start, start + pageSize);

  const lines = [`📊 <b>User Stats</b> (Page ${page}/${totalPages})`, ""];
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
  if (page > 1) nav.push({ text: "⬅ Prev", callback_data: `userStatsPage:${page - 1}` });
  if (page < totalPages) nav.push({ text: "Next ➡", callback_data: `userStatsPage:${page + 1}` });

  bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
  });
});

bot.onText(/\/erasenumbers\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /erasenumbers.");
  const before = state.availableNumbers.length;
  state.availableNumbers = [];
  persist();
  bot.sendMessage(chatId, `🧹 Erased all available numbers.\nPrevious available count: <b>${before}</b>.`, { parse_mode: "HTML" });
});

bot.onText(/\/clearuser_stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /clearuser_stats.");

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
  bot.sendMessage(chatId, "✅ All user stats cleared.\nUnused assignments returned to the pool.\nUsers must request again.");
});

bot.onText(/\/reset\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /reset.");

  const keptUsers = state.teamUsers || {};
  state = getDefaultState();
  state.teamUsers = keptUsers;

  for (const uid of Object.keys(state.teamUsers)) {
    ensureTeamUser(uid);
    state.teamUsers[uid].totalPulled = 0;
    state.teamUsers[uid].totalOtp = 0;
    state.teamUsers[uid].otpNumbers = [];
    state.teamUsers[uid].submittedNumbers = [];
  }

  persist();
  bot.sendMessage(chatId, "♻️ Bot data reset completed.\n✅ Allowed user list is kept.");
});

// ========== CALLBACK QUERIES ==========
bot.on("callback_query", async (query) => {
  const { data } = query;
  const fromId = query.from.id;
  const uid = String(fromId);
  const msgId = query.message?.message_id;
  const chatId = query.message?.chat.id;

  if (!data || !chatId) return;

  // pagination buttons
  if (data.startsWith("removeUserPage:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Admin only", show_alert: true });
    const page = Number(data.split(":")[1] || "1") || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
    const pageSize = REMOVE_USER_PAGE_SIZE || 20;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const rows = slice.map(([u, info]) => [[{ text: `${info.name || "User"} (ID: ${u})`, callback_data: `removeUser:${u}` }]]);
    const nav = [];
    if (p > 1) nav.push({ text: "⬅ Prev", callback_data: `removeUserPage:${p - 1}` });
    if (p < totalPages) nav.push({ text: "Next ➡", callback_data: `removeUserPage:${p + 1}` });
    if (nav.length) rows.push(nav);

    await bot
      .editMessageText(`🗑️ Select a user to remove (Page ${p}/${totalPages}):`, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: rows },
      })
      .catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("clearSinglePage:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Admin only", show_alert: true });
    const page = Number(data.split(":")[1] || "1") || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
    const pageSize = CLEAR_SINGLE_STATS_PAGE_SIZE || 20;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const rows = slice.map(([u, info]) => [[{ text: `🧼 ${info.name || "User"} (ID: ${u})`, callback_data: `clearSingle:${u}` }]]);
    const nav = [];
    if (p > 1) nav.push({ text: "⬅ Prev", callback_data: `clearSinglePage:${p - 1}` });
    if (p < totalPages) nav.push({ text: "Next ➡", callback_data: `clearSinglePage:${p + 1}` });
    if (nav.length) rows.push(nav);

    await bot
      .editMessageText(`🧼 Select a user to clear stats (Page ${p}/${totalPages}):`, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: rows },
      })
      .catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("userStatsPage:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Admin only", show_alert: true });
    const page = Number(data.split(":")[1] || "1") || 1;

    const entries = Object.entries(state.teamUsers).sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""));
    const pageSize = USER_STATS_PAGE_SIZE || 10;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const p = Math.min(totalPages, Math.max(1, page));

    const start = (p - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);

    const lines = [`📊 <b>User Stats</b> (Page ${p}/${totalPages})`, ""];
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
    if (p > 1) nav.push({ text: "⬅ Prev", callback_data: `userStatsPage:${p - 1}` });
    if (p < totalPages) nav.push({ text: "Next ➡", callback_data: `userStatsPage:${p + 1}` });

    await bot
      .editMessageText(lines.join("\n"), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
      })
      .catch(() => {});
    return bot.answerCallbackQuery(query.id);
  }

  // request buttons
  if (data.startsWith("req:")) {
    const amount = Number(data.split(":")[1] || "0");
    if (!amount || amount <= 0) return bot.answerCallbackQuery(query.id, { text: "Invalid amount." });

    if (!isAdmin(fromId) && !state.teamUsers[uid]) {
      return bot.answerCallbackQuery(query.id, { text: "You are not registered. Ask admin first.", show_alert: true });
    }

    // cooldown
    if (!isAdmin(fromId)) {
      ensureTeamUser(uid);
      const cd = getCooldownRemainingMs(uid);
      if (cd > 0) {
        return bot.answerCallbackQuery(query.id, { text: `You can send request after ${formatCooldown(cd)}`, show_alert: true });
      }
    }

    const pending = state.pullRequests.find((r) => r.userId === uid && r.status === "pending");
    if (pending) {
      return bot.answerCallbackQuery(query.id, { text: `Pending request (#${pending.id}) exists. Use /cancel.`, show_alert: true });
    }

    const createdAt = new Date().toISOString();
    const reqId = state.nextRequestId++;

    // auto-approve ONLY for 20 (kept same as your bot-1)
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

      state.pullRequests.push({ id: reqId, userId: uid, amount, status: "approved", createdAt });
      persist();

      bot.answerCallbackQuery(query.id, { text: "Auto-approved (20)." });

      if (chatId && msgId) {
        bot
          .editMessageText(`✅ Auto-approved request #${reqId}.\nRequested: <b>${amount}</b>\nAssigned: <b>${assignCount}</b>`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
          })
          .catch(() => {});
      }

      if (assignCount > 0) {
        bot.sendMessage(Number(uid), `✅ Your request is auto-approved.\nRequested: <b>${amount}</b>\nAssigned: <b>${assignCount}</b>`, {
          parse_mode: "HTML",
        }).catch(() => {});
        bot.sendMessage(Number(uid), assigned.join("\n")).catch(() => {});
      } else {
        bot.sendMessage(Number(uid), `⚠️ Pool is empty right now. Please try later.`, { parse_mode: "HTML" }).catch(() => {});
      }

      return;
    }

    // pending approval for >20
    ensureTeamUser(uid);
    state.teamUsers[uid].lastRequestAt = Date.now();
    state.pullRequests.push({ id: reqId, userId: uid, amount, status: "pending", createdAt });
    persist();

    bot.answerCallbackQuery(query.id, { text: `Request created for ${amount}.` });

    bot
      .editMessageText(`📥 Request created for <b>${amount}</b> numbers.\nPlease wait for admin approval.`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
      })
      .catch(() => {});

    const name = state.teamUsers?.[uid]?.name || query.from.username || `User_${uid}`;
    const kb = {
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Approve ${amount}`, callback_data: `approveReq:${reqId}` },
          { text: `❌ Reject`, callback_data: `rejectReq:${reqId}` },
        ]],
      },
    };

    bot
      .sendMessage(
        ADMIN_ID,
        `📥 <b>New pull request</b>\n\nFrom: <b>${escapeHtml(name)}</b>\nID: <code>${uid}</code>\nRequested: <b>${amount}</b> numbers.`,
        { parse_mode: "HTML", ...kb }
      )
      .catch(() => {});
    return;
  }

  // approve request (admin)
  if (data.startsWith("approveReq:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Only admin can approve.", show_alert: true });

    const id = Number(data.split(":")[1] || "0");
    const req = state.pullRequests.find((r) => r.id === id);
    if (!req || req.status !== "pending") {
      return bot.answerCallbackQuery(query.id, { text: "Request not found or already processed.", show_alert: true });
    }

    const targetUid = req.userId;

    // Enforce remaining restriction
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
    req.status = "approved";
    persist();

    bot.answerCallbackQuery(query.id, { text: "Request approved." });

    if (chatId && msgId) {
      bot
        .editMessageText(
          `✅ Approved request #${req.id}.\nUser: <code>${targetUid}</code>\nRequested: ${requested}\nAssigned: ${assignCount}\nRemaining in pool: ${state.availableNumbers.length}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
        )
        .catch(() => {});
    }

    bot
      .sendMessage(Number(targetUid), `✅ Your request is approved.\nRequested: <b>${requested}</b>\nAssigned: <b>${assignCount}</b>`, {
        parse_mode: "HTML",
      })
      .catch(() => {});

    if (assignCount > 0) bot.sendMessage(Number(targetUid), assigned.join("\n")).catch(() => {});
    return;
  }

  // reject request (admin)
  if (data.startsWith("rejectReq:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Only admin can reject.", show_alert: true });

    const id = Number(data.split(":")[1] || "0");
    const req = state.pullRequests.find((r) => r.id === id);
    if (!req || req.status !== "pending") {
      return bot.answerCallbackQuery(query.id, { text: "Request not found or already processed.", show_alert: true });
    }

    req.status = "rejected";
    persist();

    bot.answerCallbackQuery(query.id, { text: "Request rejected." });

    if (chatId && msgId) {
      bot
        .editMessageText(`❌ Rejected request #${req.id}.\nUser: <code>${req.userId}</code>\nRequested: ${req.amount}`, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
        })
        .catch(() => {});
    }

    bot.sendMessage(Number(req.userId), `❌ Your request for <b>${req.amount}</b> numbers has been rejected.`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  // remove user (admin) - return ONLY unused numbers
  if (data.startsWith("removeUser:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Only admin can remove users.", show_alert: true });

    const targetUid = data.split(":")[1];
    if (!targetUid || !state.teamUsers[targetUid]) {
      return bot.answerCallbackQuery(query.id, { text: "User not found.", show_alert: true });
    }

    const unused = getUnusedAssignedNumbers(targetUid);
    if (unused.length) state.availableNumbers.push(...unused);

    delete state.assignedNumbers[targetUid];
    const removedInfo = state.teamUsers[targetUid];
    delete state.teamUsers[targetUid];

    // cancel their pending requests too
    state.pullRequests = state.pullRequests.map((r) =>
      r.userId === targetUid && r.status === "pending" ? { ...r, status: "cancelled" } : r
    );

    // dedupe pool
    const seen = new Set();
    state.availableNumbers = state.availableNumbers.map(normalizeNumber).filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: "User removed." });
    bot.editMessageText("✅ User removed.\n♻️ Only unused numbers returned to pool.", { chat_id: chatId, message_id: msgId }).catch(() => {});
    bot
      .sendMessage(
        ADMIN_ID,
        `👤 Removed user:\nID: <code>${targetUid}</code>\nName: <b>${escapeHtml(removedInfo.name || "")}</b>\nReturned unused: <b>${unused.length}</b>`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
    return;
  }

  // clear single user stats (admin) - keep user allowed
  if (data.startsWith("clearSingle:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Only admin can do this.", show_alert: true });

    const targetUid = data.split(":")[1];
    if (!targetUid || !state.teamUsers[targetUid]) {
      return bot.answerCallbackQuery(query.id, { text: "User not found.", show_alert: true });
    }

    const unused = getUnusedAssignedNumbers(targetUid);
    if (unused.length) state.availableNumbers.push(...unused);

    delete state.assignedNumbers[targetUid];

    ensureTeamUser(targetUid);
    state.teamUsers[targetUid].totalPulled = 0;
    state.teamUsers[targetUid].totalOtp = 0;
    state.teamUsers[targetUid].otpNumbers = [];
    state.teamUsers[targetUid].submittedNumbers = [];

    for (const r of state.pullRequests) {
      if (r.userId === targetUid && r.status === "pending") r.status = "cancelled";
    }

    const seen = new Set();
    state.availableNumbers = state.availableNumbers.map(normalizeNumber).filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: "Cleared." });
    bot.editMessageText(`✅ Cleared stats for user ID: ${targetUid}\nReturned unused: ${unused.length}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    return;
  }
});

// ========== MESSAGE HANDLER ==========
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  // ignore commands
  if (text.startsWith("/")) return;

  const uid = String(msg.from.id);

  // admin /broadcast session
  if (isAdmin(chatId) && broadcastSessions.has(chatId)) {
    broadcastSessions.delete(chatId);
    const userIds = Object.keys(state.teamUsers || {});
    let sent = 0;
    for (const toId of userIds) {
      try {
        await bot.sendMessage(toId, text);
        sent++;
        await new Promise((r) => setTimeout(r, 35));
      } catch (_) {}
    }
    return bot.sendMessage(chatId, `✅ Broadcast sent to ${sent} users.`);
  }

  // admin /addnumber session
  if (isAdmin(chatId) && addNumberSessions.has(chatId)) {
    const session = addNumberSessions.get(chatId);
    const numbers = parseNumbersFromText(text);
    if (!numbers.length) return bot.sendMessage(chatId, "No valid numbers found. Send again or /done.");
    for (const n of numbers) session.numbers.add(n);

    return bot.sendMessage(
      chatId,
      `📥 Captured <b>${numbers.length}</b> numbers.\nSession total: <b>${session.numbers.size}</b>\nSend more or /done.`,
      { parse_mode: "HTML" }
    );
  }

  // admin /adduser session
  if (isAdmin(chatId) && addUserSessions.has(chatId)) {
    const parts = text.split(/\s+/);
    const idPart = parts.shift();
    const userId = Number(idPart);
    const name = parts.join(" ") || `User_${idPart}`;

    if (!userId || isNaN(userId)) {
      return bot.sendMessage(chatId, "❌ Invalid Telegram ID.\nExample:\n<code>6085016532 Mr X</code>", { parse_mode: "HTML" });
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();
    addUserSessions.delete(chatId);

    return bot.sendMessage(chatId, `✅ Added/updated:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`, { parse_mode: "HTML" });
  }

  // OTP lookup must contain digits
  if (!/\d{5,}/.test(text)) return;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return bot.sendMessage(chatId, "⚠️ Please send only <b>one number</b> per message for OTP lookup.", { parse_mode: "HTML" });
  }

  const numberText = lines[0];
  const normalizedInput = normalizeNumber(numberText);
  if (!normalizedInput) return;

  // only team users or admin
  if (!isAdmin(chatId) && !state.teamUsers[uid]) {
    return bot.sendMessage(chatId, "❌ You are not registered to use OTP lookup.\nAsk admin to add you.");
  }

  // Non-admins can only query numbers assigned to them
  if (!isAdmin(chatId)) {
    const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
    const assignedSet = new Set(assignedAll.map(normalizeNumber));
    if (!assignedSet.has(normalizedInput)) {
      return bot.sendMessage(chatId, "❌ This number is not assigned to you.\nSubmit only numbers you pulled via this bot.");
    }
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const result = await findLatestOtpForNumber(numberText);

    if (!result) {
      return bot.sendMessage(chatId, `No OTP found for number: <code>${escapeHtml(numberText)}</code> in the last 8 days.`, {
        parse_mode: "HTML",
      });
    }

    if (!result.otp) {
      return bot.sendMessage(
        chatId,
        `Message found for <code>${escapeHtml(numberText)}</code> but no 5-digit OTP.\n\n<pre>${escapeHtml(result.message)}</pre>`,
        { parse_mode: "HTML" }
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
    return bot.sendMessage(chatId, reply, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (err) {
    console.error("Error while searching OTP:", err.message || err);
    return bot.sendMessage(chatId, "Something went wrong while fetching OTP.");
  }
});

console.log("GS OTP Bot (IPRN) started…");
