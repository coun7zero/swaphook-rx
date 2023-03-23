import { r, use } from "@marblejs/core";
import { requestValidator$, t } from "@marblejs/middleware-io";
import { uniswapBroker } from "./factory";

import { throwError, of, iif } from "rxjs";
import {
  mergeMap,
  tap,
  catchError,
  retryWhen,
  map,
  skip,
} from "rxjs/operators";

import { dispatcherEmitter } from "../../core/dispatcher";

import { LoggerToken, LoggerLevel, useContext } from "@marblejs/core";
import { HttpError, HttpStatus } from "@marblejs/core";

import config from "../../../config";

import { formatToTable, sendMessage, errorLogger } from "./log";

import { tokenValidator } from "../../core/utils";

import { genericRetryExecutor } from "./utils";

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
  formatToTable({ message: "Received webhook:", data: body });
});
// @ts-ignore

const bodyParser = (config) =>
  mergeMap(({ body }) => {
    const parsedExchangeName = R.contains("/", body.exchange)
      ? R.last(R.split("/", body.exchange))
      : body.exchange;

    const parsedBody = {
      ...R.omit(["token"], body),
      amount: parseFloat(body.amount),
      exchange: R.toLower(parsedExchangeName),
      broker: "uniswap",
    };
    const options = config[parsedBody.exchange]["options"]; // Inject to `of` and include the whole parsing here + handle `Cannot read property 'options' of undefined` error
    return iif(
      () =>
        R.all(R.equals(true), [
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

export const uniswap$ = r.pipe(
  r.matchPath("/uniswap"),
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
      bodyParser(config["uniswap"]),
      loggerInjector(logger),
      initLogger,
      uniswapBroker(config["uniswap"]),
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
