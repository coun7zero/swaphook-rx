import { throwError, of, iif } from "rxjs";
import { mergeMap, tap, retryWhen, map } from "rxjs/operators";
import {
  r,
  use,
  LoggerToken,
  LoggerLevel,
  useContext,
  HttpError,
  HttpStatus,
} from "@marblejs/core";
import { requestValidator$, t } from "@marblejs/middleware-io";

import { dispatcherEmitter } from "../../core/dispatcher";
import { tokenValidator } from "../../core/utils";
import config from "../../../config";

import { ccxtBroker } from "./factory";
import { genericRetryExecutor } from "./utils";
import { formatToTable, sendMessage, errorLogger } from "./log";

const R = require("ramda");

const validator$ = requestValidator$({
  body: t.type({
    action: t.string,
    price: t.string,
    symbol: t.string,
    currency: t.string,
    exchange: t.string,
    type: t.string,
    amount: t.string,
    timenow: t.string,
    volume: t.string,
    token: t.string,
    mode: t.string,
  }),
});

const initLogger = tap(({ body, logger }) => {
  formatToTable({ message: "Received a webhook:", data: body });
});

// @ts-ignore
const bodyParser = (config) =>
  mergeMap(({ body }) => {
    const parsedBody = {
      ...R.omit(["token"], body),
      amount: parseFloat(body.amount),
      exchange: R.toLower(body.exchange),
      broker: "ccxt",
    };
    const options = config[parsedBody.exchange]["options"];

    return iif(
      () =>
        R.all(R.equals(true), [
          R.not(R.includes(body.symbol, options.excludedSymbols)),
          tokenValidator(body.token, config[parsedBody.exchange].credentials),
        ]),
      of({ body: parsedBody }),
      throwError(
        new HttpError(
          `The provided symbol is set as excluded symbol, or the token is wrong`,
          HttpStatus.BAD_REQUEST
        )
      )
    );
  });
const loggerInjector = (logger) => map(({ body }) => ({ logger, body }));

export const ccxt$ = r.pipe(
  r.matchPath("/ccxt"),
  r.matchType("POST"),
  r.useEffect((req$, context) => {
    const loggerWithCurrentContext = useContext(LoggerToken)(context.ask);
    const logger = (message) => {
      const scope = {
        tag: "RxTrader",
        level: LoggerLevel.INFO,
        type: "Trading",
        message,
      };
      sendMessage(message);
      return loggerWithCurrentContext(scope)();
    };
    return req$.pipe(
      use(validator$),
      bodyParser(config["ccxt"]),
      loggerInjector(logger),
      initLogger,
      ccxtBroker(config["ccxt"]),
      retryWhen(
        genericRetryExecutor({
          maxRetryAttempts: 5,
          scalingDuration: 30000,
          excludedStatusCodes: [500, 400],
        })
      ),
      errorLogger,
      dispatcherEmitter(config)
    );
  })
);
