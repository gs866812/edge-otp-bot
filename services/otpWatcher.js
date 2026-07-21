const { state, saveState } = require("../state");
const config = require("../config");
const logger = require("./logger");

// Get tokens from state
function getTokensFromState() {
    if (state.tokens && state.tokens.list) {
        return state.tokens.list
            .filter(t => t.active !== false)
            .map(t => `${t.id}|${t.token}`);
    }
    return [];
}

// API Configuration
let API_CONFIG = {
    baseUrl: config.api.baseUrl || "https://api.iprn.pro/api/public/v1/stock/edr-account",
    tokens: getTokensFromState(),
    pollingInterval: config.api.pollingInterval || 5000,
    perPage: config.api.perPage || 25
};

// Rate limit tracking
const rateLimitTracker = {
    maxRequests: 280,
    windowMs: 60000
};

let lastProcessedId = {};
let isProcessing = false;
let tokenStatus = {};
let botInstance = null;

// ===== OTP লগ গ্রুপে সেন্ড করার ফাংশন (আপডেটেড) =====
async function sendOtpToLogChannel(bot, number, otp, userId, source = 'auto') {
    const channelId = state.settings.otpLogChannelId;
    if (!channelId) return false;

    try {
        // নাম্বার মাস্ক করা (শেষ ৪ ডিজিট দেখানো)
        const cleanNumber = number.replace(/[^\d]/g, '');
        const last4 = cleanNumber.slice(-4);
        const firstPart = cleanNumber.slice(0, cleanNumber.length - 4);
        // প্রথম ৩ ডিজিট দেখানো, বাকি * দিয়ে মাস্ক
        const visibleFirst = firstPart.slice(0, 3);
        const maskedMiddle = firstPart.slice(3).replace(/\d/g, '*');
        const displayNumber = number.startsWith('+')
            ? `+${visibleFirst}${maskedMiddle}${last4}`
            : `${visibleFirst}${maskedMiddle}${last4}`;

        const sourceText = source === 'auto' ? '🔄 Auto' : '🔍 Manual';
        const botUsername = config.botUsername || 'EDGE_OTP_Bot';
        const botLink = `https://t.me/${botUsername}`;

        // ===== NEW: improved message format with inline buttons =====
        const message =
            `📱 *OTP Received*\n\n` +
            `📌 *Number:* \`${displayNumber}\`\n` +
            `🔑 *OTP:* \`${otp}\`\n` +
            `🆔 *User ID:* \`${userId}\`\n` +
            `📡 *Source:* ${sourceText}\n` +
            `⏱️ *Time:* ${new Date().toLocaleString()}`;

        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: "🤖 Go to Bot",
                        url: botLink
                    }
                ]
            ]
        };

        await bot.sendMessage(channelId, message, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
        logger.info(`📤 OTP sent to log channel: ${otp} for ${displayNumber}`);
        return true;
    } catch (err) {
        logger.error(`Failed to send OTP to log channel:`, err.message);
        return false;
    }
}

// ===== TOKEN MANAGEMENT FUNCTIONS =====

function addToken(tokenId, token) {
    if (!state.tokens) {
        state.tokens = { list: [], lastUpdate: null };
    }

    const existingIndex = state.tokens.list.findIndex(t => t.id === tokenId);
    if (existingIndex !== -1) {
        state.tokens.list[existingIndex].token = token;
        state.tokens.list[existingIndex].active = true;
        state.tokens.list[existingIndex].errorCount = 0;
        state.tokens.list[existingIndex].lastChecked = new Date().toISOString();
    } else {
        state.tokens.list.push({
            id: tokenId,
            token: token,
            active: true,
            errorCount: 0,
            lastChecked: new Date().toISOString()
        });
    }

    state.tokens.lastUpdate = new Date().toISOString();
    saveState();

    API_CONFIG.tokens = getTokensFromState();
    reinitializeTokenStatus();

    logger.info(`✅ Token ${tokenId} added/updated successfully`);
    return true;
}

