const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "..", "logs.txt");

function log(message, type = "INFO") {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    
    console.log(logEntry.trim());
    
    try {
        fs.appendFileSync(LOG_FILE, logEntry);
    } catch (err) {
        console.error("Failed to write log:", err.message);
    }
}

module.exports = {
    info: (msg) => log(msg, "INFO"),
    error: (msg) => log(msg, "ERROR"),
    warn: (msg) => log(msg, "WARN"),
    debug: (msg) => log(msg, "DEBUG")
};