const Telegram = require("node-telegram-bot-api");
const R = require("ramda");

import { of } from "rxjs";
import { catchError, skip } from "rxjs/operators";

import {
  formatAndSendMessageFactory,
  formatToTableFactory,
  printMessage,
} from "../../core/utils";
import config from "../../../config";

const env = process.env.NODE_ENV || "development";

const TELEGRAM_TOKEN = config["ccxt"]["telegram"]["token"];
const TELEGRAM_CHATID = config["ccxt"]["telegram"]["chatId"];
const TelegramBot =
  env === "production"
    ? new Telegram(TELEGRAM_TOKEN, { polling: true })
    : { sendMessage: R.empty };

export const sendTelegramMessage = (message) => {
  return TelegramBot.sendMessage(TELEGRAM_CHATID, message, {
    parse_mode: "Markdown",
  });
};

export const sendMessage = (message) => {
  sendTelegramMessage(message);
  printMessage(message);
};

export const formatAndSendMessage =
  formatAndSendMessageFactory(sendTelegramMessage);
export const formatToTable = formatToTableFactory(sendTelegramMessage);

export const errorLogger = catchError((error) => {
  sendTelegramMessage(JSON.stringify(error));
  return of(error).pipe(skip(1));
});
