// index.js
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const moment = require("moment");
const { loadState, saveState, getDefaultState } = require("./state");

// ========== ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || process.env.ADMIN_CHAT_ID || "0");
const PHPSESSID = process.env.ZONESMS_PHPSESSID || "";
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 8000);

if (!BOT_TOKEN) {
  console.error("Please set BOT_TOKEN in .env");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("Please set ADMIN_ID (or ADMIN_CHAT_ID) in .env (your Telegram user ID).");
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
  console.error("Polling error:", { code: err.code, message: msg, responseBody: err.response && err.response.body });
});

process.on("unhandledRejection", (err) => {
  const msg = (err && err.message) || String(err);
  if (msg.includes("read ECONNRESET")) return;
  console.error("Unhandled rejection:", err);
});

// ========== COMMON HELPERS ==========
function isAdmin(chatIdOrUserId) {
  return Number(chatIdOrUserId) === ADMIN_ID;
}

function escapeHtml(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      otpNumbers: [], // numbers that already produced an OTP (unique)
      submittedNumbers: [], // manual checks history
      lastRequestAt: 0,
      lastAutoSentByNumber: {}, // number -> signature
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

// Normalize ALL stored numbers in state (safety for old state.json)
function normalizeStateNumbersInPlace() {
  // available
  state.availableNumbers = (state.availableNumbers || []).map(normalizeNumber).filter(Boolean);

  // assigned
  const newAssigned = {};
  for (const [uid, arr] of Object.entries(state.assignedNumbers || {})) {
    if (!Array.isArray(arr)) continue;
    newAssigned[String(uid)] = arr.map(normalizeNumber).filter(Boolean);
  }
  state.assignedNumbers = newAssigned;

  // dedupe available vs assigned
  const used = new Set();
  for (const arr of Object.values(state.assignedNumbers)) for (const n of arr) used.add(n);
  const seen = new Set();
  state.availableNumbers = state.availableNumbers.filter((n) => {
    if (!n) return false;
    if (used.has(n)) return false;
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  // normalize per user arrays
  for (const uid of Object.keys(state.teamUsers || {})) {
    ensureTeamUser(uid);
    state.teamUsers[uid].otpNumbers = (state.teamUsers[uid].otpNumbers || []).map(normalizeNumber).filter(Boolean);
    state.teamUsers[uid].submittedNumbers = (state.teamUsers[uid].submittedNumbers || []).map(normalizeNumber).filter(Boolean);
  }

  persist();
}
normalizeStateNumbersInPlace();

// ========== REQUEST COOLDOWN ==========
const REQUEST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

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

// “unused numbers” = numbers that have NOT produced OTP yet
function getUnusedAssignedNumbers(uid) {
  const key = String(uid);
  const assigned = Array.isArray(state.assignedNumbers[key]) ? state.assignedNumbers[key] : [];
  const usedSet = new Set((state.teamUsers?.[key]?.otpNumbers || []).map(normalizeNumber));
  return assigned.filter((n) => !usedSet.has(normalizeNumber(n)));
}

// ========== PROVIDER (ZoneSMS) ==========
const ZONESMS_REPORT_URL = "http://zonesms.net/client/ajax/dt_reports.php";
let sessionExpiredNotified = false;

function getLast3DaysRange() {
  const to = moment();
  const from = moment().subtract(3, "days");
  return { from: from.format("YYYY-MM-DD HH:mm:ss"), to: to.format("YYYY-MM-DD HH:mm:ss") };
}

async function notifySessionExpired() {
  const text =
    "⚠️ SMS provider session seems expired or logged out.\n\n" +
    "Please log in again in your browser, copy the new session cookie, " +
    "update it in `.env` and restart the bot.";
  try {
    await bot.sendMessage(ADMIN_ID, text);
  } catch (e) {
    console.error("Failed to notify admin:", e.message || e);
  }
}

async function fetchReports({ from, to, length = 100, searchNumber = "" }) {
  const params = {
    fdate1: from,
    fdate2: to,
    ftermination: "",
    fclient: "",
    fnum: searchNumber || "",
    fcli: "",
    fgdate: 0,
    fgtermination: 0,
    fgclient: 0,
    fgnumber: 0,
    fgcli: 0,
    fg: 0,
    sEcho: 1,
    iColumns: 11,
    sColumns: ",,,,,,,,,,",
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
    sSearch: "",
    bRegex: false,
    iSortCol_0: 0,
    sSortDir_0: "desc",
    iSortingCols: 1,
    _: Date.now(),
  };

  try {
    const res = await axios.get(ZONESMS_REPORT_URL, {
      params,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: `PHPSESSID=${PHPSESSID}`,
        Referer: "http://zonesms.net/client/Reports",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 15000,
    });

    if (typeof res.data === "string") {
      const html = res.data;
      if (html.includes("Member Login") || html.includes("g-recaptcha") || html.includes("Zone SMS | Login")) {
        console.warn("Provider session seems expired (got login HTML).");
        if (!sessionExpiredNotified) {
          sessionExpiredNotified = true;
          await notifySessionExpired();
        }
        return [];
      }
      console.warn("Unexpected non-JSON response from provider.");
      return [];
    }

    const data = res.data;
    const rows = data.aaData || data.data || [];
    if (!Array.isArray(rows)) return [];

    sessionExpiredNotified = false;
    return rows;
  } catch (err) {
    console.error("fetchReports error:", err.message || err);
    return [];
  }
}

function extractOtp(message) {
  if (!message || typeof message !== "string") return null;
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

async function findLatestOtpForNumber(rawNumber) {
  const number = normalizeNumber(rawNumber);
  const { from, to } = getLast3DaysRange();

  const rows = await fetchReports({ from, to, length: 300, searchNumber: number });
  if (!rows.length) return null;

  let best = null;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 11) continue;

    const dateStr = row[0] || "";
    const numRaw = row[2];
    const msg = row[10];

    if (!numRaw || !msg) continue;

    const numDigits = normalizeNumber(numRaw);
    if (!numDigits) continue;

    // match
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
    const dateStr = row[0] || "";
    const numRaw = row[2];
    const msg = row[10];
    if (!numRaw || !msg) continue;
    if (!fallback || dateStr > fallback.date) fallback = { date: dateStr, number: String(numRaw), message: msg, otp: null };
  }
  return fallback;
}

// ========== AUTO PUSH OTP (PRIVATE TO OWNER) ==========
let autoPushTimer = null;

function otpSignatureFromRow(parsed) {
  return `${parsed.otp || ""}|${parsed.date || ""}|${String(parsed.message || "").slice(0, 60)}`;
}

function parseProviderRow(row) {
  if (!Array.isArray(row) || row.length < 11) return null;
  const dateStr = row[0] || "";
  const numRaw = row[2] || "";
  const msg = row[10] || "";
  const numDigits = normalizeNumber(numRaw);
  if (!numDigits || !msg) return null;
  const otp = extractOtp(msg);
  if (!otp) return null;
  return { date: String(dateStr), numberRaw: String(numRaw), numberDigits: numDigits, message: String(msg), otp: String(otp) };
}

async function buildLatestOtpMapLast3Days() {
  const { from, to } = getLast3DaysRange();
  const rows = await fetchReports({ from, to, length: 2000, searchNumber: "" });

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

        // ✅ COUNT OTP based on arrival (unique per number)
        if (!userInfo.otpNumbers.includes(n)) {
          userInfo.otpNumbers.push(n);
          userInfo.totalOtp = (userInfo.totalOtp || 0) + 1;
          changed = true;
        }

        // ✅ Auto-push only to owner
        const sig = otpSignatureFromRow(parsed);
        if (userInfo.lastAutoSentByNumber[n] !== sig) {
          userInfo.lastAutoSentByNumber[n] = sig;
          changed = true;

          const reply = formatOtpMessage({
            otp: parsed.otp,
            number: parsed.numberRaw || n,
            message: parsed.message,
          });

          bot.sendMessage(Number(uid), reply, { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
        }
      }
    }

    if (changed) persist();
  } catch (err) {
    console.error("autoPushTick error:", err.message || err);
  }
}

function startAutoPush() {
  if (autoPushTimer) clearInterval(autoPushTimer);
  autoPushTimer = setInterval(autoPushTick, WATCH_INTERVAL_MS);
  console.log(`Auto-push enabled: checking OTPs every ${WATCH_INTERVAL_MS}ms`);
}
startAutoPush();

// ========== ADMIN SESSIONS / MODES ==========
const addNumberSessions = new Map(); // admin_chat_id -> { numbers: Set<string> }
const addUserSessions = new Map(); // admin_chat_id -> true
const broadcastSessions = new Map(); // admin_chat_id -> true

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
    `Unused (no OTP yet): <b>${unused.length}</b>`;

  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
});

