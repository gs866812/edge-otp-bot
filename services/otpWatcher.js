const { state, saveState } = require("../state");
const config = require("../config");
const logger = require("./logger");

// API Configuration
const API_CONFIG = {
    baseUrl: config.api.baseUrl,
    tokens: config.api.tokens,
    pollingInterval: config.api.pollingInterval,
    perPage: config.api.perPage
};

// Track last processed message ID per number
let lastProcessedId = {};

// Token status tracking with IDs
const tokenStatus = {};

// Initialize token status with token IDs
API_CONFIG.tokens.forEach((tokenString, index) => {
    const parts = tokenString.split('|');
    const tokenId = parts[0] || `token_${index + 1}`;
    const token = parts.slice(1).join('|') || tokenString;
    
    tokenStatus[index] = {
        id: tokenId,
        token: token,
        fullTokenString: tokenString,
        active: true,
        lastUsed: Date.now(),
        errorCount: 0,
        totalFetched: 0,
        lastSuccess: null
    };
});

function normalizeNumber(number) {
    if (!number) return null;
    // Remove spaces, dashes, parentheses, and other special characters
    let cleaned = number.replace(/[\s\-\(\)]/g, '');
    // Ensure it starts with +
    if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
    }
    return cleaned;
}

module.exports = function startOtpWatcher(bot) {
    if (API_CONFIG.tokens.length === 0) {
        logger.error("No API tokens configured! Please add API_TOKENS in .env");
        return;
    }
    
    logger.info("OTP Watcher started...");
    logger.info(`Using ${API_CONFIG.tokens.length} API tokens in rotation`);
    API_CONFIG.tokens.forEach((t, i) => {
        const parts = t.split('|');
        const id = parts[0] || `Token ${i + 1}`;
        logger.info(`  ${i + 1}. ${id} (${parts[1] ? parts[1].substring(0, 10) + '...' : 'No token'})`);
    });
    logger.info(`Polling interval: ${API_CONFIG.pollingInterval}ms`);
    logger.info(`API URL: ${API_CONFIG.baseUrl}`);
    
    // Load last processed IDs from state if available
    if (state.lastProcessedMessage) {
        lastProcessedId = { ...state.lastProcessedMessage };
    }
    
    // Start the polling loop
    setInterval(() => {
        fetchAndProcessOtps(bot);
    }, API_CONFIG.pollingInterval);
    
    // Also check immediately on start
    setTimeout(() => {
        fetchAndProcessOtps(bot);
    }, 3000);
    
    // Log token status every 5 minutes
    setInterval(() => {
        logTokenStatus();
    }, 300000);
};

function getNextAvailableToken() {
    const activeTokens = [];
    
    for (const [index, status] of Object.entries(tokenStatus)) {
        if (status.active && status.errorCount < 3) {
            activeTokens.push({
                index: parseInt(index),
                token: status.token,
                id: status.id,
                lastUsed: status.lastUsed,
                errorCount: status.errorCount
            });
        }
    }
    
    if (activeTokens.length === 0) {
        // Try to reactivate tokens that haven't been used in a while
        const now = Date.now();
        for (const [index, status] of Object.entries(tokenStatus)) {
            if (status.errorCount >= 3 && (now - status.lastUsed) > 300000) {
                logger.info(`Reactivating token ${status.id} after cooldown`);
                status.errorCount = 0;
                status.active = true;
                activeTokens.push({
                    index: parseInt(index),
                    token: status.token,
                    id: status.id,
                    lastUsed: status.lastUsed,
                    errorCount: status.errorCount
                });
            }
        }
    }
    
    if (activeTokens.length === 0) {
        return null;
    }
    
    // Round-robin selection - find the least recently used token
    let selected = activeTokens[0];
    for (const token of activeTokens) {
        if (token.lastUsed < selected.lastUsed) {
            selected = token;
        }
    }
    
    // Update last used time
    tokenStatus[selected.index].lastUsed = Date.now();
    
    return selected;
}

