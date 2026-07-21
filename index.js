require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const logger = require("./services/logger");

const registerStartHandler = require("./handlers/start");
const registerCallbackHandler = require("./handlers/callback");
const registerMessageHandler = require("./handlers/message");
const registerCommandHandler = require("./handlers/commands");

const startOtpWatcher = require("./services/otpWatcher");

const bot = new TelegramBot(config.telegram.botToken, {
    polling: true
});

// Register handlers
registerStartHandler(bot);
registerCallbackHandler(bot);
registerMessageHandler(bot);
registerCommandHandler(bot);

// Start OTP watcher
startOtpWatcher(bot);

logger.info("=================================");
logger.info("CTG IPRN Bot STARTED");
logger.info("Polling started...");
logger.info("=================================");

bot.on("polling_error", (err) => {
    logger.error("Polling Error:");
    logger.error(err.message);
});

process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception:");
    logger.error(err.stack);
});

process.on("unhandledRejection", (err) => {
    logger.error("Unhandled Rejection:");
    logger.error(err);
});