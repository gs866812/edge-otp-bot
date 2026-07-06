const { state, saveState } = require("../state");
const config = require("../config");
const logger = require("../services/logger");

const {
    showUserListForRemoval,
    showUserListForStats,
    handlePendingList,
    handleUserStatsList
} = require("./message");

module.exports = function (bot) {
    bot.on("callback_query", async (query) => {
        const chatId = query.message.chat.id;
        const userId = String(query.from.id);
        const data = query.data;

        try {
            await bot.answerCallbackQuery(query.id);

            const isAdmin = config.admins.includes(userId);

            if (data.startsWith("approve_")) {
                if (!isAdmin) {
                    await bot.sendMessage(chatId, "❌ Only admins can approve users.");
                    return;
                }
                const targetUserId = data.replace("approve_", "");
                await handleApprove(bot, chatId, targetUserId, query.message.message_id);
                return;
            }

            if (data.startsWith("reject_")) {
                if (!isAdmin) {
                    await bot.sendMessage(chatId, "❌ Only admins can reject users.");
                    return;
                }
                const targetUserId = data.replace("reject_", "");
                await handleReject(bot, chatId, targetUserId, query.message.message_id);
                return;
            }

            if (data.startsWith("userstats_page_")) {
                if (!isAdmin) return;
                const page = parseInt(data.replace("userstats_page_", ""));
                await handleUserStatsList(bot, chatId, page);
                return;
            }

            if (data === "close_userstats") {
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }

            if (data.startsWith("pending_user_")) {
                if (!isAdmin) return;
                const targetUserId = data.replace("pending_user_", "");
                const user = state.pendingUsers[targetUserId];

                if (!user) {
                    await bot.sendMessage(chatId, "❌ User not found.");
                    return;
                }

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "✅ Approve", callback_data: `approve_${targetUserId}` }],
                        [{ text: "❌ Close", callback_data: "close_pending" }]
                    ]
                };

                await bot.editMessageText(
                    `👤 *User:* ${user.profileName || "Unknown"}\n` +
                    `🆔 *ID:* ${targetUserId}\n` +
                    `📌 *Status:* ${user.status}\n\n` +
                    `Actions:`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: "Markdown",
                        reply_markup: keyboard
                    }
                );
                return;
            }

            if (data.startsWith("pending_page_")) {
                if (!isAdmin) return;
                const page = parseInt(data.replace("pending_page_", ""));
                await handlePendingList(bot, chatId, page, query.message.message_id);
                return;
            }

            if (data.startsWith("remove_page_")) {
                if (!isAdmin) return;
                const page = parseInt(data.replace("remove_page_", ""));
                await showUserListForRemoval(bot, chatId, page, query.message.message_id);
                return;
            }

            if (data.startsWith("select_user_")) {
                if (!isAdmin) return;
                const targetUserId = data.replace("select_user_", "");
                const selected = state.runtime.selectedUsersForRemoval || [];

                if (selected.includes(targetUserId)) {
                    state.runtime.selectedUsersForRemoval = selected.filter(id => id !== targetUserId);
                } else {
                    state.runtime.selectedUsersForRemoval = [...selected, targetUserId];
                }

                saveState();
                await showUserListForRemoval(bot, chatId, 0, query.message.message_id);
                return;
            }

            if (data === "remove_selected_users") {
                if (!isAdmin) return;
                const selected = state.runtime.selectedUsersForRemoval || [];

                if (selected.length === 0) {
                    await bot.sendMessage(chatId, "❌ No users selected.");
                    return;
                }

                let removed = 0;
                for (const targetUserId of selected) {
                    const user = state.users[targetUserId];
                    if (user) {
                        state.pendingUsers[targetUserId] = {
                            ...user,
                            status: "removed"
                        };
                        delete state.users[targetUserId];

                        const assigned = state.assignedNumbers[targetUserId] || [];
                        for (const number of assigned) {
                            delete state.numberOwners[number];
                            state.availableNumbers.push(number);
                        }
                        delete state.assignedNumbers[targetUserId];
                        removed++;
                    }
                }

                state.runtime.selectedUsersForRemoval = [];
                saveState();

                await bot.editMessageText(
                    `✅ Removed ${removed} user(s) successfully!`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
                return;
            }

            if (data === "cancel_remove_users") {
                if (!isAdmin) return;
                state.runtime.selectedUsersForRemoval = [];
                saveState();

                await bot.editMessageText(
                    "❌ User removal cancelled.",
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
                return;
            }

            if (data.startsWith("stats_page_")) {
                if (!isAdmin) return;
                const page = parseInt(data.replace("stats_page_", ""));
                await showUserListForStats(bot, chatId, page, query.message.message_id);
                return;
            }

            if (data.startsWith("clear_stats_user_")) {
                if (!isAdmin) return;
                const targetUserId = data.replace("clear_stats_user_", "");
                const user = state.users[targetUserId];

                if (!user) {
                    await bot.sendMessage(chatId, "❌ User not found.");
                    return;
                }

                state.userStats[targetUserId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
                saveState();

                await bot.editMessageText(
                    `✅ Stats cleared for ${user.profileName || "Unknown"}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
                return;
            }

            if (data === "cancel_stats") {
                if (!isAdmin) return;
                await bot.editMessageText(
                    "❌ Stats clearing cancelled.",
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
                return;
            }

            if (data === "close_pending") {
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }
            // In the callback handler, add:

            if (data === "add_token") {
                state.runtime.waitingAddToken = userId;
                saveState();
                await bot.sendMessage(
                    chatId,
                    "📝 *Add/Update Token*\n\n" +
                    "Send token in this format:\n" +
                    "`ID|TOKEN`\n\n" +
                    "Example: `131669|KNqt1LUymTDaFyU6C5sKcPFq74NyL6N7SkbqYzHTee93457c`\n\n" +
                    "Type /cancel to cancel.",
                    { parse_mode: "Markdown" }
                );
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }

            if (data === "remove_token") {
                await handleRemoveToken(bot, chatId);
                return;
            }

            if (data.startsWith("remove_token_")) {
                const tokenId = data.replace("remove_token_", "");
                const success = await otpWatcher.removeToken(tokenId);
                if (success) {
                    await bot.editMessageText(
                        `✅ Token ${tokenId} removed successfully!`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id
                        }
                    );
                } else {
                    await bot.editMessageText(
                        `❌ Failed to remove token ${tokenId}`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id
                        }
                    );
                }
                return;
            }

            if (data === "rotate_token") {
                const rotated = await otpWatcher.rotateToken();
                if (rotated) {
                    await bot.sendMessage(chatId, `✅ Rotated to token ${rotated.id}`);
                } else {
                    await bot.sendMessage(chatId, "❌ No active tokens available");
                }
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }

            if (data === "token_status") {
                const status = await otpWatcher.getTokenStatus();
                let message = `🔑 *Token Status*\n\n`;
                for (const token of status) {
                    const statusIcon = token.active ? '🟢' : '🔴';
                    message += `${statusIcon} Token ${token.id}: ${token.active ? 'Active' : 'Invalid'}\n`;
                    message += `   Errors: ${token.errorCount}\n`;
                    message += `   Last Checked: ${token.lastChecked}\n\n`;
                }
                await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }

            if (data === "close_tokens") {
                await bot.deleteMessage(chatId, query.message.message_id);
                return;
            }

        } catch (err) {
            logger.error("Callback query error:", err);
            await bot.sendMessage(chatId, "❌ An error occurred. Please try again.");
        }
    });
};

async function handleApprove(bot, chatId, targetUserId, messageId) {
    const pendingUser = state.pendingUsers[targetUserId];

    if (!pendingUser) {
        await bot.sendMessage(chatId, "❌ User not found in pending list.");
        return;
    }

    state.users[targetUserId] = {
        id: targetUserId,
        profileName: pendingUser.profileName || "User",
        username: pendingUser.username || "",
        joinedAt: Date.now()
    };

    if (!state.userStats[targetUserId]) {
        state.userStats[targetUserId] = { assigned: 0, successOtp: 0, noOtp: 0, withdrawCount: 0 };
    }

    delete state.pendingUsers[targetUserId];
    saveState();

    await bot.editMessageText(
        `✅ User ${pendingUser.profileName || "Unknown"} has been approved!`,
        {
            chat_id: chatId,
            message_id: messageId
        }
    );

    try {
        const user = state.users[targetUserId];
        await bot.sendMessage(
            targetUserId,
            `✅ Your join request has been approved!\n\n` +
            `Welcome ${user.profileName || "User"} to EDGE OTP Bot!\n\n` +
            `Use /start to see available commands.`
        );
    } catch (err) {
        logger.error(`Failed to notify user ${targetUserId}:`, err.message);
    }
}

async function handleReject(bot, chatId, targetUserId, messageId) {
    const pendingUser = state.pendingUsers[targetUserId];

    if (!pendingUser) {
        await bot.sendMessage(chatId, "❌ User not found in pending list.");
        return;
    }

    state.pendingUsers[targetUserId].status = "rejected";
    saveState();

    await bot.editMessageText(
        `❌ User ${pendingUser.profileName || "Unknown"} has been rejected.`,
        {
            chat_id: chatId,
            message_id: messageId
        }
    );

    try {
        await bot.sendMessage(
            targetUserId,
            `❌ Your join request has been rejected.\n\n` +
            `Please contact admin for more information.`
        );
    } catch (err) {
        logger.error(`Failed to notify user ${targetUserId}:`, err.message);
    }
}