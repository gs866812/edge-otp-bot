const { state, saveState } = require("../state");
const config = require("../config");

function getMenuKeyboard(isAdmin) {
    const baseKeyboard = [
        ["📱 Get Number", "ℹ️ Your Info"],
        ["💰 Withdraw OTP"]
    ];
    
    // ===== OTP গ্রুপে যাওয়ার বাটন =====
    if (config.otpGroupUsername) {
        baseKeyboard.push(["📡 OTP Log Group"]);
    }
    
    if (isAdmin) {
        return [
            ["📱 Get Number", "➕ Add Number"],
            ["📊 Stats", "👥 Remove User"],
            ["📋 Pending List", "👤 User Stats"],
            ["📢 Broadcast", "🗑️ Erase Number"],
            ["🧹 Erase Assigned", "📊 Clear User Stats"],
            ["🧹 Clear Single Stats", "⚙️ On/Off"],
            ["💰 Withdraw On/Off", "📡 Set Channel ID"],
            ["📡 Set OTP Log Channel", "📡 API Status"],
            ["🔑 Manage Tokens", "🔄 Rotate Token"],
            ["⏱️ Set Rate Limit", "🔄 Sync Numbers"],
            ["🧹 Clean Orphans", "🔍 Test Message"],
            ["🔄 Reset"]
        ];
    }
    
    return baseKeyboard;
}

module.exports = function(bot) {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const user = msg.from;
        const isAdmin = config.admins.includes(userId);
        
        // Clear runtime states
        state.runtime.waitingAddNumbers = null;
        state.runtime.waitingBroadcast = null;
        state.runtime.waitingChannelId = null;
        state.runtime.waitingSingleStats = null;
        state.runtime.waitingTestOtp = null;
        state.runtime.waitingTestMessage = null;
        state.runtime.waitingRemoveUserSingle = null;
        state.runtime.waitingAddToken = null;
        state.runtime.waitingConfirmation = false;
        state.runtime.waitingBroadcastConfirm = null;
        state.runtime.waitingRateLimit = null;
        state.runtime.broadcastMessage = null;
        state.runtime.broadcastUserCount = null;
        state.runtime.pendingAction = null;
        state.runtime.addNumberBuffer = [];
        saveState();
        
        if (!state.settings.botEnabled && !isAdmin) {
            return bot.sendMessage(chatId, "⚠️ Bot is currently disabled. Please try again later.");
        }
        
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
        const isRemoved = isPending && state.pendingUsers[userId]?.status === "removed";
        const isRejected = isPending && state.pendingUsers[userId]?.status === "rejected";
        
        if (isRemoved || isRejected) {
            delete state.pendingUsers[userId];
            saveState();
            
            const keyboard = {
                reply_markup: {
                    keyboard: [["📝 Join Request"]],
                    resize_keyboard: true,
                    one_time_keyboard: false
                }
            };
            
            return bot.sendMessage(
                chatId,
                `👋 Welcome back ${user.first_name || "User"}!\n\n` +
                `You can send a new join request by clicking the button below.`,
                keyboard
            );
        }
        
        if (!isAdmin && !isApproved) {
            if (isPending) {
                const status = state.pendingUsers[userId].status;
                if (status === "pending") {
                    const keyboard = {
                        reply_markup: {
                            keyboard: [["📝 Join Request"]],
                            resize_keyboard: true,
                            one_time_keyboard: false
                        }
                    };
                    return bot.sendMessage(chatId, "⏳ Your join request is pending approval from admin.", keyboard);
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
                `👋 Welcome ${user.first_name || "User"} to CTG IPRN Bot!\n\n` +
                `Please click the button below to request access.`,
                keyboard
            );
        }
        
        const welcomeMessage = isAdmin 
            ? `👋 Welcome Admin ${user.first_name || "Admin"} to CTG IPRN Bot!`
            : `👋 Welcome ${user.first_name || "User"} to CTG IPRN Bot!`;
        
        const keyboard = getMenuKeyboard(isAdmin);
        
        await bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: {
                keyboard: keyboard,
                resize_keyboard: true
            }
        });
    });
};