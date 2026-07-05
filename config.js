require("dotenv").config();

module.exports = {
    telegram: {
        botToken: process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE"
    },
    api: {
        baseUrl: process.env.API_BASE_URL || "https://api.iprn.pro/api/stock/public/edr",
        tokens: (process.env.API_TOKENS || "").split(",").map(t => t.trim()).filter(t => t.length > 0),
        pollingInterval: parseInt(process.env.API_POLLING_INTERVAL) || 15000,
        perPage: parseInt(process.env.API_PER_PAGE) || 50
    },
    admins: (process.env.ADMIN_ID || "8051523187,7598185964").split(",").map(id => id.trim())
};