function removeToken(tokenId) {
    if (!state.tokens) return false;

    const index = state.tokens.list.findIndex(t => t.id === tokenId);
    if (index === -1) return false;

    state.tokens.list.splice(index, 1);
    state.tokens.lastUpdate = new Date().toISOString();
    saveState();

    API_CONFIG.tokens = getTokensFromState();
    reinitializeTokenStatus();

    logger.info(`🗑️ Token ${tokenId} removed`);
    return true;
}

function deactivateToken(tokenId) {
    if (!state.tokens) return false;

    const token = state.tokens.list.find(t => t.id === tokenId);
    if (!token) return false;

    token.active = false;
    token.errorCount = (token.errorCount || 0) + 1;
    token.lastChecked = new Date().toISOString();
    state.tokens.lastUpdate = new Date().toISOString();
    saveState();

    API_CONFIG.tokens = getTokensFromState();
    reinitializeTokenStatus();

    logger.warn(`⚠️ Token ${tokenId} deactivated (invalid)`);
    return true;
}

function reactivateToken(tokenId) {
    if (!state.tokens) return false;

    const token = state.tokens.list.find(t => t.id === tokenId);
    if (!token) return false;

    token.active = true;
    token.errorCount = 0;
    token.lastChecked = new Date().toISOString();
    state.tokens.lastUpdate = new Date().toISOString();
    saveState();

    API_CONFIG.tokens = getTokensFromState();
    reinitializeTokenStatus();

    logger.info(`✅ Token ${tokenId} reactivated`);
    return true;
}

function getTokenStatus() {
    if (!state.tokens) return [];

    return state.tokens.list.map(t => ({
        id: t.id,
        active: t.active !== false,
        errorCount: t.errorCount || 0,
        lastChecked: t.lastChecked || 'Never'
    }));
}

function reinitializeTokenStatus() {
    const tokens = getTokensFromState();
    tokenStatus = {};

    tokens.forEach((tokenString, index) => {
        const parts = tokenString.split('|');
        const tokenId = parts[0] || `token_${index + 1}`;
        const token = parts.slice(1).join('|') || tokenString;

        const stateToken = state.tokens?.list?.find(t => t.id === tokenId);
        const isActive = stateToken ? stateToken.active !== false : true;

        tokenStatus[index] = {
            id: tokenId,
            token: token,
            active: isActive,
            lastUsed: Date.now(),
            errorCount: stateToken?.errorCount || 0,
            totalFetched: 0,
            lastSuccess: null,
            rateLimitReset: Date.now(),
            requestsThisMinute: 0
        };
    });
}

function initializeTokenStatus() {
    const tokens = getTokensFromState();
    tokenStatus = {};

    tokens.forEach((tokenString, index) => {
        const parts = tokenString.split('|');
        const tokenId = parts[0] || `token_${index + 1}`;
        const token = parts.slice(1).join('|') || tokenString;

        const stateToken = state.tokens?.list?.find(t => t.id === tokenId);
        const isActive = stateToken ? stateToken.active !== false : true;

        tokenStatus[index] = {
            id: tokenId,
            token: token,
            active: isActive,
            lastUsed: Date.now(),
            errorCount: stateToken?.errorCount || 0,
            totalFetched: 0,
            lastSuccess: null,
            rateLimitReset: Date.now(),
            requestsThisMinute: 0
        };
    });
}

async function checkInvalidTokens(bot) {
    const invalidTokens = state.tokens?.list?.filter(t => t.active === false) || [];

    if (invalidTokens.length > 0) {
        const adminIds = config.admins || [];
        const tokenIds = invalidTokens.map(t => t.id).join(', ');

        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(
                    adminId,
                    `⚠️ *Token Alert*\n\n` +
                    `The following token(s) are invalid:\n` +
                    `📌 ${tokenIds}\n\n` +
                    `Please update them using:\n` +
                    `🔑 "Manage Tokens" from admin menu`,
                    { parse_mode: "Markdown" }
                );
            } catch (err) {
                logger.error(`Failed to notify admin ${adminId}:`, err.message);
            }
        }
    }
}

