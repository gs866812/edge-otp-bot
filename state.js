const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state.json");

const defaultState = {
    users: {},
    pendingUsers: {},
    availableNumbers: [],
    assignedNumbers: {},
    numberOwners: {},
    userStats: {},
    settings: {
        botEnabled: true,
        withdrawEnabled: true,
        withdrawChannelId: "",
        otpLogChannelId: "" // NEW: OTP লগ গ্রুপের চ্যানেল আইডি
    },
    tokens: {
        list: [],
        lastUpdate: null,
        autoDisableOnInvalid: true
    },
    rateLimit: 15,
    lastGetNumber: {},
    runtime: {
        waitingAddNumbers: null,
        waitingBroadcast: null,
        waitingChannelId: null,
        waitingRemoveUsers: null,
        waitingRemoveUserSingle: null,
        waitingSingleStats: null,
        waitingTestOtp: null,
        waitingTestMessage: null,
        waitingAddToken: null,
        waitingRemoveToken: null,
        waitingUpdateToken: null,
        waitingOtpLogChannelId: null, // NEW: OTP লগ চ্যানেল সেট করার জন্য
        selectedUsersForRemoval: [],
        addNumberBuffer: [],
        activeToken: 0,
        lastFetch: null,
        otpAttempts: {},
        lastOtpCheck: {},
        waitingConfirmation: false,
        pendingAction: null,
        waitingRateLimit: null
    },
    lastOtpByNumber: {},
    processedMessages: {},
    lastAutoSentByNumber: {},
    lastProcessedMessage: {},
    processedOtpIds: {} // NEW: ডুপ্লিকেট OTP প্রিভেনশনের জন্য
};

let state = { ...defaultState };

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
            state = JSON.parse(JSON.stringify(defaultState));
            return;
        }
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        state = { ...defaultState, ...JSON.parse(raw) };

        if (!state.lastGetNumber) state.lastGetNumber = {};
        if (!state.rateLimit) state.rateLimit = 15;
        if (!state.settings.otpLogChannelId) state.settings.otpLogChannelId = "";
        if (!state.processedOtpIds) state.processedOtpIds = {};
        if (!state.tokens) state.tokens = { list: [], lastUpdate: null };
    } catch (err) {
        console.log("State load error:", err.message);
        state = JSON.parse(JSON.stringify(defaultState));
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanupOrphanedNumbers() {
    let cleaned = 0;

    const numbersWithOwners = Object.keys(state.numberOwners);
    for (const number of numbersWithOwners) {
        const ownerId = state.numberOwners[number];
        if (!state.users[ownerId]) {
            delete state.numberOwners[number];
            if (state.assignedNumbers[ownerId]) {
                state.assignedNumbers[ownerId] = state.assignedNumbers[ownerId].filter(n => n !== number);
                if (state.assignedNumbers[ownerId].length === 0) {
                    delete state.assignedNumbers[ownerId];
                }
            }
            cleaned++;
        }
    }

    const assignedUsers = Object.keys(state.assignedNumbers);
    for (const userId of assignedUsers) {
        if (!state.users[userId] && !state.pendingUsers[userId]) {
            const numbers = state.assignedNumbers[userId] || [];
            for (const number of numbers) {
                delete state.numberOwners[number];
            }
            delete state.assignedNumbers[userId];
            cleaned += numbers.length;
        }
    }

    return cleaned;
}

loadState();

module.exports = {
    state,
    saveState,
    loadState,
    cleanupOrphanedNumbers
};