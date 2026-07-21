const { state, saveState, cleanupOrphanedNumbers } = require("../state");
const config = require("../config");
const logger = require("../services/logger");
const otpWatcher = require("../services/otpWatcher");

// ===== RATE LIMIT - Get from state =====
function getRateLimit() {
    return state.rateLimit || 15;
}

module.exports = function (bot) {
    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const text = msg.text;

        if (!text) return;

        if (!state.settings.botEnabled && !config.admins.includes(userId)) {
            return bot.sendMessage(chatId, "⚠️ Bot is currently disabled. Please try again later.");
        }

        // Check if admin is setting rate limit
        if (state.runtime.waitingRateLimit === userId && config.admins.includes(userId)) {
            const value = parseInt(text);
            if (isNaN(value) || value < 1) {
                await bot.sendMessage(chatId, "❌ Please enter a valid number (e.g., 10, 15, 20)");
                return true;
            }
            state.rateLimit = value;
            state.runtime.waitingRateLimit = null;
            saveState();
            await bot.sendMessage(chatId, `✅ Rate limit set to ${value} seconds!`);
            await showAdminMenu(bot, chatId);
            return true;
        }

        const handled = await handleRuntimeStates(bot, msg);
        if (handled) return;

        const phoneNumber = extractPhoneNumber(text);
        if (phoneNumber) {
            await handlePhoneNumberMessage(bot, msg, phoneNumber);
            return;
        }

        await handleMenuCommands(bot, msg);
    });
};

// ===== HELPER FUNCTIONS =====

function extractPhoneNumber(text) {
    const patterns = [
        /\+\d{10,15}/,
        /\d{10,15}/
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            let number = match[0].replace(/[\s\-\(\)]/g, '');
            if (!number.startsWith('+')) {
                number = '+' + number;
            }
            return number;
        }
    }
    return null;
}

// ===== PHONE NUMBER HANDLER =====

async function handlePhoneNumberMessage(bot, msg, phoneNumber) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const isAdmin = config.admins.includes(userId);

    if (isAdmin) {
        logger.info(`Admin ${userId} checking OTP for number: ${phoneNumber}`);

        const checkingMsg = await bot.sendMessage(chatId, "🔍 Checking for OTP... Please wait.");

        try {
            const result = await otpWatcher.adminManualCheck(bot, userId, phoneNumber);
            await bot.deleteMessage(chatId, checkingMsg.message_id);

            if (result.success) {
                await bot.sendMessage(chatId, result.message);
            } else {
                await bot.sendMessage(chatId, result.message);
            }
            return;
        } catch (err) {
            logger.error(`Error in admin OTP check:`, err.message);
            await bot.deleteMessage(chatId, checkingMsg.message_id);
            await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
            return;
        }
    }

    let ownerId = state.numberOwners[phoneNumber];

    if (!ownerId) {
        return bot.sendMessage(chatId, "❌ This number is not assigned to any user. Use '📱 Get Number' to get a number.");
    }

    if (ownerId !== userId) {
        return bot.sendMessage(chatId, "❌ You don't own this number. It's assigned to another user.");
    }

    const checkingMsg = await bot.sendMessage(chatId, "🔍 Checking for OTP... Please wait.");

    try {
        const result = await otpWatcher.manualCheck(bot, userId, phoneNumber);
        await bot.deleteMessage(chatId, checkingMsg.message_id);

        if (result.success) {
            await bot.sendMessage(chatId, result.message);
        } else {
            await bot.sendMessage(chatId, result.message);
        }
    } catch (err) {
        logger.error(`Error checking OTP for ${phoneNumber}:`, err.message);
        await bot.deleteMessage(chatId, checkingMsg.message_id);
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
}

// ===== RUNTIME STATES =====