async function fetchOtpRecords(token) {
    const { baseUrl, perPage } = API_CONFIG;
    
    const today = new Date().toISOString().split('T')[0];
    
    const url = new URL(baseUrl);
    url.searchParams.append('page', '1');
    url.searchParams.append('perPage', perPage.toString());
    url.searchParams.append('day', today);
    
    const options = {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };
    
    try {
        const response = await fetch(url.toString(), options);
        
        if (!response.ok) {
            if (response.status === 429) {
                logger.warn("Rate limit hit for token");
                return null;
            }
            if (response.status === 401 || response.status === 403) {
                logger.warn("Invalid token, marking as inactive");
                return null;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!data.data || data.data.length === 0) {
            return [];
        }
        
        return data.data;
        
    } catch (err) {
        logger.error("Failed to fetch OTP records:", err.message);
        return null;
    }
}

async function fetchAndProcessOtps(bot) {
    try {
        const tokenInfo = getNextAvailableToken();
        if (!tokenInfo) {
            logger.error("No active API tokens available!");
            return;
        }
        
        const { token, index, id } = tokenInfo;
        
        const records = await fetchOtpRecords(token);
        
        if (records === null) {
            tokenStatus[index].errorCount += 1;
            tokenStatus[index].active = false;
            tokenStatus[index].lastUsed = Date.now();
            
            if (tokenStatus[index].errorCount >= 3) {
                logger.warn(`Token ${id} has ${tokenStatus[index].errorCount} errors, skipping...`);
            }
            return;
        }
        
        tokenStatus[index].errorCount = 0;
        tokenStatus[index].active = true;
        tokenStatus[index].lastUsed = Date.now();
        tokenStatus[index].lastSuccess = new Date().toISOString();
        
        if (!records || records.length === 0) {
            return;
        }
        
        tokenStatus[index].totalFetched += records.length;
        logger.info(`Token ${id} fetched ${records.length} OTP records (Total: ${tokenStatus[index].totalFetched})`);
        
        let processedCount = 0;
        for (const record of records) {
            const processed = await processOtpRecord(bot, record);
            if (processed) {
                processedCount++;
            }
        }
        
        if (processedCount > 0) {
            logger.info(`Successfully processed ${processedCount} OTP records`);
            state.lastProcessedMessage = lastProcessedId;
            saveState();
        }
        
    } catch (err) {
        logger.error("Error in OTP watcher:", err.message);
        if (err.response) {
            logger.error("API Response:", err.response.status, err.response.data);
        }
    }
}

async function processOtpRecord(bot, record) {
    try {
        const { b_number, message, created_at, a_number, destination } = record;
        
        // Normalize the number
        const normalizedNumber = normalizeNumber(b_number);
        
        logger.debug(`Processing number: ${b_number} (normalized: ${normalizedNumber})`);
        
        // Extract OTP code from message
        const otp = extractOtpFromMessage(message);
        if (!otp) {
            logger.debug(`No OTP code found in message for ${b_number}`);
            return false;
        }
        
        logger.debug(`OTP extracted: ${otp} for number ${normalizedNumber}`);
        
        // Create a unique ID for this message
        const messageId = `${normalizedNumber}|${otp}|${created_at}`;
        
        // Check if this message was already processed
        const lastProcessed = state.lastProcessedMessage || {};
        if (lastProcessed[normalizedNumber] === messageId) {
            logger.debug(`Message already processed for ${normalizedNumber}`);
            return false;
        }
        
        // Check if this number is assigned to a user - try both formats
        let userId = state.numberOwners[normalizedNumber];
        
        // If not found with normalized, try the original
        if (!userId && b_number !== normalizedNumber) {
            userId = state.numberOwners[b_number];
            if (userId) {
                logger.debug(`Found user using original format: ${b_number}`);
            }
        }
        
        if (!userId) {
            logger.warn(`Number ${normalizedNumber} is not assigned to any user!`);
            lastProcessedId[normalizedNumber] = messageId;
            return false;
        }
        
        // Check if this OTP was already sent (duplicate)
        const lastOtp = state.lastOtpByNumber[normalizedNumber];
        if (lastOtp === otp) {
            logger.debug(`Duplicate OTP for ${normalizedNumber}: ${otp}`);
            lastProcessedId[normalizedNumber] = messageId;
            return false;
        }
        
        // Send OTP to user
        logger.info(`📤 Sending OTP ${otp} to user ${userId} for number ${normalizedNumber}`);
        await sendOtpToUser(bot, normalizedNumber, userId, otp, message, created_at, a_number, destination);
        
        // Update state
        state.lastOtpByNumber[normalizedNumber] = otp;
        lastProcessedId[normalizedNumber] = messageId;
        state.lastProcessedMessage = lastProcessedId;
        
        // Update user stats
        if (!state.userStats[userId]) {
            state.userStats[userId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
        }
        state.userStats[userId].successOtp = (state.userStats[userId].successOtp || 0) + 1;
        
        saveState();
        
        logger.info(`✅ Successfully sent OTP ${otp} to user ${userId}`);
        return true;
        
    } catch (err) {
        logger.error(`Error processing record:`, err.message);
        logger.error(err.stack);
        return false;
    }
}

function extractOtpFromMessage(message) {
    if (!message) return null;
    
    // Common OTP patterns
    const patterns = [
        /Code:\s*(\d{4,8})/i,
        /OTP:\s*(\d{4,8})/i,
        /code:\s*(\d{4,8})/i,
        /otp:\s*(\d{4,8})/i,
        /\b(\d{4,8})\b/
    ];
    
    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}

async function sendOtpToUser(bot, number, userId, otp, fullMessage, createdAt, service, destination) {
    try {
        const message = 
            `📱 OTP Received\n\n` +
            `Service: ${service || 'Unknown'}\n` +
            `Number: \`${number}\`\n\n` +
            `OTP: \`${otp}\`\n\n` +
            `Time: ${createdAt || new Date().toLocaleString()}\n` +
            `Destination: ${destination || 'N/A'}\n\n` +
            `📋 Tap on the OTP to copy it.`;
        
        await bot.sendMessage(userId, message, { parse_mode: "Markdown" });
        logger.info(`OTP sent to user ${userId} for number ${number}: ${otp}`);
        
    } catch (err) {
        logger.error(`Failed to send OTP to user ${userId}:`, err.message);
        throw err;
    }
}

function logTokenStatus() {
    logger.info("=== API Token Status ===");
    let activeCount = 0;
    let totalRecords = 0;
    
    for (const [index, status] of Object.entries(tokenStatus)) {
        const num = parseInt(index) + 1;
        const statusStr = status.active && status.errorCount < 3 ? '🟢 Active' : '🔴 Inactive';
        activeCount += (status.active && status.errorCount < 3) ? 1 : 0;
        totalRecords += status.totalFetched || 0;
        const lastSuccess = status.lastSuccess ? `Last: ${status.lastSuccess}` : 'Never';
        logger.info(`Token ${num} (${status.id}): ${statusStr} | Errors: ${status.errorCount} | Records: ${status.totalFetched || 0} | ${lastSuccess}`);
    }
    
    logger.info(`Total: ${activeCount}/${API_CONFIG.tokens.length} active tokens, ${totalRecords} total records fetched`);
    logger.info("===========================");
}

// Manual OTP check
module.exports.forceCheck = async function(bot, number) {
    try {
        const tokenInfo = getNextAvailableToken();
        if (!tokenInfo) {
            logger.error("No active tokens available for manual check");
            return false;
        }
        
        const { token, id } = tokenInfo;
        logger.info(`Manual OTP check for ${number} using token ${id}`);
        
        const records = await fetchOtpRecords(token);
        if (!records) return false;
        
        const normalizedNumber = normalizeNumber(number);
        
        for (const record of records) {
            const recordNumber = normalizeNumber(record.b_number);
            if (recordNumber === normalizedNumber || record.b_number === number) {
                const processed = await processOtpRecord(bot, record);
                return processed;
            }
        }
        
        logger.info(`No OTP found for number ${number}`);
        return false;
    } catch (err) {
        logger.error(`Manual OTP check failed:`, err.message);
        return false;
    }
};

// Get API status
module.exports.getApiStatus = async function() {
    const status = {
        totalTokens: API_CONFIG.tokens.length,
        activeTokens: 0,
        inactiveTokens: 0,
        totalRecords: 0,
        tokenDetails: []
    };
    
    for (const [index, tokenStat] of Object.entries(tokenStatus)) {
        const isActive = tokenStat.active && tokenStat.errorCount < 3;
        status.totalRecords += tokenStat.totalFetched || 0;
        status.tokenDetails.push({
            index: parseInt(index) + 1,
            id: tokenStat.id,
            active: isActive,
            errorCount: tokenStat.errorCount,
            totalFetched: tokenStat.totalFetched || 0,
            lastSuccess: tokenStat.lastSuccess || 'Never'
        });
        if (isActive) {
            status.activeTokens++;
        } else {
            status.inactiveTokens++;
        }
    }
    
    return status;
};

module.exports.rotateToken = function() {
    const nextToken = getNextAvailableToken();
    if (nextToken) {
        logger.info(`Rotated to token ${nextToken.id} (${nextToken.index + 1})`);
        return nextToken;
    }
    logger.warn("No active tokens available for rotation");
    return null;
};

module.exports.resetTokenStatus = function() {
    for (const [index, status] of Object.entries(tokenStatus)) {
        status.active = true;
        status.errorCount = 0;
        status.lastUsed = Date.now();
    }
    logger.info("All tokens reset to active status");
};