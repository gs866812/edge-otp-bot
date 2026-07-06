const { state, saveState } = require("../state");
const config = require("../config");

function getMenuKeyboard(isAdmin) {
    if (isAdmin) {
        return [
            ["📱 Get Number", "➕ Add Number"],
            ["📊 Stats", "👥 Remove User"],
            ["📋 Pending List", "👤 User Stats"],
            ["📢 Broadcast", "🗑️ Erase Number"],
            ["🧹 Erase Assigned", "📊 Clear User Stats"],
            ["🧹 Clear Single Stats", "⚙️ On/Off"],
            ["💰 Withdraw On/Off", "📡 Set Channel ID"],
            ["📡 API Status", "🔑 Manage Tokens"],  // Updated
            ["🔄 Rotate Token", "🔄 Sync Numbers"],
            ["🔄 Reset", "🧹 Clean Orphans"],
            ["🔍 Test Message"]
        ];
    } else {
        return [
            ["📱 Get Number", "ℹ️ Your Info"],
            ["💰 Withdraw OTP"]
        ];
    }
}

module.exports = function(bot) {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const user = msg.from;
        const isAdmin = config.admins.includes(userId);
        
        if (!state.settings.botEnabled && !isAdmin) {
            return bot.sendMessage(chatId, "⚠️ Bot is currently disabled. Please try again later.");
        }
        
        // Add admin to users list if not already
        if (isAdmin && !state.users[userId]) {
            state.users[userId] = {
                id: userId,
                profileName: user.first_name || "Admin",
                username: user.username || "",
                joinedAt: Date.now()
            };
            if (!state.userStats[userId]) {
                state.userStats[userId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
            }
            saveState();
        }
        
        const isApproved = state.users[userId] !== undefined;
        const isPending = state.pendingUsers[userId] !== undefined;
        
        if (!isAdmin && !isApproved) {
            if (isPending) {
                const status = state.pendingUsers[userId].status;
                if (status === "pending") {
                    return bot.sendMessage(chatId, "⏳ Your join request is pending approval from admin.");
                } else if (status === "rejected" || status === "removed") {
                    return bot.sendMessage(chatId, "❌ Your access has been rejected or removed. Please contact admin.");
                }
            }
            
            const keyboard = {
                reply_markup: {
                    keyboard: [["📝 Join Request"]],
                    resize_keyboard: true,
                    one_time_keyboard: false
                }
            };
            
            return bot.sendMessage(
                chatId,
                `👋 Welcome ${user.first_name || "User"} to EDGE OTP Bot!\n\n` +
                `Please click the button below to request access.`,
                keyboard
            );
        }
        
        const welcomeMessage = isAdmin 
            ? `👋 Welcome Admin ${user.first_name || "Admin"} to EDGE OTP Bot!`
            : `👋 Welcome ${user.first_name || "User"} to EDGE OTP Bot!`;
        
        const keyboard = getMenuKeyboard(isAdmin);
        
        await bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: {
                keyboard: keyboard,
                resize_keyboard: true
            }
        });
    });
};