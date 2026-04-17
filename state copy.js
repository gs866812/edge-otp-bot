// state.js
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state.json");
const TMP_FILE = path.join(__dirname, "state.json.tmp");
const BAK_FILE = path.join(__dirname, "state.json.bak");

const defaultState = {
  availableNumbers: [],
  assignedNumbers: {},
  pullRequests: [],
  teamUsers: {},
  nextRequestId: 1,
};

function getDefaultState() {
  return JSON.parse(JSON.stringify(defaultState));
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return getDefaultState();

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const state = Object.assign(getDefaultState(), parsed);

    if (!Array.isArray(state.availableNumbers)) state.availableNumbers = [];
    if (typeof state.assignedNumbers !== "object" || !state.assignedNumbers) state.assignedNumbers = {};
    if (!Array.isArray(state.pullRequests)) state.pullRequests = [];
    if (typeof state.teamUsers !== "object" || !state.teamUsers) state.teamUsers = {};
    if (typeof state.nextRequestId !== "number") state.nextRequestId = 1;

    return state;
  } catch (err) {
    // Try backup if main state is corrupted
    try {
      if (fs.existsSync(BAK_FILE)) {
        const rawBak = fs.readFileSync(BAK_FILE, "utf8");
        const parsedBak = JSON.parse(rawBak);
        const state = Object.assign(getDefaultState(), parsedBak);
        return state;
      }
    } catch (_) {}

    console.error("Failed to load state, using fresh default:", err.message || err);
    return getDefaultState();
  }
}

function saveState(state) {
  try {
    const json = JSON.stringify(state, null, 2);

    // backup current
    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.copyFileSync(STATE_FILE, BAK_FILE);
      } catch (_) {}
    }

    // atomic write
    fs.writeFileSync(TMP_FILE, json, "utf8");
    fs.renameSync(TMP_FILE, STATE_FILE);
  } catch (err) {
    console.error("Failed to save state:", err.message || err);
    // cleanup tmp if exists
    try {
      if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE);
    } catch (_) {}
  }
}

module.exports = {
  loadState,
  saveState,
  getDefaultState,
};
