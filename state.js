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
        withdrawChannelId: ""
    },
    runtime: {
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
    },
    lastOtpByNumber: {},
    processedMessages: {},
    lastAutoSentByNumber: {},
    lastProcessedMessage: {}
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
    
    // Get all numbers that have owners
    const numbersWithOwners = Object.keys(state.numberOwners);
    
    for (const number of numbersWithOwners) {
        const ownerId = state.numberOwners[number];
        
        // Check if the owner exists in users list
        if (!state.users[ownerId]) {
            // Owner doesn't exist, remove the number
            delete state.numberOwners[number];
            
            // Also remove from assignedNumbers if present
            if (state.assignedNumbers[ownerId]) {
                state.assignedNumbers[ownerId] = state.assignedNumbers[ownerId].filter(n => n !== number);
                if (state.assignedNumbers[ownerId].length === 0) {
                    delete state.assignedNumbers[ownerId];
                }
            }
            
            cleaned++;
        }
    }
    
    // Also clean assignedNumbers for non-existent users
    const assignedUsers = Object.keys(state.assignedNumbers);
    for (const userId of assignedUsers) {
        if (!state.users[userId] && !state.pendingUsers[userId]) {
            // User doesn't exist in either active or pending users
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