// ========= Request menu =========
function openRequestMenu(chatId, uid) {
  if (!isAdmin(chatId) && !state.teamUsers[uid]) {
    return bot.sendMessage(chatId, "❌ You are not registered.\nPlease contact admin to be added before requesting numbers.");
  }

  if (!isAdmin(chatId)) {
    ensureTeamUser(uid);
    const cd = getCooldownRemainingMs(uid);
    if (cd > 0) {
      return bot.sendMessage(chatId, `⏳ You can send request after <b>${formatCooldown(cd)}</b>`, { parse_mode: "HTML" });
    }
  }

  const pending = state.pullRequests.find((r) => r.userId === uid && r.status === "pending");
  if (pending) {
    return bot.sendMessage(chatId, `⏳ You already have a pending request (#${pending.id}) for <b>${pending.amount}</b> numbers.\nUse /cancel to cancel it.`, {
      parse_mode: "HTML",
    });
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "10", callback_data: "req:10" }, { text: "20 ✅ Auto", callback_data: "req:20" }],
        [{ text: "50", callback_data: "req:50" }, { text: "100", callback_data: "req:100" }],
        [{ text: "500", callback_data: "req:500" }, { text: "1000", callback_data: "req:1000" }, { text: "2000", callback_data: "req:2000" }],
      ],
    },
  };

  bot.sendMessage(chatId, "📥 Select how many numbers you want to pull:", keyboard);
}