// ===== MAIN FUNCTIONS =====

function normalizeNumber(number) {
    if (!number) return null;
    let cleaned = number.replace(/[^\d+]/g, '');
    if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
    }
    return cleaned;
}

function getNumberWithoutCountryCode(number) {
    if (!number) return null;
    const cleaned = number.replace(/[^\d]/g, '');
    if (cleaned.length >= 10) {
        return cleaned.slice(-10);
    }
    return cleaned;
}

function extractOtpFromMessage(message) {
    if (!message) return null;

    const patterns = [
        /Code:\s*(\d{4,8})/i,
        /OTP:\s*(\d{4,8})/i,
        /code:\s*(\d{4,8})/i,
        /otp:\s*(\d{4,8})/i,
        /验证码:\s*(\d{4,8})/i,
        /Код:\s*(\d{4,8})/i,
        /PIN:\s*(\d{4,8})/i,
        /pin:\s*(\d{4,8})/i,
        /login\s*(\d{4,8})/i,
        /confirm\s*(\d{4,8})/i,
        /\b(\d{4,8})\b/
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match && match[1]) {
            const otp = match[1];
            if (/^\d{4,8}$/.test(otp)) {
                return otp;
            }
        }
    }

    const fallbackMatch = message.match(/\b\d{4,8}\b/);
    return fallbackMatch ? fallbackMatch[0] : null;
}

