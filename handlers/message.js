const { state, saveState, cleanupOrphanedNumbers } = require("../state");
const config = require("../config");
const logger = require("../services/logger");
const otpWatcher = require("../services/otpWatcher");

module.exports = function(bot) {
    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const text = msg.text;
        
        if (!text) return;
        
        if (!state.settings.botEnabled && !config.admins.includes(userId)) {
            return bot.sendMessage(chatId, "⚠️ Bot is currently disabled. Please try again later.");
        }
        
        const handled = await handleRuntimeStates(bot, msg);
        if (handled) return;
        
        await handleMenuCommands(bot, msg);
    });
};

async function handleRuntimeStates(bot, msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text;
    const isAdmin = config.admins.includes(userId);
    
    if (text === '/start' || text === '/cancel') {
        state.runtime.waitingAddNumbers = null;
        state.runtime.waitingBroadcast = null;
        state.runtime.waitingChannelId = null;
        state.runtime.waitingSingleStats = null;
        state.runtime.waitingTestOtp = null;
        state.runtime.waitingTestMessage = null;
        state.runtime.waitingRemoveUserSingle = null;
        state.runtime.addNumberBuffer = [];
        saveState();
        return false;
    }
    
    if (text === '/done' && state.runtime.waitingAddNumbers === userId && isAdmin) {
        const numbers = state.runtime.addNumberBuffer || [];
        
        if (numbers.length === 0) {
            await bot.sendMessage(chatId, "❌ No numbers to add. Send numbers first.");
            return true;
        }
        
        const validNumbers = numbers
            .map(n => n.replace(/[^\d+]/g, ''))
            .filter(n => n.length > 0)
            .map(n => n.startsWith('+') ? n : '+' + n);
        
        const uniqueNumbers = [...new Set(validNumbers)];
        
        if (uniqueNumbers.length === 0) {
            await bot.sendMessage(chatId, "❌ No valid numbers found.");
            state.runtime.addNumberBuffer = [];
            state.runtime.waitingAddNumbers = null;
            saveState();
            return true;
        }
        
        state.availableNumbers.push(...uniqueNumbers);
        state.runtime.addNumberBuffer = [];
        state.runtime.waitingAddNumbers = null;
        saveState();
        
        await bot.sendMessage(chatId, `✅ Added ${uniqueNumbers.length} number(s) successfully!`);
        await showAdminMenu(bot, chatId);
        return true;
    }
    
    if (state.runtime.waitingChannelId === userId && isAdmin) {
        state.settings.withdrawChannelId = text.trim();
        state.runtime.waitingChannelId = null;
        saveState();
        
        await bot.sendMessage(chatId, `✅ Channel ID set to: ${text.trim()}`);
        await showAdminMenu(bot, chatId);
        return true;
    }
    
    if (state.runtime.waitingAddNumbers === userId && isAdmin) {
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
    
    if (state.runtime.waitingBroadcast === userId && isAdmin) {
        const userCount = Object.keys(state.users).length;
        let sent = 0;
        
        for (const uid of Object.keys(state.users)) {
            try {
                await bot.sendMessage(uid, `📢 ${text}`);
                sent++;
            } catch (err) {
                logger.error(`Failed to send broadcast to ${uid}:`, err.message);
            }
        }
        
        state.runtime.waitingBroadcast = null;
        saveState();
        
        await bot.sendMessage(chatId, `✅ Broadcast sent to ${sent}/${userCount} users.`);
        await showAdminMenu(bot, chatId);
        return true;
    }
    
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
    
    return false;
}

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
    }
    
    if (isAdmin) {
        switch (text) {
            case "➕ Add Number":
                state.runtime.waitingAddNumbers = userId;
                state.runtime.addNumberBuffer = [];
                saveState();
                await bot.sendMessage(chatId, "📱 Send phone numbers (one per line).\nType /done when finished.");
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
                state.runtime.waitingBroadcast = userId;
                saveState();
                await bot.sendMessage(chatId, "📨 Send the broadcast message:");
                break;
            case "🗑️ Erase Number":
                state.availableNumbers = [];
                saveState();
                await bot.sendMessage(chatId, "✅ All available numbers have been erased.");
                break;
            case "🧹 Erase Assigned":
                const totalAssigned = Object.keys(state.assignedNumbers).reduce((sum, id) => sum + state.assignedNumbers[id].length, 0);
                state.assignedNumbers = {};
                state.numberOwners = {};
                saveState();
                await bot.sendMessage(chatId, `✅ All assigned numbers (${totalAssigned}) have been erased.`);
                break;
            case "📊 Clear User Stats":
                state.userStats = {};
                saveState();
                await bot.sendMessage(chatId, "✅ All user statistics have been cleared.");
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
            case "🔑 Token Status":
                await handleTokenStatus(bot, chatId);
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
            case "🧹 Clean Orphans":
                const cleaned = cleanupOrphanedNumbers();
                saveState();
                const msg = cleaned === 0 ? "✅ No orphaned numbers found!" : `✅ Cleaned ${cleaned} orphaned number(s)!`;
                await bot.sendMessage(chatId, msg);
                await showAdminMenu(bot, chatId);
                break;
            case "🔍 Test Message":
                state.runtime.waitingTestMessage = userId;
                saveState();
                await bot.sendMessage(chatId, "📨 Send the user ID and message:\nFormat: USER_ID|MESSAGE");
                break;
            case "🔄 Reset":
                state.assignedNumbers = {};
                state.numberOwners = {};
                state.userStats = {};
                state.availableNumbers = [];
                state.lastOtpByNumber = {};
                state.lastProcessedMessage = {};
                state.runtime = {
                    waitingAddNumbers: null,
                    waitingBroadcast: null,
                    waitingChannelId: null,
                    waitingRemoveUsers: null,
                    waitingRemoveUserSingle: null,
                    waitingSingleStats: null,
                    waitingTestOtp: null,
                    waitingTestMessage: null,
                    selectedUsersForRemoval: [],
                    addNumberBuffer: [],
                    activeToken: 0,
                    lastFetch: null,
                    otpAttempts: {},
                    lastOtpCheck: {}
                };
                saveState();
                await bot.sendMessage(chatId, "✅ Bot has been reset successfully!\nUsers and pending users preserved.");
                break;
        }
    }
}