async function handleRuntimeStates(bot, msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text;
    const isAdmin = config.admins.includes(userId);

    // ===== CANCEL ALL =====
    if (text === '/start' || text === '/cancel') {
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
        return false;
    }

    // ===== TOKEN ADDITION =====
    if (state.runtime.waitingAddToken === userId && isAdmin) {
        if (text === '/cancel') {
            state.runtime.waitingAddToken = null;
            saveState();
            await bot.sendMessage(chatId, "❌ Token addition cancelled.");
            await showAdminMenu(bot, chatId);
            return true;
        }

        const parts = text.split('|');
        if (parts.length === 2) {
            const tokenId = parts[0].trim();
            const token = parts[1].trim();

            if (tokenId && token) {
                const success = otpWatcher.addToken(tokenId, token);
                if (success) {
                    await bot.sendMessage(chatId, `✅ Token ${tokenId} added/updated successfully!`);
                    await showAdminMenu(bot, chatId);
                } else {
                    await bot.sendMessage(chatId, "❌ Failed to add token. Please try again.");
                }
            } else {
                await bot.sendMessage(chatId, "❌ Invalid format. Use: ID|TOKEN");
            }
        } else {
            await bot.sendMessage(chatId, "❌ Invalid format. Use: ID|TOKEN\nExample: 131669|KNqt1LUymTDaFyU6C5sKcPFq74NyL6N7SkbqYzHTee93457c");
        }

        state.runtime.waitingAddToken = null;
        saveState();
        return true;
    }

    // ===== ADD NUMBERS =====
    if (state.runtime.waitingAddNumbers === userId && isAdmin) {
        if (text === '/done') {
            const numbers = state.runtime.addNumberBuffer || [];

            if (numbers.length === 0) {
                await bot.sendMessage(chatId, "❌ No numbers to add. Send numbers first.");
                return true;
            }

            const validNumbers = numbers
                .map(n => n.replace(/[^\d+]/g, ''))
                .filter(n => n.length > 0)
                .map(n => n.startsWith('+') ? n : '+' + n);

            // ===== FIX: ডুপ্লিকেট নাম্বার চেক =====
            const uniqueNumbers = [...new Set(validNumbers)];

            // চেক করা কোন নাম্বার ইতিমধ্যে available বা assigned আছে কিনা
            const existingNumbers = new Set([
                ...state.availableNumbers,
                ...Object.keys(state.numberOwners)
            ]);

            const newNumbers = uniqueNumbers.filter(n => !existingNumbers.has(n));
            const duplicateCount = uniqueNumbers.length - newNumbers.length;

            if (newNumbers.length === 0) {
                await bot.sendMessage(
                    chatId,
                    `❌ No new numbers to add. All ${uniqueNumbers.length} number(s) already exist.\n` +
                    `(Available: ${state.availableNumbers.length}, Assigned: ${Object.keys(state.numberOwners).length})`
                );
                state.runtime.addNumberBuffer = [];
                state.runtime.waitingAddNumbers = null;
                saveState();
                return true;
            }

            state.availableNumbers.push(...newNumbers);
            state.runtime.addNumberBuffer = [];
            state.runtime.waitingAddNumbers = null;
            saveState();

            let msg = `✅ Added ${newNumbers.length} new number(s) successfully!`;
            if (duplicateCount > 0) {
                msg += `\n⚠️ Skipped ${duplicateCount} duplicate number(s).`;
            }
            await bot.sendMessage(chatId, msg);
            await showAdminMenu(bot, chatId);
            return true;
        }

        if (text === '/cancel') {
            state.runtime.addNumberBuffer = [];
            state.runtime.waitingAddNumbers = null;
            saveState();
            await bot.sendMessage(chatId, "❌ Number addition cancelled.");
            await showAdminMenu(bot, chatId);
            return true;
        }

        const numbers = text.split("\n").map(n => n.trim()).filter(n => n.length > 0);

        if (numbers.length === 0) {
            await bot.sendMessage(chatId, "❌ Please send valid phone numbers (one per line).\nType /done when finished.");
            return true;
        }

        if (!state.runtime.addNumberBuffer) {
            state.runtime.addNumberBuffer = [];
        }
        state.runtime.addNumberBuffer.push(...numbers);
        saveState();

        await bot.sendMessage(
            chatId,
            `✅ Added ${numbers.length} number(s) to buffer.\n` +
            `Total in buffer: ${state.runtime.addNumberBuffer.length}\n` +
            `Continue adding or type /done to finish.`
        );
        return true;
    }

    // ===== CHANNEL ID =====
    if (state.runtime.waitingChannelId === userId && isAdmin) {
        state.settings.withdrawChannelId = text.trim();
        state.runtime.waitingChannelId = null;
        saveState();

        await bot.sendMessage(chatId, `✅ Channel ID set to: ${text.trim()}`);
        await showAdminMenu(bot, chatId);
        return true;
    }

    // ===== BROADCAST =====
    if (state.runtime.waitingBroadcast === userId && isAdmin) {
        if (text === '/cancel') {
            state.runtime.waitingBroadcast = null;
            state.runtime.broadcastMessage = null;
            state.runtime.broadcastUserCount = null;
            saveState();
            await bot.sendMessage(chatId, "❌ Broadcast cancelled.");
            await showAdminMenu(bot, chatId);
            return true;
        }

        if (text.startsWith('/')) {
            await bot.sendMessage(chatId,
                "❌ You are in broadcast mode. Please send a broadcast message or type /cancel to cancel."
            );
            return true;
        }

        const menuButtons = ["📊", "📋", "🌍", "👥", "⚙️", "📢", "🗑️", "🧹", "📡", "🔑", "🔄", "🔍"];
        if (menuButtons.some(emoji => text.startsWith(emoji))) {
            await bot.sendMessage(chatId,
                "❌ You are in broadcast mode. Please send a broadcast message or type /cancel to cancel."
            );
            return true;
        }

        const broadcastMsg = text;
        const userCount = Object.keys(state.users).length;

        const preview =
            `📢 *Broadcast Preview*\n\n` +
            `📝 Message:\n${broadcastMsg}\n\n` +
            `👥 Recipients: ${userCount} user(s)\n\n` +
            `⚠️ This will send this message to ALL users.\n\n` +
            `Type *confirm* to send, or *cancel* to abort.`;

        state.runtime.broadcastMessage = broadcastMsg;
        state.runtime.broadcastUserCount = userCount;
        state.runtime.waitingBroadcastConfirm = userId;
        state.runtime.waitingBroadcast = null;
        saveState();

        await bot.sendMessage(chatId, preview, { parse_mode: "Markdown" });
        return true;
    }

    // ===== BROADCAST CONFIRMATION =====
    if (state.runtime.waitingBroadcastConfirm === userId && isAdmin) {
        if (text.toLowerCase() === "confirm") {
            const broadcastMsg = state.runtime.broadcastMessage;
            const userCount = state.runtime.broadcastUserCount || Object.keys(state.users).length;

            if (!broadcastMsg) {
                await bot.sendMessage(chatId, "❌ No broadcast message found.");
                state.runtime.waitingBroadcastConfirm = null;
                saveState();
                return true;
            }

            let sent = 0;
            for (const uid of Object.keys(state.users)) {
                try {
                    await bot.sendMessage(uid, `📢 ${broadcastMsg}`);
                    sent++;
                } catch (err) {
                    logger.error(`Failed to send broadcast to ${uid}:`, err.message);
                }
            }

            state.runtime.broadcastMessage = null;
            state.runtime.broadcastUserCount = null;
            state.runtime.waitingBroadcast = null;
            state.runtime.waitingBroadcastConfirm = null;
            saveState();

            await bot.sendMessage(chatId, `✅ Broadcast sent to ${sent}/${userCount} users!`);
            await showAdminMenu(bot, chatId);
            return true;
        } else if (text.toLowerCase() === "cancel") {
            state.runtime.broadcastMessage = null;
            state.runtime.broadcastUserCount = null;
            state.runtime.waitingBroadcast = null;
            state.runtime.waitingBroadcastConfirm = null;
            saveState();
            await bot.sendMessage(chatId, "❌ Broadcast cancelled.");
            await showAdminMenu(bot, chatId);
            return true;
        } else {
            await bot.sendMessage(chatId, "❌ Type *confirm* to send or *cancel* to abort.");
            return true;
        }
    }

    // ===== CONFIRMATION HANDLER =====
    if (state.runtime.waitingConfirmation && isAdmin) {
        const action = state.runtime.pendingAction;

        if (text.toLowerCase() === "confirm") {
            switch (action) {
                case "erase_number":
                    state.availableNumbers = [];
                    await bot.sendMessage(chatId, "✅ All available numbers have been erased.");
                    break;
                case "erase_assigned":
                    state.assignedNumbers = {};
                    state.numberOwners = {};
                    await bot.sendMessage(chatId, "✅ All assigned numbers have been erased.");
                    break;
                case "clear_stats":
                    state.userStats = {};
                    await bot.sendMessage(chatId, "✅ All user statistics have been cleared.");
                    break;
                case "reset_all":
                    const keepChannelId = state.settings.withdrawChannelId;
                    state.assignedNumbers = {};
                    state.numberOwners = {};
                    state.userStats = {};
                    state.availableNumbers = [];
                    state.lastOtpByNumber = {};
                    state.lastProcessedMessage = {};
                    state.lastGetNumber = {};
                    state.runtime = {
                        waitingAddNumbers: null,
                        waitingBroadcast: null,
                        waitingChannelId: null,
                        waitingRemoveUsers: null,
                        waitingRemoveUserSingle: null,
                        waitingSingleStats: null,
                        waitingTestOtp: null,
                        waitingTestMessage: null,
                        waitingAddToken: null,
                        selectedUsersForRemoval: [],
                        addNumberBuffer: [],
                        activeToken: 0,
                        lastFetch: null,
                        otpAttempts: {},
                        lastOtpCheck: {},
                        waitingConfirmation: false,
                        pendingAction: null,
                        broadcastMessage: null,
                        broadcastUserCount: null,
                        waitingBroadcastConfirm: null,
                        waitingRateLimit: null
                    };
                    state.settings.withdrawChannelId = keepChannelId;
                    await bot.sendMessage(chatId, "✅ Bot has been reset successfully!\nUsers, pending users, and channel ID preserved.");
                    break;
                default:
                    await bot.sendMessage(chatId, "❌ Unknown action.");
            }

            saveState();
            state.runtime.waitingConfirmation = false;
            state.runtime.pendingAction = null;
            saveState();
            await showAdminMenu(bot, chatId);
            return true;
        } else if (text.toLowerCase() === "cancel") {
            state.runtime.waitingConfirmation = false;
            state.runtime.pendingAction = null;
            saveState();
            await bot.sendMessage(chatId, "❌ Action cancelled.");
            await showAdminMenu(bot, chatId);
            return true;
        } else {
            await bot.sendMessage(chatId, "❌ Type *confirm* to proceed or *cancel* to abort.", { parse_mode: "Markdown" });
            return true;
        }
    }

    // ===== TEST MESSAGE =====
    if (state.runtime.waitingTestMessage === userId && isAdmin) {
        const parts = text.split('|');
        if (parts.length === 2) {
            const targetUserId = parts[0].trim();
            const testMessage = parts[1].trim();

            try {
                await bot.sendMessage(targetUserId, `🧪 Test Message: ${testMessage}`);
                await bot.sendMessage(chatId, `✅ Test message sent to ${targetUserId}`);
            } catch (err) {
                await bot.sendMessage(chatId, `❌ Failed to send message: ${err.message}`);
            }
        } else {
            await bot.sendMessage(chatId, "❌ Invalid format. Use: USER_ID|MESSAGE");
        }
        state.runtime.waitingTestMessage = null;
        saveState();
        await showAdminMenu(bot, chatId);
        return true;
    }
    // ===== ADD: নতুন কেস handleOtpLogChannel সেট করার জন্য =====

    if (state.runtime.waitingOtpLogChannelId === userId && isAdmin) {
        state.settings.otpLogChannelId = text.trim();
        state.runtime.waitingOtpLogChannelId = null;
        saveState();

        await bot.sendMessage(chatId, `✅ OTP Log Channel ID set to: ${text.trim()}`);
        await showAdminMenu(bot, chatId);
        return true;
    }

    return false;
}