bot.onText(/\/number_request\b/i, (msg) => {
  openRequestMenu(msg.chat.id, String(msg.from.id));
});

bot.onText(/\/request\b/i, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "ℹ️ Renamed: use /number_request.");
  openRequestMenu(chatId, String(msg.from.id));
});

bot.onText(/\/cancel\b/i, (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);

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

  const req = state.pullRequests.find((r) => r.userId === uid && r.status === "pending");
  if (!req) return bot.sendMessage(chatId, "ℹ️ You have no pending pull request to cancel.");

  req.status = "cancelled";
  persist();
  bot.sendMessage(chatId, `✅ Your request for <b>${req.amount}</b> numbers has been cancelled.`, { parse_mode: "HTML" });
});

// ========== ADMIN PANEL ==========
bot.onText(/\/admin\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ You are not authorized to access the admin panel.");

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "👤 /adduser" }, { text: "🗑️ /removeuser" }],
        [{ text: "➕ /addnumber" }, { text: "📊 /stats" }],
        [{ text: "👥 /user_stats" }, { text: "📢 /broadcast" }],
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
      return bot.sendMessage(chatId, "❌ Invalid Telegram ID. Example:\n<code>/adduser 6085016532 Mr X</code>", { parse_mode: "HTML" });
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();

    return bot.sendMessage(chatId, `✅ Added/updated team user:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`, { parse_mode: "HTML" });
  }

  addUserSessions.set(chatId, true);
  bot.sendMessage(
    chatId,
    "👥 <b>Add User Mode</b>\n\nSend:\n<code>&lt;telegram_id&gt; &lt;name&gt;</code>\nExample:\n<code>6085016532 Mr X</code>\n\nUse /cancel to exit.",
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/removeuser\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /removeuser.");

  const entries = Object.entries(state.teamUsers || {});
  if (!entries.length) return bot.sendMessage(chatId, "No team users found.");

  const buttons = entries
    .sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""))
    .map(([uid, info]) => ({
      text: `${info.name || "User"} (ID: ${uid})`,
      callback_data: `removeUser:${uid}`,
    }));

  bot.sendMessage(chatId, "🗑️ Select a user to remove:", { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } });
});