// ===== USER COMMAND HANDLERS =====

async function handleGetNumber(bot, chatId, userId) {
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
    const users = Object.keys(state.users);
    
    if (users.length === 0) {
        return bot.sendMessage(chatId, "❌ No users found.");
    }
    
    const perPage = 10;
    const totalPages = Math.ceil(users.length / perPage);
    const start = page * perPage;
    const end = Math.min(start + perPage, users.length);
    const pageUsers = users.slice(start, end);
    
    let message = `📊 *User Stats* (Page ${page + 1}/${totalPages})\n\n`;
    
    for (const userId of pageUsers) {
        const user = state.users[userId];
        const stats = state.userStats[userId] || { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
        const assignedNumbers = state.assignedNumbers[userId] || [];
        
        message += `👤 *${user.profileName || "Unknown"}*\n`;
        message += `🆔 ID: \`${userId}\`\n`;
        message += `📋 Assigned: ${assignedNumbers.length}\n`;
        message += `✅ OTPs: ${stats.successOtp || 0}\n\n`;
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
        message += `Status: ${status.status === 'online' ? '🟢 Online' : '🔴 Offline'}\n`;
        if (status.status === 'online') {
            message += `📋 Total Records Today: ${status.total || 0}\n`;
            message += `📄 Last Page: ${status.lastPage || 1}\n`;
        } else {
            message += `❌ Error: ${status.error || status.message || 'Unknown'}\n`;
        }
        
        await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to get API status: ${err.message}`);
    }
}

async function handleTokenStatus(bot, chatId) {
    try {
        const status = await otpWatcher.getApiStatus();
        
        let message = `🔑 *API Token Status*\n\n`;
        message += `📊 Total Tokens: ${status.totalTokens}\n`;
        message += `🟢 Active Tokens: ${status.activeTokens}\n`;
        message += `🔴 Inactive Tokens: ${status.inactiveTokens}\n`;
        message += `📋 Total Records: ${status.totalRecords}\n\n`;
        message += `*Token Details:*\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━\n`;
        
        for (const token of status.tokenDetails) {
            const statusIcon = token.active ? '🟢' : '🔴';
            message += `${statusIcon} *Token ${token.index}* (${token.id})\n`;
            message += `   Status: ${token.active ? '✅ Active' : '❌ Inactive'}\n`;
            message += `   Errors: ${token.errorCount}\n`;
            message += `   Records: ${token.totalFetched}\n`;
            message += `   Last Success: ${token.lastSuccess}\n`;
            message += `━━━━━━━━━━━━━━━━━━━━━\n`;
        }
        
        await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to get token status: ${err.message}`);
    }
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
}

// Export helper functions for callback.js
module.exports.showUserListForRemoval = showUserListForRemoval;
module.exports.showUserListForStats = showUserListForStats;
module.exports.handlePendingList = handlePendingList;
module.exports.handleUserStatsList = handleUserStatsList;