// ===== CONFIRMATION FUNCTION =====

async function showConfirmation(bot, chatId, action, message) {
    state.runtime.pendingAction = action;
    state.runtime.waitingConfirmation = true;
    saveState();

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

// ===== MENU COMMANDS =====

async function handleMenuCommands(bot, msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text;
    const isAdmin = config.admins.includes(userId);
    const isApproved = state.users[userId] !== undefined;

    if (!isAdmin && !isApproved && text !== "📝 Join Request") {
        return bot.sendMessage(chatId, "⚠️ Please send a join request first.");
    }

    switch (text) {
        case "📱 Get Number":
            await handleGetNumber(bot, chatId, userId);
            break;
        case "📝 Join Request":
            await handleJoinRequest(bot, msg);
            break;
        case "ℹ️ Your Info":
            await handleYourInfo(bot, chatId, userId);
            break;
        case "💰 Withdraw OTP":
            await handleWithdraw(bot, chatId, userId);
            break;

        // ===== handleMenuCommands ফাংশনে এই কেস যোগ/আপডেট করুন =====

        case "📡 OTP Log Group":
            const groupUsername = config.otpGroupUsername;
            if (!groupUsername) {
                await bot.sendMessage(chatId, "❌ OTP Log Group not configured yet.");
                return;
            }

            // ===== সরাসরি গ্রুপে যাওয়ার বাটন =====
            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: "📡 Join OTP Log Group",
                            url: `https://t.me/${groupUsername}`
                        }
                    ],
                ]
            };

            await bot.sendMessage(
                chatId,
                `📡 Click the button below to join OTP Log Group:`,
                {
                    reply_markup: keyboard
                }
            );
            break;
    }

    if (isAdmin) {
        switch (text) {
            case "➕ Add Number":
                state.runtime.waitingAddNumbers = userId;
                state.runtime.addNumberBuffer = [];
                saveState();
                await bot.sendMessage(
                    chatId,
                    "📱 Send phone numbers (one per line).\n" +
                    "Example: +992123456789\n" +
                    "Type /done when finished.\n" +
                    "Type /cancel to cancel."
                );
                break;

            case "📊 Stats":
                await handleStats(bot, chatId);
                break;

            case "👥 Remove User":
                await handleRemoveUser(bot, chatId);
                break;

            case "📋 Pending List":
                await handlePendingList(bot, chatId, 0);
                break;

            case "👤 User Stats":
                await handleUserStatsList(bot, chatId, 0);
                break;

            case "📢 Broadcast":
                if (state.runtime.waitingBroadcast === userId) {
                    await bot.sendMessage(chatId, "⏳ You are already in broadcast mode. Please send your message or type /cancel.");
                    break;
                }
                if (state.runtime.waitingBroadcastConfirm === userId) {
                    await bot.sendMessage(chatId, "⏳ You are already in broadcast confirmation. Type *confirm* or *cancel*.");
                    break;
                }
                state.runtime.waitingBroadcast = userId;
                state.runtime.broadcastMessage = null;
                state.runtime.broadcastUserCount = null;
                saveState();
                await bot.sendMessage(chatId, "📨 Send the broadcast message:\n\nType /cancel to cancel.");
                break;

            case "🗑️ Erase Number":
                await showConfirmation(bot, chatId, "erase_number",
                    "⚠️ *Confirm Erase Number*\n\n" +
                    "This will delete ALL available numbers.\n\n" +
                    "Type *confirm* to proceed, or *cancel* to abort."
                );
                break;

            case "🧹 Erase Assigned":
                await showConfirmation(bot, chatId, "erase_assigned",
                    "⚠️ *Confirm Erase Assigned*\n\n" +
                    "This will delete ALL assigned numbers.\n\n" +
                    "Type *confirm* to proceed, or *cancel* to abort."
                );
                break;

            case "📊 Clear User Stats":
                await showConfirmation(bot, chatId, "clear_stats",
                    "⚠️ *Confirm Clear User Stats*\n\n" +
                    "This will delete ALL user statistics.\n\n" +
                    "Type *confirm* to proceed, or *cancel* to abort."
                );
                break;

            case "🧹 Clear Single Stats":
                await handleClearSingleStats(bot, chatId);
                break;

            case "⚙️ On/Off":
                state.settings.botEnabled = !state.settings.botEnabled;
                saveState();
                const status = state.settings.botEnabled ? "🟢 Online" : "🔴 Offline";
                await bot.sendMessage(chatId, `✅ Bot is now ${status}`);
                break;

            case "💰 Withdraw On/Off":
                state.settings.withdrawEnabled = !state.settings.withdrawEnabled;
                saveState();
                const wStatus = state.settings.withdrawEnabled ? "🟢 Enabled" : "🔴 Disabled";
                await bot.sendMessage(chatId, `✅ Withdraw is now ${wStatus}`);
                break;

            case "📡 Set Channel ID":
                state.runtime.waitingChannelId = userId;
                saveState();
                await bot.sendMessage(chatId, "📡 Send the channel ID (e.g., -1001234567890)\nType /cancel to cancel.");
                break;

            case "📡 API Status":
                await handleApiStatus(bot, chatId);
                break;

            case "🔑 Manage Tokens":
                await handleManageTokens(bot, chatId);
                break;

            case "🔄 Rotate Token":
                const rotated = otpWatcher.rotateToken();
                if (rotated) {
                    await bot.sendMessage(chatId, `✅ Rotated to token ${rotated.id}`);
                } else {
                    await bot.sendMessage(chatId, "❌ No active tokens available");
                }
                await showAdminMenu(bot, chatId);
                break;

            case "⏱️ Set Rate Limit":
                state.runtime.waitingRateLimit = userId;
                saveState();
                const currentRate = state.rateLimit || 15;
                await bot.sendMessage(
                    chatId,
                    `⏱️ *Set Rate Limit*\n\n` +
                    `Current Rate Limit: ${currentRate} seconds\n\n` +
                    `Enter new value in seconds (e.g., 5, 10, 15, 20, 30):\n\n` +
                    `Type /cancel to cancel.`
                );
                break;

            case "🔄 Sync Numbers":
                await handleSyncNumbers(bot, chatId);
                break;

            case "🧹 Clean Orphans":
                const cleaned = cleanupOrphanedNumbers();
                saveState();
                const msgClean = cleaned === 0 ? "✅ No orphaned numbers found!" : `✅ Cleaned ${cleaned} orphaned number(s)!`;
                await bot.sendMessage(chatId, msgClean);
                await showAdminMenu(bot, chatId);
                break;

            case "🔍 Test Message":
                state.runtime.waitingTestMessage = userId;
                saveState();
                await bot.sendMessage(chatId, "📨 Send the user ID and message:\nFormat: USER_ID|MESSAGE");
                break;

            case "🔄 Reset":
                await showConfirmation(bot, chatId, "reset_all",
                    "⚠️ *Confirm Reset*\n\n" +
                    "This will reset:\n" +
                    "❌ All assigned numbers\n" +
                    "❌ All number owners\n" +
                    "❌ All user stats\n" +
                    "❌ All available numbers\n" +
                    "❌ All OTP data\n\n" +
                    "✅ This will keep:\n" +
                    "✅ Users\n" +
                    "✅ Pending users\n" +
                    "✅ Channel ID\n" +
                    "✅ Tokens\n\n" +
                    "Type *confirm* to proceed, or *cancel* to abort."
                );
                break;
            case "📡 Set OTP Log Channel":
                state.runtime.waitingOtpLogChannelId = userId;
                saveState();
                await bot.sendMessage(
                    chatId,
                    "📡 Send the OTP Log Channel ID (e.g., -1001234567890)\n" +
                    "All OTPs will be forwarded to this channel with masked numbers.\n" +
                    "Type /cancel to cancel."
                );
                break;
        }
    }
}

