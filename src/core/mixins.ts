const R = require("ramda");
const { request } = require("universal-rxjs-ajax");

import {
  map,
  tap,
  mergeMap,
  skip,
  catchError,
  pluck,
  retryWhen,
} from "rxjs/operators";

import { Observable, of, iif, throwError, timer, defer } from "rxjs";
import { destroyBroker, printMessage } from "./utils";

export const deferAndRetryFactory = (genericRetryExecutor) => (fn) =>
  defer(fn).pipe(
    retryWhen(
      genericRetryExecutor({
        maxRetryAttempts: 10,
        scalingDuration: 10000,
        excludedStatusCodes: [500, 400],
      })
    )
  );

export const currencyConversionGetter = mergeMap(
  ({ currentTrade, options, logger, broker, body, total }) => {
    return request({
      url: "https://api.exchangeratesapi.io/latest?base=EUR",
      method: "GET",
    }).pipe(
      pluck("response", "rates"),
      map((currencyConversion) => ({
        currencyConversion,
        currentTrade,
        options,
        logger,
        broker,
        body,
        total,
      }))
    );
  }
);

const ratioValidator = ({ currentTrade, body, options }, valueName) => {
  const { amount } = body;
  const { amountAlreadyTraded, totalAmount } = currentTrade;
  const ratio = R.or(
    // Move it to another place
    R.gte(amountAlreadyTraded, 1),
    R.equals(
      // @ts-ignore
      parseFloat((amountAlreadyTraded / totalAmount).toFixed(1)),
      amount
    )
  );
  // Block in the future an amount that is bigger than available
  return ratio;
};
const alreadyBoughtChecker = ({ currentTrade, body, options }) =>
  ratioValidator({ currentTrade, body, options }, "amountToBuy");
const alreadySoldChecker = ({ currentTrade, body, options }) => {
  return R.lte(currentTrade.amountAlreadyTraded, 1);
};

export const tradeValidator = (formatAndSendMessage) =>
  mergeMap(
    ({
      options,
      tickerStructure,
      currentTrade,
      logger,
      body,
      broker,
      total,
    }) => {
      const tradeStatusCond = R.ifElse(
        () => R.equals("sell", R.prop("action", body)),
        alreadySoldChecker,
        alreadyBoughtChecker
      );

      return iif(
        () => tradeStatusCond({ options, currentTrade, body, total }),
        of({ options, currentTrade, logger, body, broker, total }).pipe(
          tap(() => {
            destroyBroker({ currentTrade, logger, body, broker, total });
            return formatAndSendMessage({
              color: "green",
              type: "dispatcher",
              message: `Already in position - currently you have completed a transaction equivalent to the amount ${currentTrade.amountAlreadyTraded} ${body.currency} in ${body.symbol}`,
            });
          }),
          skip(1)
        ),
        of({ options, currentTrade, logger, body, broker, total })
      );
    }
  );

export const transactionSimulator = (formatAndSendMessage) =>
  mergeMap(({ options, currentTrade, body, logger, broker, total }) => {
    return of({ currentTrade, options, body, broker, total }).pipe(
      tap(() => {
        const message = R.ifElse(
          () => R.equals("sell", R.prop("action", body)),
          () =>
            `${body.action} ${currentTrade.amountToSell} ${body.symbol} that was bought for ${currentTrade.amountAlreadyTraded} ${body.currency}`,
          () =>
            `${body.action} ${currentTrade.amountToBuy} ${body.symbol} for ${currentTrade.buyForAmountInCurrency} ${body.currency}`
        )();
        formatAndSendMessage({ color: "green", type: "simulator", message });
      })
    );
  });

export const genericRetryExecutorFactory =
  (sendMessage) =>
  ({
    maxRetryAttempts = 3,
    scalingDuration = 10000,
    excludedStatusCodes = [],
    excludedNames = [],
    includedStatusCodes = [],
    enableAttemptMultiplier = true,
  }) =>
  (attempts: Observable<any>) => {
    const extractArguments = ({
      rewrite,
      maxRetryAttempts,
      includedStatusCodes,
      scalingDuration,
    }) => {
      return {
        extractedMaxRetryAttempts: R.propOr(
          maxRetryAttempts,
          "maxRetryAttempts"
        )(rewrite),
        extractedScalingDuration: R.propOr(
          scalingDuration,
          "scalingDuration"
        )(rewrite),
        extractedIncludedStatusCodes: R.propOr(
          includedStatusCodes,
          "includedStatusCodes"
        )(rewrite),
        extractedEnableAttemptMultiplier: R.propOr(
          enableAttemptMultiplier,
          "enableAttemptMultiplier"
        )(rewrite),
      };
    };
    return attempts.pipe(
      mergeMap((error, i) => {
        const retryAttempt = i + 1;
        const {
          extractedMaxRetryAttempts,
          extractedScalingDuration,
          extractedIncludedStatusCodes,
          extractedEnableAttemptMultiplier,
        } = extractArguments({
          rewrite: R.propOr({}, "rewrite")(error),
          includedStatusCodes,
          maxRetryAttempts,
          scalingDuration,
        });

        // All `find` methods should return a boolean
        const isExcluded = R.or(
          excludedStatusCodes.find((e) => e === error.status),
          excludedNames.find((e) => e === error.name)
        );
        const isIncluded = R.equals(0, extractedIncludedStatusCodes.length)
          ? true
          : extractedIncludedStatusCodes.find((e) => e === error.code);

        const time = extractedEnableAttemptMultiplier
          ? retryAttempt * extractedScalingDuration
          : extractedScalingDuration;
        const predicate = () =>
          R.not(isIncluded)
            ? true
            : R.or(retryAttempt > extractedMaxRetryAttempts, isExcluded);

        const onError = () => throwError(error);
        const onAttempt = () => {
          return timer(time).pipe(
            tap(() => {
              const parsedError = R.equals("{}", JSON.stringify(error))
                ? error.toString()
                : JSON.stringify(error);
              return printMessage(
                `Attempt ${retryAttempt}: retrying in ${time}ms ${parsedError})`
              );
            })
          );
        };

        const executorCond = R.ifElse(predicate, onError, onAttempt);
        return executorCond();
      })
    );
  };

export const retryOnErrorExectutorFactory = (genericRetryExecutor) =>
  retryWhen(
    genericRetryExecutor({
      maxRetryAttempts: 10,
      scalingDuration: 60000,
      excludedStatusCodes: [500, 400],
    })
  );
