import { of } from "rxjs";
import { tap } from "rxjs/operators";

import { tradeValidator, transactionSimulator } from "../../core/mixins";
import {
  diversificationSetter,
  transactionMaker,
  balanceChecker,
  allowanceChecker,
  queueChecker,
} from "./operators";

import { sendTelegramMessage, formatAndSendMessage, errorLogger } from "./log";
import { retryOnErrorExectutor } from "./utils";
import { printWelcomeScreen } from "../../core/utils";

printWelcomeScreen(sendTelegramMessage);

export const handler = (response) =>
  of(response).pipe(
    queueChecker,
    allowanceChecker,
    balanceChecker,
    diversificationSetter,
    tradeValidator(formatAndSendMessage),
    transactionSimulator(formatAndSendMessage),
    transactionMaker,
    retryOnErrorExectutor,
    errorLogger
  );