// ===== USER COMMAND HANDLERS =====

async function handleGetNumber(bot, chatId, userId) {
    const rateLimit = state.rateLimit || 15;
    const now = Date.now();
    const lastRequest = state.lastGetNumber[userId] || 0;
    const timeDiff = (now - lastRequest) / 1000;

    if (timeDiff < rateLimit && !config.admins.includes(userId)) {
        const remaining = Math.ceil(rateLimit - timeDiff);
        return bot.sendMessage(
            chatId,
            `⏳ *Too early request!*\n\n` +
            `Please wait *${remaining} seconds* before requesting another number.\n\n` +
            `📱 You can get a new number after ${remaining}s.`,
            { parse_mode: "Markdown" }
        );
    }

    if (state.availableNumbers.length === 0) {
        return bot.sendMessage(chatId, "❌ No numbers available at the moment.");
    }

    const number = state.availableNumbers.shift();
    const assigned = state.assignedNumbers[userId] || [];
    state.assignedNumbers[userId] = [...assigned, number];
    state.numberOwners[number] = userId;

    if (!state.userStats[userId]) {
        state.userStats[userId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
    }
    state.userStats[userId].assigned += 1;

    state.lastGetNumber[userId] = Date.now();
    saveState();

    logger.info(`📱 Assigned number ${number} to user ${userId}`);

    await bot.sendMessage(
        chatId,
        `📱 *Number assigned*\n\n\`${number}\``,
        { parse_mode: "Markdown" }
    );
}

async function handleJoinRequest(bot, msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const user = msg.from;

    if (state.users[userId]) {
        return bot.sendMessage(chatId, "✅ You are already approved!");
    }

    if (state.pendingUsers[userId] && state.pendingUsers[userId].status === "pending") {
        return bot.sendMessage(chatId, "⏳ Your request is already pending approval.");
    }

    state.pendingUsers[userId] = {
        id: userId,
        profileName: user.first_name || "User",
        username: user.username || "",
        status: "pending"
    };
    saveState();

    await bot.sendMessage(chatId, "✅ Join request sent! Please wait for admin approval.");

    const userInfo = `${user.first_name || "User"} (@${user.username || "No username"})`;
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Approve", callback_data: `approve_${userId}` },
                    { text: "❌ Reject", callback_data: `reject_${userId}` }
                ]
            ]
        }
    };

    for (const adminId of config.admins) {
        try {
            await bot.sendMessage(
                adminId,
                `📝 New Join Request\n\nUser: ${userInfo}\nID: ${userId}`,
                keyboard
            );
        } catch (err) {
            logger.error(`Failed to send join request to admin ${adminId}:`, err.message);
        }
    }
}

