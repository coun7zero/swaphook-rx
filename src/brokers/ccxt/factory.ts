const R = require("ramda");
const ccxt = require("ccxt");

const differenceInSeconds = require("date-fns/differenceInSeconds");

import {
  mergeMap,
  tap,
  catchError,
  map,
  pluck,
  skip,
  take,
} from "rxjs/operators";
import {
  pipe,
  of,
  throwError,
  from,
  iif,
  BehaviorSubject,
  Observable,
} from "rxjs";
import { HttpError, HttpStatus } from "@marblejs/core";

import { formatAndSendMessage, sendMessage, formatToTable } from "./log";

const DURATION_IN_MINUTES_FOR_BALANCE_FETCH = 2;

const brokerCreator = ({ body, config, logger }) =>
  of({
    body,
    logger,
    broker: new ccxt[body.exchange]({
      ...config[body.exchange]["config"],
      options: {
        createMarketBuyOrderRequiresPrice: false,
      },
    }),
  });

const marketSetter =
  (config) =>
  ({ body, logger }) =>
    iif(
      () => ccxt[body.exchange] && config[body.exchange],
      brokerCreator({ body, config, logger }),
      throwError(
        new HttpError(
          JSON.stringify("Cannot find the exchange or API config"),
          HttpStatus.BAD_REQUEST
        )
      )
    );

const brokerValidator = mergeMap(({ body, broker, logger }) =>
  iif(
    () => broker.has["createMarketOrder"],
    of({ body, broker, logger }),
    throwError(
      new HttpError(
        JSON.stringify(
          "Provided broker doesn`t support `createMarketOrder` method"
        ),
        HttpStatus.BAD_REQUEST
      )
    )
  )
);

// That approach could use factory because of it's similarity to lastCurrencyToETHSwapBuffer$
const lastBalanceFetchBuffer$ = new BehaviorSubject({
  status: null,
  timestamp: null,
  promise: null,
  total: null,
});

// It's probably unnecessary because behaviorSubject keeps only the last value - you can use the getValue method
const lastBalanceFetch$ = lastBalanceFetchBuffer$.pipe(take(1));

const fetchBalance = ({ broker, body, logger }) =>
  from(broker.fetchBalance())
    .pipe(
      pluck("total"),
      map((total) => ({
        [R.prop("symbol", body)]: 0,
        ...R.pickBy(R.pipe(parseFloat, R.partial(R.flip(R.gt), [0])), total),
      }))
    )
    .toPromise();

const balanceFetcher = mergeMap(({ broker, body, logger }) => {
  return new Observable((subscriber) => {
    return lastBalanceFetch$.subscribe(
      ({ promise, status, timestamp, total }) => {
        const timenow = new Date();
        const timeDuration = R.gte(
          DURATION_IN_MINUTES_FOR_BALANCE_FETCH,
          R.divide(differenceInSeconds(timenow, timestamp), 60)
        );
        const cond = R.cond([
          [
            () => R.and(R.equals("completed", status), timeDuration),
            () => {
              formatAndSendMessage({
                color: "green",
                type: `Balance fetcher`,
                message: `Promise is completed`,
              });
              subscriber.next({ broker, body, logger, total });
              subscriber.complete();
            },
          ],
          [
            () => R.equals("pending", status),
            () => {
              formatAndSendMessage({
                color: "yellow",
                type: `Balance fetcher`,
                message: `Promise already exists and is pending`,
              });
              from(promise).subscribe({
                next: (total) => {
                  subscriber.next({ broker, body, logger, total });
                  subscriber.complete();
                },
                error: (err) => {
                  subscriber.error(err);
                  formatAndSendMessage({
                    color: "red",
                    type: `Balance fetcher`,
                    message: `Promise has failed`,
                  });
                  subscriber.complete();
                },
              });
            },
          ],
          [
            R.T,
            () => {
              formatAndSendMessage({
                color: "green",
                type: `Balance fetcher`,
                message: `Promise has created`,
              });
              const newPromise = fetchBalance({ broker, body, logger });
              lastBalanceFetchBuffer$.next({
                status: "pending",
                promise: newPromise,
                timestamp: timenow,
                total: null,
              });
              from(newPromise).subscribe({
                next: (total) => {
                  formatAndSendMessage({
                    color: "blue",
                    type: `Balance fetcher`,
                    message: `Promise has completed`,
                  });
                  lastBalanceFetchBuffer$.next({
                    status: "completed",
                    timestamp: new Date(),
                    promise: null,
                    total,
                  });
                  subscriber.next({ broker, body, logger, total });
                  subscriber.complete();
                },
                error: (err) => {
                  subscriber.error(err);
                  formatAndSendMessage({
                    color: "red",
                    type: `Balance fetcher`,
                    message: `Promise has failed`,
                  });
                  lastBalanceFetchBuffer$.next({
                    status: "failed",
                    timestamp: new Date(),
                    promise: null,
                    total: null,
                  });
                  subscriber.complete();
                },
              });
            },
          ],
        ]);
        return cond();
      }
    );
  });
});

const errorHandler = catchError((error) => {
  sendMessage(JSON.stringify(error));
  return of(error).pipe(skip(1));
});

const balanceLogger = tap(({ total, body, logger }) => {
  return formatToTable({
    message: `Current position at ccxt/${body.exchange}:`,
    data: total,
  });
});

// It should be potentially be removed because if you haven't got a specific value, you can't start trading for this asset
const portfolioValidator = mergeMap(({ broker, total, body, logger }) => {
  return iif(
    () => R.has(R.prop("symbol", body), total),
    of({ broker, total, body, logger }),
    throwError(
      new HttpError("The provided symbol isn't valid", HttpStatus.BAD_REQUEST)
    )
  );
});

export const ccxtBroker = (config) => {
  return mergeMap(
    pipe(
      marketSetter(config),
      brokerValidator,
      balanceFetcher,
      portfolioValidator,
      errorHandler,
      balanceLogger
    )
  );
};