bot.onText(/\/clear_single_stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /clear_single_stats.");

  const entries = Object.entries(state.teamUsers || {});
  if (!entries.length) return bot.sendMessage(chatId, "No team users found.");

  const buttons = entries
    .sort((a, b) => (a[1]?.name || "").localeCompare(b[1]?.name || ""))
    .map(([uid, info]) => ({
      text: `🧼 Clear: ${info.name || "User"} (ID: ${uid})`,
      callback_data: `clearSingle:${uid}`,
    }));

  bot.sendMessage(chatId, "🧼 Select a user to clear stats (user will remain allowed):", {
    reply_markup: { inline_keyboard: buttons.map((b) => [b]) },
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

bot.onText(/\/done\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /done.");

  const session = addNumberSessions.get(chatId);
  if (!session) return bot.sendMessage(chatId, "ℹ️ No active /addnumber session.");

  const newNumbers = Array.from(session.numbers).map(normalizeNumber).filter(Boolean);

  // Deduplicate vs existing pool and assignments (normalized)
  const used = new Set(state.availableNumbers.map(normalizeNumber));
  for (const arr of Object.values(state.assignedNumbers || {})) {
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

  bot.sendMessage(chatId, `✅ Added <b>${toAdd.length}</b> numbers.\n📦 Available pool: <b>${state.availableNumbers.length}</b>`, { parse_mode: "HTML" });
});

bot.onText(/\/erasenumbers\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /erasenumbers.");
  const before = state.availableNumbers.length;
  state.availableNumbers = [];
  persist();
  bot.sendMessage(chatId, `🧹 Erased all available numbers.\nPrevious available count: <b>${before}</b>.`, { parse_mode: "HTML" });
});

bot.onText(/\/stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /stats.");

  const totalAvailable = state.availableNumbers.length;
  let totalAssigned = 0;
  for (const arr of Object.values(state.assignedNumbers)) if (Array.isArray(arr)) totalAssigned += arr.length;

  let totalOtps = 0;
  for (const u of Object.values(state.teamUsers || {})) totalOtps += Number(u?.totalOtp || 0);

  const lines = [
    "📊 <b>Global Stats</b>",
    "",
    `📦 Available numbers: <b>${totalAvailable}</b>`,
    `📤 Assigned numbers (total): <b>${totalAssigned}</b>`,
    `🔐 Total OTPs (unique per number): <b>${totalOtps}</b>`,
  ];

  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
});

// ✅ supports /user_stats AND /user-stats
bot.onText(/\/user[-_]?stats\b/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /user_stats.");

  const entries = Object.entries(state.teamUsers || {});
  if (!entries.length) return bot.sendMessage(chatId, "No team users registered yet.");

  const blocks = [];
  blocks.push("📊 <b>User Stats</b>\n");

  for (const [uid, info] of entries) {
    const name = info.name || `User_${uid}`;
    const assignedAll = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
    const unused = getUnusedAssignedNumbers(uid);

    blocks.push(
      `ID: <code>${uid}</code> | <b>${escapeHtml(name)}</b>\n` +
        `Pulled: <b>${info.totalPulled || 0}</b> | OTPs: <b>${info.totalOtp || 0}</b>\n` +
        `Currently assigned: <b>${assignedAll.length}</b> | Unused(no OTP): <b>${unused.length}</b>\n`
    );
  }

  // ✅ Telegram limit safe sending
  const full = blocks.join("\n");
  const MAX = 3500;
  for (let i = 0; i < full.length; i += MAX) {
    await bot.sendMessage(chatId, full.slice(i, i + MAX), { parse_mode: "HTML" });
  }
});