async function handleYourInfo(bot, chatId, userId) {
    const user = state.users[userId];
    if (!user) {
        return bot.sendMessage(chatId, "❌ User not found.");
    }

    const stats = state.userStats[userId] || { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
    const assignedNumbers = state.assignedNumbers[userId] || [];

    await bot.sendMessage(
        chatId,
        `📋 *Your Info*\n\n` +
        `🆔 *User ID:* ${userId}\n` +
        `👤 *Name:* ${user.profileName || "Unknown"}\n` +
        `📱 *Username:* @${user.username || "N/A"}\n` +
        `🔢 *Total assigned numbers:* ${assignedNumbers.length}\n` +
        `✅ *Total successful OTPs:* ${stats.successOtp || 0}\n` +
        `❌ *No OTPs:* ${stats.noOtp || 0}\n` +
        `💰 *Withdrawals:* ${stats.withdrawCount || 0}`,
        { parse_mode: "Markdown" }
    );
}

async function handleWithdraw(bot, chatId, userId) {
    if (!state.settings.withdrawEnabled) {
        return bot.sendMessage(chatId, "❌ Withdrawal is currently disabled.");
    }

    if (!state.settings.withdrawChannelId) {
        return bot.sendMessage(chatId, "❌ Withdrawal channel not configured.");
    }

    const user = state.users[userId];
    if (!user) {
        return bot.sendMessage(chatId, "❌ User not found.");
    }

    const stats = state.userStats[userId] || { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
    const totalOTPs = stats.successOtp || 0;

    if (totalOTPs === 0) {
        return bot.sendMessage(chatId, "❌ No OTPs to withdraw.");
    }

    stats.successOtp = 0;
    stats.withdrawCount = (stats.withdrawCount || 0) + 1;
    saveState();

    const now = new Date();
    const dateStr = now.toLocaleString();

    const message =
        `💰 *Withdrawal Request*\n\n` +
        `👤 *Name:* ${user.profileName || "Unknown"}\n` +
        `🆔 *User ID:* ${userId}\n` +
        `🔢 *Total OTPs:* ${totalOTPs}\n` +
        `📅 *Date:* ${dateStr}`;

    try {
        await bot.sendMessage(state.settings.withdrawChannelId, message, { parse_mode: "Markdown" });
        await bot.sendMessage(chatId, `✅ Withdrawal of ${totalOTPs} OTP(s) submitted successfully!`);
    } catch (err) {
        logger.error("Failed to send withdrawal to channel:", err.message);
        await bot.sendMessage(chatId, "❌ Failed to submit withdrawal. Please try again later.");
    }
}

// ===== ADMIN COMMAND HANDLERS =====

async function handleStats(bot, chatId) {
    const totalUsers = Object.keys(state.users).length;
    const totalPending = Object.keys(state.pendingUsers).filter(id => state.pendingUsers[id].status === "pending").length;
    const totalNumbers = state.availableNumbers.length;
    const totalAssigned = Object.keys(state.assignedNumbers).reduce((sum, id) => sum + state.assignedNumbers[id].length, 0);
    const totalOwners = Object.keys(state.numberOwners).length;

    let totalOtps = 0;
    for (const userId of Object.keys(state.userStats)) {
        totalOtps += state.userStats[userId].successOtp || 0;
    }

    await bot.sendMessage(
        chatId,
        `📊 *Bot Statistics*\n\n` +
        `👥 Total Users: ${totalUsers}\n` +
        `⏳ Pending Requests: ${totalPending}\n` +
        `📱 Available Numbers: ${totalNumbers}\n` +
        `🔢 Assigned Numbers (total): ${totalAssigned}\n` +
        `🔗 Number Owners: ${totalOwners}\n` +
        `✅ Total OTPs: ${totalOtps}\n` +
        `🟢 Bot Status: ${state.settings.botEnabled ? "Online" : "Offline"}\n` +
        `💰 Withdraw Status: ${state.settings.withdrawEnabled ? "Enabled" : "Disabled"}`,
        { parse_mode: "Markdown" }
    );
}

async function handleUserStatsList(bot, chatId, page) {
    const allUsers = Object.keys(state.users);

    if (allUsers.length === 0) {
        return bot.sendMessage(chatId, "❌ No users found.");
    }

    const perPage = 10;
    const totalPages = Math.ceil(allUsers.length / perPage);
    const start = page * perPage;
    const end = Math.min(start + perPage, allUsers.length);
    const pageUsers = allUsers.slice(start, end);

    let message = `📊 *User Stats* (Page ${page + 1}/${totalPages})\n\n`;

    for (const userId of pageUsers) {
        const user = state.users[userId];
        const stats = state.userStats[userId] || { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
        const assignedNumbers = state.assignedNumbers[userId] || [];
        const isAdmin = config.admins.includes(userId);

        message += `👤 *${user.profileName || "Unknown"}*`;
        if (isAdmin) message += ` 👑 Admin`;
        message += `\n`;
        message += `🆔 ID: \`${userId}\`\n`;
        message += `📋 Assigned: ${assignedNumbers.length}\n`;
        message += `✅ OTPs: ${stats.successOtp || 0}\n`;
        message += `❌ No OTPs: ${stats.noOtp || 0}\n`;
        message += `💰 Withdrawals: ${stats.withdrawCount || 0}\n\n`;
    }

    const keyboard = {
        inline_keyboard: []
    };

    const navButtons = [];
    if (page > 0) {
        navButtons.push({ text: "◀️ Previous", callback_data: `userstats_page_${page - 1}` });
    }
    if (page < totalPages - 1) {
        navButtons.push({ text: "Next ▶️", callback_data: `userstats_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
        keyboard.inline_keyboard.push(navButtons);
    }
    keyboard.inline_keyboard.push([
        { text: "❌ Close", callback_data: "close_userstats" }
    ]);

    await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

async function handleRemoveUser(bot, chatId) {
    const users = Object.keys(state.users);

    if (users.length === 0) {
        return bot.sendMessage(chatId, "❌ No users to remove.");
    }

    await showUserListForRemoval(bot, chatId, 0);
}

async function showUserListForRemoval(bot, chatId, page, messageId = null) {
    const users = Object.keys(state.users);
    const perPage = 5;
    const totalPages = Math.ceil(users.length / perPage);
    const start = page * perPage;
    const end = Math.min(start + perPage, users.length);
    const pageUsers = users.slice(start, end);

    let message = "👥 *Select users to remove*\n\n";
    const selected = state.runtime.selectedUsersForRemoval || [];

    for (const userId of pageUsers) {
        const user = state.users[userId];
        const isSelected = selected.includes(userId);
        message += `${isSelected ? "☑️" : "⬜"} ${user.profileName || "Unknown"} (${userId})\n`;
    }

    message += `\nPage ${page + 1}/${totalPages}`;
    message += `\nSelected: ${selected.length} user(s)`;

    const keyboard = {
        inline_keyboard: []
    };

    for (const userId of pageUsers) {
        const user = state.users[userId];
        const isSelected = selected.includes(userId);
        keyboard.inline_keyboard.push([
            {
                text: `${isSelected ? "☑️" : "⬜"} ${user.profileName || "Unknown"}`,
                callback_data: `select_user_${userId}`
            }
        ]);
    }

    const navButtons = [];
    if (page > 0) {
        navButtons.push({ text: "◀️", callback_data: `remove_page_${page - 1}` });
    }
    if (page < totalPages - 1) {
        navButtons.push({ text: "▶️", callback_data: `remove_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
        keyboard.inline_keyboard.push(navButtons);
    }

    const actionButtons = [];
    if (selected.length > 0) {
        actionButtons.push({ text: "🗑️ Remove Selected", callback_data: "remove_selected_users" });
    }
    actionButtons.push({ text: "❌ Cancel", callback_data: "cancel_remove_users" });
    keyboard.inline_keyboard.push(actionButtons);

    if (messageId) {
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    } else {
        await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }
}

async function handlePendingList(bot, chatId, page, messageId = null) {
    const pendingUsers = Object.keys(state.pendingUsers).filter(
        id => state.pendingUsers[id].status === "pending" ||
            state.pendingUsers[id].status === "rejected" ||
            state.pendingUsers[id].status === "removed"
    );

    if (pendingUsers.length === 0) {
        const msg = "📋 No pending users.";
        if (messageId) {
            await bot.editMessageText(msg, { chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, msg);
        }
        return;
    }

    const perPage = 5;
    const totalPages = Math.ceil(pendingUsers.length / perPage);
    const start = page * perPage;
    const end = Math.min(start + perPage, pendingUsers.length);
    const pageUsers = pendingUsers.slice(start, end);

    let message = "📋 *Pending Users*\n\n";

    for (const userId of pageUsers) {
        const user = state.pendingUsers[userId];
        const statusEmoji = user.status === "pending" ? "⏳" : user.status === "rejected" ? "❌" : "🚫";
        message += `${statusEmoji} ${user.profileName || "Unknown"} (${userId}) - ${user.status}\n`;
    }

    message += `\nPage ${page + 1}/${totalPages}`;

    const keyboard = {
        inline_keyboard: []
    };

    for (const userId of pageUsers) {
        const user = state.pendingUsers[userId];
        keyboard.inline_keyboard.push([
            {
                text: `${user.profileName || "Unknown"}`,
                callback_data: `pending_user_${userId}`
            }
        ]);
    }

    const navButtons = [];
    if (page > 0) {
        navButtons.push({ text: "◀️", callback_data: `pending_page_${page - 1}` });
    }
    if (page < totalPages - 1) {
        navButtons.push({ text: "▶️", callback_data: `pending_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
        keyboard.inline_keyboard.push(navButtons);
    }

    keyboard.inline_keyboard.push([
        { text: "❌ Close", callback_data: "close_pending" }
    ]);

    if (messageId) {
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    } else {
        await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }
}

async function handleClearSingleStats(bot, chatId) {
    const users = Object.keys(state.users);

    if (users.length === 0) {
        return bot.sendMessage(chatId, "❌ No users to clear stats for.");
    }

    await showUserListForStats(bot, chatId, 0);
}

async function showUserListForStats(bot, chatId, page, messageId = null) {
    const users = Object.keys(state.users);
    const perPage = 5;
    const totalPages = Math.ceil(users.length / perPage);
    const start = page * perPage;
    const end = Math.min(start + perPage, users.length);
    const pageUsers = users.slice(start, end);

    let message = "👤 *Select user to clear stats*\n\n";

    for (const userId of pageUsers) {
        const user = state.users[userId];
        const stats = state.userStats[userId] || { assigned: 0, successOtp: 0, noOtp: 0 };
        message += `${user.profileName || "Unknown"} (${userId})\n`;
        message += `  OTPs: ${stats.successOtp || 0}\n\n`;
    }

    message += `Page ${page + 1}/${totalPages}`;

    const keyboard = {
        inline_keyboard: []
    };

    for (const userId of pageUsers) {
        const user = state.users[userId];
        keyboard.inline_keyboard.push([
            {
                text: `🧹 ${user.profileName || "Unknown"}`,
                callback_data: `clear_stats_user_${userId}`
            }
        ]);
    }

    const navButtons = [];
    if (page > 0) {
        navButtons.push({ text: "◀️", callback_data: `stats_page_${page - 1}` });
    }
    if (page < totalPages - 1) {
        navButtons.push({ text: "▶️", callback_data: `stats_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
        keyboard.inline_keyboard.push(navButtons);
    }

    keyboard.inline_keyboard.push([
        { text: "❌ Cancel", callback_data: "cancel_stats" }
    ]);

    if (messageId) {
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    } else {
        await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }
}

async function handleApiStatus(bot, chatId) {
    try {
        const status = await otpWatcher.getApiStatus();

        let message = `📊 *API Status*\n\n`;

        if (status.overallStatus === 'online') {
            message += `🟢 *Online* - API is working\n`;
        } else {
            message += `🔴 *Offline* - No active tokens available\n`;
        }

        message += `\n📋 *Token Details:*\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

        for (const token of status.tokenDetails) {
            const statusIcon = token.active && !token.limited ? '🟢' : (token.active ? '🟡' : '🔴');
            const statusText = token.active && !token.limited ? 'Active' : (token.active ? 'Limited' : 'Inactive');

            message += `${statusIcon} *Token ${token.index}* (${token.id})\n`;
            message += `   Status: ${statusText}\n`;
            message += `   Errors: ${token.errorCount}\n`;
            message += `   Records: ${token.totalFetched}\n`;
            message += `   Requests/min: ${token.requestsThisMinute}\n`;
            message += `   Last Success: ${token.lastSuccess}\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
        }

        message += `\n📊 *Summary:*\n`;
        message += `   Active Tokens: ${status.activeTokens}/${status.totalTokens}\n`;
        message += `   Total Records: ${status.totalRecords}\n`;

        if (status.activeTokens === 0) {
            message += `\n💡 *Tip:* No tokens are active. Use "🔑 Manage Tokens" to add tokens.`;
        }

        await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
        logger.error("API Status error:", err.message);
        await bot.sendMessage(chatId, `❌ Failed to get API status: ${err.message}`);
    }
}

async function handleManageTokens(bot, chatId) {
    try {
        const tokenStatus = otpWatcher.getTokenStatus();

        let message = `🔑 *Token Management*\n\n`;

        if (tokenStatus.length === 0) {
            message += `No tokens configured.\n\n`;
        } else {
            message += `*Current Tokens:*\n`;
            for (const token of tokenStatus) {
                const statusIcon = token.active ? '🟢' : '🔴';
                const statusText = token.active ? 'Active' : 'Invalid';
                message += `${statusIcon} Token ${token.id}: ${statusText}\n`;
                message += `   Errors: ${token.errorCount}\n`;
                message += `   Last Checked: ${token.lastChecked}\n\n`;
            }
        }

        message += `\n*Available Actions:*\n`;
        message += `➕ Add Token - Add or update a token\n`;
        message += `🗑️ Remove Token - Remove a token\n`;
        message += `🔄 Rotate Token - Switch to next token\n\n`;
        message += `💡 When a token is invalid, you'll be notified automatically.`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: "➕ Add Token", callback_data: "add_token" },
                    { text: "🗑️ Remove Token", callback_data: "remove_token" }
                ],
                [
                    { text: "🔄 Rotate Token", callback_data: "rotate_token" },
                    { text: "📊 Token Status", callback_data: "token_status" }
                ],
                [
                    { text: "❌ Close", callback_data: "close_tokens" }
                ]
            ]
        };

        await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    } catch (err) {
        logger.error("Manage tokens error:", err.message);
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
}

async function handleSyncNumbers(bot, chatId) {
    const syncMsg = await bot.sendMessage(chatId, "🔄 Syncing numbers from all API tokens... Please wait.");

    try {
        const allNumbers = [];
        const tokens = config.api.tokens || [];

        for (let i = 0; i < tokens.length; i++) {
            const tokenString = tokens[i];
            const parts = tokenString.split('|');
            const tokenId = parts[0] || `token_${i + 1}`;
            const token = parts.slice(1).join('|') || tokenString;

            try {
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 7);

                const url = new URL(config.api.baseUrl);
                url.searchParams.append('type', 'sms');
                url.searchParams.append('stock_account', '0');
                url.searchParams.append('perPage', '50');
                url.searchParams.append('page', '1');
                url.searchParams.append('sortColumn', 'created_at');
                url.searchParams.append('sortDirection', 'desc');
                url.searchParams.append('period[0]', startDate.toISOString());
                url.searchParams.append('period[1]', endDate.toISOString());

                const response = await fetch(url.toString(), {
                    headers: {
                        'accept': 'application/json',
                        'authorization': `Bearer ${token}`,
                        'content-type': 'application/json'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.data && data.data.length > 0) {
                        const numbers = data.data.map(r => {
                            let num = (r.b_number || r.number || r.phone || '').replace(/[^\d+]/g, '');
                            if (!num.startsWith('+')) num = '+' + num;
                            return num;
                        });
                        allNumbers.push(...numbers);
                        await bot.sendMessage(chatId, `✅ Token ${tokenId}: found ${numbers.length} numbers`);
                    }
                }
            } catch (err) {
                await bot.sendMessage(chatId, `❌ Error in Token ${tokenId}: ${err.message}`);
            }
        }

        const uniqueNumbers = [...new Set(allNumbers)];
        let added = 0;

        for (const number of uniqueNumbers) {
            if (!state.availableNumbers.includes(number) && !state.numberOwners[number]) {
                state.availableNumbers.push(number);
                added++;
            }
        }

        if (added > 0) {
            saveState();
            await bot.sendMessage(chatId, `✅ Added ${added} new numbers to available pool!\n📊 Total available: ${state.availableNumbers.length}`);
        } else {
            await bot.sendMessage(chatId, `ℹ️ No new numbers to add. All ${uniqueNumbers.length} numbers already exist.`);
        }

        const summary =
            `📊 *Sync Summary*\n\n` +
            `Total numbers in API: ${uniqueNumbers.length}\n` +
            `Available numbers in bot: ${state.availableNumbers.length}\n` +
            `Assigned numbers: ${Object.keys(state.numberOwners).length}\n` +
            `Total users: ${Object.keys(state.users).length}`;

        await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });
    } catch (err) {
        await bot.sendMessage(chatId, `❌ Sync failed: ${err.message}`);
    }

    await bot.deleteMessage(chatId, syncMsg.message_id);
}

async function showAdminMenu(bot, chatId) {
    const keyboard = [
        ["📱 Get Number", "➕ Add Number"],
        ["📊 Stats", "👥 Remove User"],
        ["📋 Pending List", "👤 User Stats"],
        ["📢 Broadcast", "🗑️ Erase Number"],
        ["🧹 Erase Assigned", "📊 Clear User Stats"],
        ["🧹 Clear Single Stats", "⚙️ On/Off"],
        ["💰 Withdraw On/Off", "📡 Set Channel ID"],
        ["📡 Set OTP Log Channel", "📡 API Status"],  // NEW
        ["🔑 Manage Tokens", "🔄 Rotate Token"],
        ["⏱️ Set Rate Limit", "🔄 Sync Numbers"],
        ["🧹 Clean Orphans", "🔍 Test Message"],
        ["🔄 Reset"]
    ];

    await bot.sendMessage(chatId, "🔧 Admin Menu", {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true
        }
    });
}

// ===== EXPORT HELPER FUNCTIONS =====
module.exports.showUserListForRemoval = showUserListForRemoval;
module.exports.showUserListForStats = showUserListForStats;
module.exports.handlePendingList = handlePendingList;
module.exports.handleUserStatsList = handleUserStatsList;