import { of } from "rxjs";

import {
  tradeValidator,
  transactionSimulator,
  currencyConversionGetter,
} from "../../core/mixins";
import {
  diversificationSetter,
  tansactionMaker,
  transactionChecker,
} from "./operators";

import { sendTelegramMessage, formatAndSendMessage, errorLogger } from "./log";
import { retryOnErrorExectutor } from "./utils";
import { printWelcomeScreen } from "../../core/utils";

printWelcomeScreen(sendTelegramMessage);

export const handler = (response) =>
  of(response).pipe(
    currencyConversionGetter,
    diversificationSetter,
    tradeValidator(formatAndSendMessage),
    transactionSimulator(formatAndSendMessage),
    tansactionMaker,
    transactionChecker,
    retryOnErrorExectutor,
    errorLogger
  );