bot.onText(/\/clearuser_stats\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /clearuser_stats.");

  // Return ONLY unused assigned numbers back to pool
  for (const uid of Object.keys(state.teamUsers || {})) {
    const unused = getUnusedAssignedNumbers(uid);
    if (unused.length) state.availableNumbers.push(...unused);
  }

  // Deduplicate pool
  const seen = new Set();
  state.availableNumbers = state.availableNumbers
    .map(normalizeNumber)
    .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

  // Clear assignments & requests (but keep users)
  state.assignedNumbers = {};
  state.pullRequests = [];
  state.nextRequestId = 1;

  for (const uid of Object.keys(state.teamUsers || {})) {
    ensureTeamUser(uid);
    state.teamUsers[uid].totalPulled = 0;
    state.teamUsers[uid].totalOtp = 0;
    state.teamUsers[uid].otpNumbers = [];
    state.teamUsers[uid].submittedNumbers = [];
    state.teamUsers[uid].lastAutoSentByNumber = {};
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

  for (const uid of Object.keys(state.teamUsers || {})) {
    ensureTeamUser(uid);
    state.teamUsers[uid].totalPulled = 0;
    state.teamUsers[uid].totalOtp = 0;
    state.teamUsers[uid].otpNumbers = [];
    state.teamUsers[uid].submittedNumbers = [];
    state.teamUsers[uid].lastAutoSentByNumber = {};
  }

  persist();
  bot.sendMessage(chatId, "♻️ Bot data reset completed.\n✅ Allowed user list is kept.");
});

// ========== BROADCAST ==========
bot.onText(/\/broadcast\b/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, "❌ Only admin can use /broadcast.");

  broadcastSessions.set(chatId, true);
  bot.sendMessage(chatId, "📢 <b>Broadcast Mode</b>\n\nNow send the message you want to broadcast to all users.\nCancel: /cancel", {
    parse_mode: "HTML",
  });
});

