const { state, saveState } = require("../state");
const config = require("../config");
const logger = require("../services/logger");
const otpWatcher = require("../services/otpWatcher");

module.exports = function(bot) {
    // Handle /about command
    bot.onText(/\/about/, async (msg) => {
        const chatId = msg.chat.id;
        
        let apiStatus = "🔴 Offline";
        try {
            const status = await otpWatcher.getApiStatus();
            if (status.status === 'online') {
                apiStatus = `🟢 Online (${status.total} records today)`;
            } else {
                apiStatus = `🟡 ${status.status} (${status.message || 'Unknown'})`;
            }
        } catch (err) {
            apiStatus = "🔴 Error";
        }
        
        await bot.sendMessage(
            chatId,
            `🤖 CTG IPRN Bot\n\n` +
            `Version: 2.0.0\n` +
            `API Status: ${apiStatus}\n\n` +
            `Features:\n` +
            `• Get numbers for OTP verification\n` +
            `• Auto-fetch OTPs from API\n` +
            `• Track OTP statistics\n` +
            `• Withdraw OTPs\n` +
            `• Admin panel for management\n\n` +
            `Use /start to begin!`
        );
    });
    
    // Handle /admin command (only for admins)
    bot.onText(/\/admin/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const isAdmin = config.admins.includes(userId);
        
        if (!isAdmin) {
            return bot.sendMessage(chatId, "❌ This command is only for admins.");
        }
        
        const keyboard = [
            ["📱 Get Number", "➕ Add Number"],
            ["📊 Stats", "👥 Remove User"],
            ["📋 Pending List", "👤 User Stats"],
            ["📢 Broadcast", "🗑️ Erase Number"],
            ["🧹 Erase Assigned", "📊 Clear User Stats"],
            ["🧹 Clear Single Stats", "⚙️ On/Off"],
            ["💰 Withdraw On/Off", "📡 Set Channel ID"],
            ["📡 API Status", "🔑 Token Status"],
            ["🔄 Rotate Token", "🔄 Reset"],
            ["🧹 Clean Orphans", "🔍 Test Message"]
        ];
        
        await bot.sendMessage(chatId, "🔧 Admin Menu", {
            reply_markup: {
                keyboard: keyboard,
                resize_keyboard: true
            }
        });
    });
};