// ===== UPDATED: sendOtpToUser with proper counting =====
async function sendOtpToUser(bot, number, userId, otp, fullMessage, createdAt, service, destination, source = 'auto') {
    try {
        // ডুপ্লিকেট চেক
        const otpKey = `${number}|${otp}`;
        if (state.processedOtpIds && state.processedOtpIds[otpKey] === userId) {
            logger.info(`⏭️ Duplicate OTP blocked: ${otp} for ${number} (already sent to ${userId})`);
            return { sent: false, duplicate: true };
        }

        const message =
            `📱 *OTP Received*\n\n` +
            `Service: ${service || 'Unknown'}\n` +
            `Number: \`${number}\`\n\n` +
            `*OTP:* \`${otp}\`\n\n` +
            `Time: ${createdAt || new Date().toLocaleString()}\n` +
            `Destination: ${destination || 'N/A'}\n\n` +
            `📋 Tap on the OTP to copy it.`;

        await bot.sendMessage(userId, message, { parse_mode: "Markdown" });

        // OTP প্রসেস করা হয়েছে মার্ক করা
        if (!state.processedOtpIds) state.processedOtpIds = {};
        state.processedOtpIds[otpKey] = userId;

        // ===== FIX: OTP কাউন্ট আপডেট (auto এবং manual উভয়ের জন্য) =====
        if (!state.userStats[userId]) {
            state.userStats[userId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
        }
        state.userStats[userId].successOtp = (state.userStats[userId].successOtp || 0) + 1;

        // OTP লগ গ্রুপে সেন্ড করা (শুধু ইউজার আইডি সহ)
        await sendOtpToLogChannel(bot, number, otp, userId, source);

        saveState();

        logger.info(`✅ OTP sent to user ${userId}: ${otp} (Total: ${state.userStats[userId].successOtp})`);
        return { sent: true, duplicate: false };

    } catch (err) {
        logger.error(`Failed to send OTP to user ${userId}:`, err.message);
        throw err;
    }
}

function isTokenRateLimited(tokenIndex) {
    const status = tokenStatus[tokenIndex];
    if (!status) return true;
    const now = Date.now();

    if (now - status.rateLimitReset > 60000) {
        status.requestsThisMinute = 0;
        status.rateLimitReset = now;
        return false;
    }

    if (status.requestsThisMinute >= rateLimitTracker.maxRequests) {
        return true;
    }
    return false;
}

function incrementTokenRequests(tokenIndex) {
    const status = tokenStatus[tokenIndex];
    if (!status) return;
    const now = Date.now();

    if (now - status.rateLimitReset > 60000) {
        status.requestsThisMinute = 0;
        status.rateLimitReset = now;
    }
    status.requestsThisMinute++;
}

module.exports = function startOtpWatcher(bot) {
    botInstance = bot;

    initializeTokenStatus();

    const tokens = getTokensFromState();
    if (tokens.length === 0) {
        logger.error("No API tokens configured!");
        return;
    }

    logger.info("🚀 OTP Watcher started...");
    logger.info(`📡 Using ${tokens.length} API tokens`);
    logger.info(`⏱️ Polling interval: ${API_CONFIG.pollingInterval}ms`);
    logger.info(`📡 API URL: ${API_CONFIG.baseUrl}`);

    if (state.lastProcessedMessage) {
        lastProcessedId = { ...state.lastProcessedMessage };
    }

    setInterval(() => {
        if (!isProcessing) {
            fetchAndProcessOtps(bot);
        }
    }, API_CONFIG.pollingInterval);

    setTimeout(() => {
        fetchAndProcessOtps(bot);
    }, 3000);

    setInterval(() => {
        checkInvalidTokens(bot);
    }, 300000);

    setInterval(() => {
        logTokenStatus();
    }, 300000);
};

function getNextAvailableToken() {
    const activeTokens = [];

    for (const [index, status] of Object.entries(tokenStatus)) {
        const isLimited = isTokenRateLimited(parseInt(index));
        if (status.active && status.errorCount < 3 && !isLimited) {
            activeTokens.push({
                index: parseInt(index),
                token: status.token,
                id: status.id,
                lastUsed: status.lastUsed,
                requestsThisMinute: status.requestsThisMinute
            });
        }
    }

    if (activeTokens.length === 0) {
        const now = Date.now();
        for (const [index, status] of Object.entries(tokenStatus)) {
            if (status.errorCount >= 3 && (now - status.lastUsed) > 300000) {
                logger.info(`Reactivating token ${status.id}`);
                status.errorCount = 0;
                status.active = true;
                status.requestsThisMinute = 0;
                status.rateLimitReset = now;
                activeTokens.push({
                    index: parseInt(index),
                    token: status.token,
                    id: status.id,
                    lastUsed: status.lastUsed,
                    requestsThisMinute: status.requestsThisMinute
                });
            }
        }
    }

    if (activeTokens.length === 0) return null;

    let selected = activeTokens[0];
    for (const token of activeTokens) {
        if (token.requestsThisMinute < selected.requestsThisMinute) {
            selected = token;
        }
    }

    tokenStatus[selected.index].lastUsed = Date.now();
    return selected;
}

async function fetchOtpRecords(token, tokenIndex, page = 1) {
    const { baseUrl, perPage } = API_CONFIG;

    const today = new Date();
    const endDate = new Date(today);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 7);

    const startDateStr = startDate.toISOString();
    const endDateStr = endDate.toISOString();

    const url = new URL(baseUrl);
    url.searchParams.append('type', 'sms');
    url.searchParams.append('stock_account', '0');
    url.searchParams.append('perPage', perPage.toString());
    url.searchParams.append('page', page.toString());
    url.searchParams.append('sortColumn', 'created_at');
    url.searchParams.append('sortDirection', 'desc');
    url.searchParams.append('period[0]', startDateStr);
    url.searchParams.append('period[1]', endDateStr);

    const options = {
        method: 'GET',
        headers: {
            'accept': 'application/json',
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json'
        }
    };

    try {
        incrementTokenRequests(tokenIndex);
        const response = await fetch(url.toString(), options);

        if (!response.ok) {
            if (response.status === 429) {
                logger.warn(`Rate limit hit for token ${tokenIndex}`);
                tokenStatus[tokenIndex].active = false;
                tokenStatus[tokenIndex].errorCount += 1;
                const tokenId = tokenStatus[tokenIndex]?.id;
                if (tokenId) {
                    deactivateToken(tokenId);
                    notifyAdminAboutInvalidToken(tokenId);
                }
                return null;
            }
            if (response.status === 401 || response.status === 403) {
                logger.warn(`Invalid token ${tokenIndex}`);
                tokenStatus[tokenIndex].active = false;
                tokenStatus[tokenIndex].errorCount += 1;
                const tokenId = tokenStatus[tokenIndex]?.id;
                if (tokenId) {
                    deactivateToken(tokenId);
                    notifyAdminAboutInvalidToken(tokenId);
                }
                return null;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        let records = [];
        if (data.data && Array.isArray(data.data)) {
            records = data.data;
        } else if (Array.isArray(data)) {
            records = data;
        } else if (data.records && Array.isArray(data.records)) {
            records = data.records;
        } else {
            logger.warn(`⚠️ Unexpected API response format`);
            return [];
        }

        return records;

    } catch (err) {
        logger.error("❌ Failed to fetch OTP records:", err.message);
        return null;
    }
}

async function notifyAdminAboutInvalidToken(tokenId) {
    const adminIds = config.admins || [];
    for (const adminId of adminIds) {
        try {
            await botInstance.sendMessage(
                adminId,
                `⚠️ *Token Invalid*\n\n` +
                `Token ID: \`${tokenId}\`\n` +
                `Status: ❌ Invalid/Expired\n\n` +
                `Please update this token using admin menu: "🔑 Manage Tokens"`,
                { parse_mode: "Markdown" }
            );
        } catch (err) {
            logger.error(`Failed to notify admin ${adminId}:`, err.message);
        }
    }
}

// ===== FIXED: fetchAndProcessOtps with better error handling =====
async function fetchAndProcessOtps(bot) {
    try {
        isProcessing = true;

        const tokenInfo = getNextAvailableToken();
        if (!tokenInfo) {
            logger.error("No active API tokens available!");
            isProcessing = false;
            return;
        }

        const { token, index, id } = tokenInfo;

        logger.info(`🔄 Fetching with token: ${id}`);

        const records = await fetchOtpRecords(token, index);

        if (records === null) {
            tokenStatus[index].errorCount += 1;
            tokenStatus[index].active = false;
            tokenStatus[index].lastUsed = Date.now();
            isProcessing = false;
            return;
        }

        tokenStatus[index].errorCount = 0;
        tokenStatus[index].active = true;
        tokenStatus[index].lastUsed = Date.now();
        tokenStatus[index].lastSuccess = new Date().toISOString();

        if (!records || records.length === 0) {
            isProcessing = false;
            return;
        }

        tokenStatus[index].totalFetched += records.length;

        let processedCount = 0;
        let sentCount = 0;
        let duplicateCount = 0;
        let noUserCount = 0;

        for (const record of records) {
            const result = await processOtpRecord(bot, record);
            if (result) {
                processedCount++;
                if (result.sent) sentCount++;
                if (result.duplicate) duplicateCount++;
                if (result.noUser) noUserCount++;
            }
        }

        if (processedCount > 0) {
            logger.info(`✅ Processed: ${processedCount} | Sent: ${sentCount} | Duplicate: ${duplicateCount} | No User: ${noUserCount}`);
            state.lastProcessedMessage = lastProcessedId;
            saveState();
        }

    } catch (err) {
        logger.error("Error in OTP watcher:", err.message);
    } finally {
        isProcessing = false;
    }
}

// ===== FIXED: processOtpRecord with proper counting =====
async function processOtpRecord(bot, record) {
    try {
        let b_number, message, created_at, a_number, destination;

        if (record.b_number) {
            b_number = record.b_number;
        } else if (record.num) {
            b_number = record.num;
        } else if (record.number) {
            b_number = record.number;
        } else if (record.phone) {
            b_number = record.phone;
        } else {
            return { sent: false };
        }

        message = record.message || record.text || record.body || '';
        created_at = record.created_at || record.dt || record.time || new Date().toISOString();
        a_number = record.a_number || record.cli || record.service || 'Unknown';
        destination = record.destination || 'N/A';

        const normalizedNumber = normalizeNumber(b_number);
        const numberWithoutCountry = getNumberWithoutCountryCode(b_number);

        const otp = extractOtpFromMessage(message);
        if (!otp) {
            return { sent: false };
        }

        // ডুপ্লিকেট চেক
        const recordId = record.id || record._id || `${normalizedNumber}|${otp}|${created_at}`;
        const lastProcessed = state.lastProcessedMessage || {};

        if (lastProcessed[normalizedNumber] === recordId) {
            return { sent: false, duplicate: true };
        }

        const lastOtp = state.lastOtpByNumber[normalizedNumber];
        if (lastOtp === otp) {
            lastProcessedId[normalizedNumber] = recordId;
            return { sent: false, duplicate: true };
        }

        let userId = null;

        userId = state.numberOwners[normalizedNumber];

        if (!userId) {
            const withoutPlus = normalizedNumber.replace('+', '');
            userId = state.numberOwners[withoutPlus];
        }

        if (!userId) {
            userId = state.numberOwners[b_number];
        }

        if (!userId && numberWithoutCountry) {
            for (const [key, value] of Object.entries(state.numberOwners)) {
                const keyWithoutCountry = getNumberWithoutCountryCode(key);
                if (keyWithoutCountry === numberWithoutCountry) {
                    userId = value;
                    break;
                }
            }
        }

        if (userId) {
            logger.info(`📤 Sending OTP ${otp} to user ${userId} for number ${normalizedNumber}`);

            try {
                // ===== FIX: sendOtpToUser এখন কাউন্ট করবে =====
                const result = await sendOtpToUser(bot, normalizedNumber, userId, otp, message, created_at, a_number, destination, 'auto');

                if (result.sent) {
                    state.lastOtpByNumber[normalizedNumber] = otp;
                    lastProcessedId[normalizedNumber] = recordId;
                    state.lastProcessedMessage = lastProcessedId;
                    saveState();

                    logger.info(`✅ OTP sent to user ${userId} (Count: ${state.userStats[userId]?.successOtp || 0})`);
                    return { sent: true };
                } else if (result.duplicate) {
                    return { sent: false, duplicate: true };
                }

            } catch (err) {
                logger.error(`Failed to send OTP to user ${userId}:`, err.message);
                return { sent: false };
            }
        }

        logger.warn(`⚠️ Number ${normalizedNumber} not assigned - OTP ${otp} not sent`);

        lastProcessedId[normalizedNumber] = recordId;
        state.lastProcessedMessage = lastProcessedId;
        saveState();

        return { sent: false, noUser: true };

    } catch (err) {
        logger.error(`Error processing record:`, err.message);
        return { sent: false };
    }
}

function logTokenStatus() {
    logger.info("=== 📊 API Token Status ===");
    let activeCount = 0;
    let totalRecords = 0;

    for (const [index, status] of Object.entries(tokenStatus)) {
        const num = parseInt(index) + 1;
        const isLimited = isTokenRateLimited(parseInt(index));
        const statusStr = status.active && status.errorCount < 3 ? '🟢 Active' : '🔴 Inactive';
        const limitStr = isLimited ? ' ⚠️ Rate Limited' : '';
        activeCount += (status.active && status.errorCount < 3) ? 1 : 0;
        totalRecords += status.totalFetched || 0;
        const lastSuccess = status.lastSuccess ? `Last: ${status.lastSuccess}` : 'Never';
        logger.info(`Token ${num} (${status.id}): ${statusStr}${limitStr} | Errors: ${status.errorCount} | Records: ${status.totalFetched || 0} | Requests: ${status.requestsThisMinute}/min`);
    }

    logger.info(`Active: ${activeCount}/${Object.keys(tokenStatus).length}, Total Records: ${totalRecords}`);
    logger.info("===========================");
}

// ===== UPDATED: adminManualCheck with proper counting =====
module.exports.adminManualCheck = async function (bot, adminId, number) {
    try {
        logger.info(`🔍 Admin manual check: ${number} (Admin: ${adminId})`);

        const normalizedNumber = normalizeNumber(number);
        const numberWithoutCountry = getNumberWithoutCountryCode(number);

        const activeTokens = [];
        for (const [index, status] of Object.entries(tokenStatus)) {
            const isLimited = isTokenRateLimited(parseInt(index));
            if (status.active && status.errorCount < 3 && !isLimited) {
                activeTokens.push({
                    index: parseInt(index),
                    token: status.token,
                    id: status.id
                });
            }
        }

        if (activeTokens.length === 0) {
            return { success: false, message: "❌ No active API tokens available." };
        }

        for (const tokenInfo of activeTokens) {
            const { token, index, id } = tokenInfo;
            const records = await fetchOtpRecords(token, index);
            if (!records) continue;

            for (const record of records) {
                let recordNumber = record.b_number || record.num || record.number || record.phone || '';
                const recordNormalized = normalizeNumber(recordNumber);
                const recordWithoutCountry = getNumberWithoutCountryCode(recordNumber);

                if (recordNormalized === normalizedNumber ||
                    recordNormalized.replace('+', '') === normalizedNumber.replace('+', '') ||
                    recordNumber === number ||
                    (recordWithoutCountry && recordWithoutCountry === numberWithoutCountry)) {

                    const otp = extractOtpFromMessage(record.message || record.text || '');
                    if (otp) {
                        // Check duplicate
                        const otpKey = `${normalizedNumber}|${otp}`;
                        if (state.processedOtpIds && state.processedOtpIds[otpKey] === adminId) {
                            return {
                                success: false,
                                message: `⏭️ OTP ${otp} already sent to you.`
                            };
                        }

                        // ===== FIX: sendOtpToUser will count =====
                        await sendOtpToUser(bot, normalizedNumber, adminId, otp, record.message || '', record.created_at || record.dt, record.a_number || record.cli, record.destination, 'manual');

                        state.lastOtpByNumber[normalizedNumber] = otp;
                        if (!state.processedOtpIds) state.processedOtpIds = {};
                        state.processedOtpIds[otpKey] = adminId;
                        saveState();

                        return {
                            success: true,
                            message: `✅ OTP ${otp} found and sent to admin! (Total: ${state.userStats[adminId]?.successOtp || 0})`
                        };
                    }
                }
            }
        }

        return {
            success: false,
            message: `❌ No OTP found for number: ${number}`
        };

    } catch (err) {
        logger.error(`Admin check failed:`, err.message);
        return { success: false, message: `❌ Error: ${err.message}` };
    }
};

// ===== UPDATED: manualCheck with proper counting =====
module.exports.manualCheck = async function (bot, userId, number) {
    try {
        logger.info(`🔍 User ${userId} manual check: ${number}`);

        const normalizedNumber = normalizeNumber(number);
        const numberWithoutCountry = getNumberWithoutCountryCode(number);

        let ownerId = state.numberOwners[normalizedNumber];
        if (!ownerId) {
            const withoutPlus = normalizedNumber.replace('+', '');
            ownerId = state.numberOwners[withoutPlus];
        }
        if (!ownerId && numberWithoutCountry) {
            for (const [key, value] of Object.entries(state.numberOwners)) {
                if (getNumberWithoutCountryCode(key) === numberWithoutCountry) {
                    ownerId = value;
                    break;
                }
            }
        }

        if (!ownerId) {
            return { success: false, message: "❌ This number is not assigned to any user." };
        }

        if (ownerId !== userId) {
            return { success: false, message: "❌ You don't own this number." };
        }

        const activeTokens = [];
        for (const [index, status] of Object.entries(tokenStatus)) {
            const isLimited = isTokenRateLimited(parseInt(index));
            if (status.active && status.errorCount < 3 && !isLimited) {
                activeTokens.push({
                    index: parseInt(index),
                    token: status.token,
                    id: status.id
                });
            }
        }

        if (activeTokens.length === 0) {
            return { success: false, message: "❌ No active API tokens available." };
        }

        for (const tokenInfo of activeTokens) {
            const { token, index, id } = tokenInfo;
            const records = await fetchOtpRecords(token, index);
            if (!records) continue;

            for (const record of records) {
                let recordNumber = record.b_number || record.num || record.number || record.phone || '';
                const recordNormalized = normalizeNumber(recordNumber);
                const recordWithoutCountry = getNumberWithoutCountryCode(recordNumber);

                if (recordNormalized === normalizedNumber ||
                    recordNormalized.replace('+', '') === normalizedNumber.replace('+', '') ||
                    (recordWithoutCountry && recordWithoutCountry === numberWithoutCountry)) {

                    const otp = extractOtpFromMessage(record.message || record.text || '');
                    if (otp) {
                        // Check duplicate
                        const otpKey = `${normalizedNumber}|${otp}`;
                        if (state.processedOtpIds && state.processedOtpIds[otpKey] === userId) {
                            return {
                                success: false,
                                message: `⏭️ OTP ${otp} already sent to you.`
                            };
                        }

                        // ===== FIX: sendOtpToUser will count =====
                        await sendOtpToUser(bot, normalizedNumber, userId, otp, record.message || '', record.created_at || record.dt, record.a_number || record.cli, record.destination, 'manual');

                        state.lastOtpByNumber[normalizedNumber] = otp;
                        if (!state.processedOtpIds) state.processedOtpIds = {};
                        state.processedOtpIds[otpKey] = userId;
                        saveState();

                        return {
                            success: true,
                            message: `✅ OTP ${otp} found and sent! (Total: ${state.userStats[userId]?.successOtp || 0})`
                        };
                    }
                }
            }
        }

        return { success: false, message: "❌ No new OTP found for this number." };

    } catch (err) {
        logger.error(`User check failed:`, err.message);
        return { success: false, message: `❌ Error: ${err.message}` };
    }
};

// Token management functions
module.exports.addToken = addToken;
module.exports.removeToken = removeToken;
module.exports.deactivateToken = deactivateToken;
module.exports.reactivateToken = reactivateToken;
module.exports.getTokenStatus = getTokenStatus;
module.exports.reinitializeTokenStatus = reinitializeTokenStatus;

// Get API status
module.exports.getApiStatus = async function () {
    const status = {
        totalTokens: Object.keys(tokenStatus).length,
        activeTokens: 0,
        inactiveTokens: 0,
        totalRecords: 0,
        tokenDetails: [],
        overallStatus: 'offline'
    };

    for (const [index, tokenStat] of Object.entries(tokenStatus)) {
        const isActive = tokenStat.active && tokenStat.errorCount < 3;
        const isLimited = isTokenRateLimited(parseInt(index));

        status.tokenDetails.push({
            index: parseInt(index) + 1,
            id: tokenStat.id,
            active: isActive,
            limited: isLimited,
            errorCount: tokenStat.errorCount,
            totalFetched: tokenStat.totalFetched || 0,
            requestsThisMinute: tokenStat.requestsThisMinute || 0,
            lastSuccess: tokenStat.lastSuccess || 'Never'
        });

        if (isActive && !isLimited) {
            status.activeTokens++;
        } else {
            status.inactiveTokens++;
        }
        status.totalRecords += tokenStat.totalFetched || 0;
    }

    status.overallStatus = status.activeTokens > 0 ? 'online' : 'offline';
    return status;
};

module.exports.rotateToken = function () {
    const nextToken = getNextAvailableToken();
    if (nextToken) {
        logger.info(`Rotated to token ${nextToken.id}`);
        return nextToken;
    }
    logger.warn("No active tokens available");
    return null;
};

module.exports.resetTokenStatus = function () {
    for (const [index, status] of Object.entries(tokenStatus)) {
        status.active = true;
        status.errorCount = 0;
        status.lastUsed = Date.now();
        status.requestsThisMinute = 0;
        status.rateLimitReset = Date.now();
    }
    logger.info("All tokens reset");
};