// ========== CALLBACK QUERIES ==========
bot.on("callback_query", async (query) => {
  const { data } = query;
  const fromId = query.from.id;
  const uid = String(fromId);
  const msgId = query.message?.message_id;
  const chatId = query.message?.chat.id;

  if (!data || !chatId) return;

  if (data.startsWith("req:")) {
    const amount = Number(data.split(":")[1] || "0");
    if (!amount || amount <= 0) return bot.answerCallbackQuery(query.id, { text: "Invalid amount." });

    if (!isAdmin(fromId) && !state.teamUsers[uid]) {
      return bot.answerCallbackQuery(query.id, { text: "You are not registered. Ask admin first.", show_alert: true });
    }

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

    // ✅ auto-approve ONLY for 20
    if (amount === 20) {
      ensureTeamUser(uid);
      state.teamUsers[uid].lastRequestAt = Date.now();

      const available = state.availableNumbers.length;
      const assignCount = Math.min(available, amount);

      const assigned = state.availableNumbers.splice(0, assignCount).map(normalizeNumber).filter(Boolean);
      state.assignedNumbers[uid] = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
      state.assignedNumbers[uid].push(...assigned);

      state.teamUsers[uid].totalPulled += assignCount;

      state.pullRequests.push({ id: reqId, userId: uid, amount, status: "approved", createdAt });
      persist();

      bot.answerCallbackQuery(query.id, { text: "Auto-approved (20)." });

      if (chatId && msgId) {
        await bot.editMessageText(`✅ Auto-approved request #${reqId}.\nRequested: <b>${amount}</b>\nAssigned: <b>${assignCount}</b>`, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
        });
      }

      // ✅ numbers in copy-paste friendly way (one per line)
      if (assignCount > 0) {
        await bot.sendMessage(chatId, assigned.join("\n"));
      } else {
        await bot.sendMessage(chatId, "⚠️ No available numbers in pool.");
      }

      return;
    }

    // pending approval for > 20 OR any other amount
    state.pullRequests.push({ id: reqId, userId: uid, amount, status: "pending", createdAt });
    persist();

    bot.answerCallbackQuery(query.id, { text: "Request sent for admin approval." });

    await bot.sendMessage(
      ADMIN_ID,
      `🆕 <b>New Pull Request</b>\nID: <code>${reqId}</code>\nUser: <code>${uid}</code> (${escapeHtml(state.teamUsers?.[uid]?.name || "Unknown")})\nAmount: <b>${amount}</b>\n\nApprove: /approve_${reqId}\nReject: /reject_${reqId}`,
      { parse_mode: "HTML" }
    );

    if (chatId && msgId) {
      await bot.editMessageText(`⏳ Request #${reqId} sent.\nRequested: <b>${amount}</b>\nWaiting for admin approval...`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
      });
    }
    return;
  }

  if (data.startsWith("removeUser:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Not allowed.", show_alert: true });

    const targetId = data.split(":")[1];
    if (!targetId) return bot.answerCallbackQuery(query.id, { text: "Invalid user." });

    // Return ONLY unused numbers to available pool
    const unused = getUnusedAssignedNumbers(targetId);
    if (unused.length) state.availableNumbers.push(...unused);

    delete state.assignedNumbers[targetId];
    delete state.teamUsers[targetId];

    // Deduplicate pool
    const seen = new Set();
    state.availableNumbers = state.availableNumbers
      .map(normalizeNumber)
      .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: "User removed." });
    bot.sendMessage(chatId, `✅ Removed user <code>${targetId}</code>\nReturned unused numbers: <b>${unused.length}</b>`, { parse_mode: "HTML" });
    return;
  }

  if (data.startsWith("clearSingle:")) {
    if (!isAdmin(fromId)) return bot.answerCallbackQuery(query.id, { text: "Not allowed.", show_alert: true });

    const targetId = data.split(":")[1];
    if (!targetId || !state.teamUsers[targetId]) {
      return bot.answerCallbackQuery(query.id, { text: "User not found.", show_alert: true });
    }

    const unused = getUnusedAssignedNumbers(targetId);
    if (unused.length) state.availableNumbers.push(...unused);

    state.assignedNumbers[targetId] = [];
    ensureTeamUser(targetId);
    state.teamUsers[targetId].totalPulled = 0;
    state.teamUsers[targetId].totalOtp = 0;
    state.teamUsers[targetId].otpNumbers = [];
    state.teamUsers[targetId].submittedNumbers = [];
    state.teamUsers[targetId].lastAutoSentByNumber = {};

    // Deduplicate pool
    const seen = new Set();
    state.availableNumbers = state.availableNumbers
      .map(normalizeNumber)
      .filter((n) => n && !seen.has(n) && (seen.add(n) || true));

    persist();

    bot.answerCallbackQuery(query.id, { text: "Cleared." });
    bot.sendMessage(chatId, `✅ Cleared stats for <code>${targetId}</code>\nReturned unused numbers: <b>${unused.length}</b>`, { parse_mode: "HTML" });
    return;
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

// ========== APPROVE / REJECT ==========
bot.onText(/\/approve_(\d+)\b/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const reqId = Number(match[1]);
  const req = state.pullRequests.find((r) => r.id === reqId);
  if (!req) return bot.sendMessage(chatId, "Request not found.");
  if (req.status !== "pending") return bot.sendMessage(chatId, `Request already ${req.status}.`);

  const uid = String(req.userId);
  ensureTeamUser(uid);

  // cooldown stamp
  state.teamUsers[uid].lastRequestAt = Date.now();

  const available = state.availableNumbers.length;
  const assignCount = Math.min(available, req.amount);

  const assigned = state.availableNumbers.splice(0, assignCount).map(normalizeNumber).filter(Boolean);
  state.assignedNumbers[uid] = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
  state.assignedNumbers[uid].push(...assigned);

  state.teamUsers[uid].totalPulled += assignCount;
  req.status = "approved";
  persist();

  await bot.sendMessage(chatId, `✅ Approved request #${reqId}. Assigned: <b>${assignCount}</b>`, { parse_mode: "HTML" });

  await bot.sendMessage(uid, `✅ Your request is approved.\nRequested: ${req.amount}\nAssigned: ${assignCount}`);
  if (assignCount > 0) await bot.sendMessage(uid, assigned.join("\n"));
});

