import { of } from "rxjs";

import { printWelcomeScreen } from "../../core/utils";
import { tradeValidator, transactionSimulator } from "../../core/mixins";

import {
  tickerFetcher,
  diversificationSetter,
  transactionMaker,
  transactionChecker,
} from "./operators";
import { sendTelegramMessage, formatAndSendMessage, errorLogger } from "./log";
import { retryOnErrorExectutor } from "./utils";

printWelcomeScreen(sendTelegramMessage);

export const handler = (response) =>
  of(response).pipe(
    tickerFetcher,
    diversificationSetter,
    tradeValidator(formatAndSendMessage),
    transactionSimulator(formatAndSendMessage),
    transactionMaker,
    transactionChecker,
    retryOnErrorExectutor,
    errorLogger
  );
