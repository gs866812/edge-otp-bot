require("dotenv").config();

// Get tokens from state or environment
function getTokens() {
    try {
        const { state } = require("./state");
        if (state.tokens && state.tokens.list && state.tokens.list.length > 0) {
            // Filter only active tokens
            return state.tokens.list
                .filter(t => t.active !== false)
                .map(t => `${t.id}|${t.token}`);
        }
    } catch (err) {
        // If state not available, fallback to env
    }
    
    // Fallback to environment variables
    const tokens = [];
    let index = 1;
    while (true) {
        const tokenKey = `API_TOKEN${index}`;
        const tokenValue = process.env[tokenKey];
        if (!tokenValue) break;
        tokens.push(tokenValue.trim());
        index++;
    }
    return tokens;
}

module.exports = {
    telegram: {
        botToken: process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE"
    },
    api: {
        baseUrl: process.env.API_BASE_URL || "https://api.iprn.pro/api/public/v1/stock/edr-account",
        pollingInterval: parseInt(process.env.API_POLLING_INTERVAL) || 5000,
        perPage: parseInt(process.env.API_PER_PAGE) || 25
    },
    admins: (process.env.ADMIN_ID || "8051523187,7598185964").split(",").map(id => id.trim()),
    getTokens: getTokens,
    botUsername: process.env.BOT_USERNAME || "EDGE_OTP_Bot",
    otpGroupUsername: process.env.OTP_GROUP_USERNAME || "" // NEW
};

// Initialize tokens from state
module.exports.api.tokens = getTokens();