bot.onText(/\/reject_(\d+)\b/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const reqId = Number(match[1]);
  const req = state.pullRequests.find((r) => r.id === reqId);
  if (!req) return bot.sendMessage(chatId, "Request not found.");
  if (req.status !== "pending") return bot.sendMessage(chatId, `Request already ${req.status}.`);

  req.status = "rejected";
  persist();

  await bot.sendMessage(chatId, `❌ Rejected request #${reqId}.`);
  await bot.sendMessage(String(req.userId), `❌ Your request #${reqId} was rejected by admin.`);
});

// ========== MESSAGE HANDLER ==========
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  const text = (msg.text || "").trim();
  if (!text) return;

  // ignore commands (they are handled elsewhere)
  if (text.startsWith("/")) return;

  // broadcast mode
  if (isAdmin(chatId) && broadcastSessions.has(chatId)) {
    broadcastSessions.delete(chatId);

    const users = Object.keys(state.teamUsers || {});
    if (!users.length) return bot.sendMessage(chatId, "No users to broadcast.");

    bot.sendMessage(chatId, `📢 Broadcasting to <b>${users.length}</b> users...`, { parse_mode: "HTML" });

    let ok = 0;
    let fail = 0;
    for (const u of users) {
      try {
        await bot.sendMessage(Number(u), text);
        ok++;
      } catch (_) {
        fail++;
      }
      // small delay to reduce flood risk
      await new Promise((r) => setTimeout(r, 40));
    }

    return bot.sendMessage(chatId, `✅ Broadcast done.\nSuccess: <b>${ok}</b>\nFailed: <b>${fail}</b>`, { parse_mode: "HTML" });
  }

  // adduser session (admin)
  if (isAdmin(chatId) && addUserSessions.has(chatId)) {
    const parts = text.split(/\s+/);
    const idPart = parts.shift();
    const userId = Number(idPart);
    const name = parts.join(" ") || `User_${idPart}`;

    if (!userId || isNaN(userId)) {
      return bot.sendMessage(chatId, "❌ Invalid format. Example:\n<code>6085016532 Mr X</code>\nCancel: /cancel", { parse_mode: "HTML" });
    }

    ensureTeamUser(userId, name);
    state.teamUsers[String(userId)].name = name;
    persist();

    return bot.sendMessage(chatId, `✅ Added/updated:\nID: <code>${userId}</code>\nName: <b>${escapeHtml(name)}</b>`, { parse_mode: "HTML" });
  }

  // addnumber session (admin)
  if (isAdmin(chatId) && addNumberSessions.has(chatId)) {
    const session = addNumberSessions.get(chatId);
    const nums = parseNumbersFromText(text);
    for (const n of nums) session.numbers.add(n);
    return bot.sendMessage(chatId, `➕ Collected: <b>${session.numbers.size}</b>\nFinish: /done`, { parse_mode: "HTML" });
  }

  // normal user manual OTP check: user must be allowed
  if (!state.teamUsers[uid] && !isAdmin(uid)) return;

  // user can submit only their own assigned number
  const n = normalizeNumber(text);
  if (!n) return;

  const assigned = Array.isArray(state.assignedNumbers[uid]) ? state.assignedNumbers[uid] : [];
  const owns = assigned.includes(n);
  if (!owns) return bot.sendMessage(chatId, "❌ You can submit only your own pulled numbers.");

  ensureTeamUser(uid);

  // track submitted unique
  if (!state.teamUsers[uid].submittedNumbers.includes(n)) {
    state.teamUsers[uid].submittedNumbers.push(n);
    persist();
  }

  const best = await findLatestOtpForNumber(n);
  if (!best || !best.otp) {
    return bot.sendMessage(chatId, `⚠️ No OTP found yet for: ${n}`);
  }

  // count unique otp per number (arrival-based; manual also updates if not counted yet)
  if (!state.teamUsers[uid].otpNumbers.includes(n)) {
    state.teamUsers[uid].otpNumbers.push(n);
    state.teamUsers[uid].totalOtp += 1;
    persist();
  }

  const reply = formatOtpMessage({ otp: best.otp, number: best.number || n, message: best.message || "" });
  bot.sendMessage(chatId, reply, { parse_mode: "HTML", disable_web_page_preview: true });
});
