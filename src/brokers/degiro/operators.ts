const R = require("ramda");

import { from, of, throwError, defer } from "rxjs";
import { tap, mergeMap, retryWhen, catchError, pluck } from "rxjs/operators";

import { formatAndSendMessage, sendMessage, errorLogger } from "./log";
import { genericRetryExecutor } from "./utils";

const BACKUP_VALUE = 2;

export const diversificationSetter = mergeMap(
  ({
    options,
    currentTrade,
    currencyConversion,
    logger,
    broker,
    body,
    total,
  }) => {
    const { currency, symbol } = body;
    const { amountToSell } = currentTrade;
    const totalAmount = R.multiply(
      0.99,
      R.sum(
        R.values(R.omit(R.without([currency], options.excludedSymbols), total))
      )
    );
    const calculatedBuyForAmountInCurrency = R.multiply(
      totalAmount,
      body.amount
    ).toFixed(2);
    const buyForAmountInCurrency = R.gte(
      calculatedBuyForAmountInCurrency,
      total["EUR"]
    )
      ? R.multiply(0.99, total["EUR"])
      : calculatedBuyForAmountInCurrency;

    const priceInEUR = R.ifElse(
      () => R.equals("EUR", currency),
      () => R.prop("price", body),
      () => R.divide(R.prop("price", body), currencyConversion[currency])
    )();
    const buyValue = R.divide(buyForAmountInCurrency, priceInEUR);
    const feewWithBackupRatio = R.multiply(BACKUP_VALUE, options.fee);
    const amountToBuy = Math.floor(
      R.subtract(buyValue, R.multiply(buyValue, feewWithBackupRatio))
    );

    return of({
      broker,
      tickerStructure: {
        ask: R.prop("price", body),
      },
      options,
      total,
      body: { ...body, currency: "EUR" },
      logger,
      currentTrade: {
        totalAmount,
        amountToSell,
        amountToBuy,
        amountAlreadyTraded: total[symbol],
        buyForAmountInCurrency,
      },
    });
  }
);

const orderHandler = ({
  tickerStructure,
  currentTrade,
  body,
  logger,
  broker,
  total,
  options,
}) => {
  const { symbol, currency, productId } = body;

  const orderCond = R.ifElse(
    () => R.equals("sell", R.prop("action", body)),
    () => {
      const order = {
        buySell: "SELL",
        orderType: 0,
        productId,
        size: currentTrade.amountToSell,
        timeType: 3,
        price: body.price,
      };
      return from(broker.createOrder(order)).pipe(
        mergeMap(({ confirmationId, freeSpaceNew, transactionFees }) => {
          return from(broker.executeOrder(order, confirmationId));
        })
      );
    },
    () => {
      const order = {
        buySell: "BUY",
        orderType: 0,
        productId,
        size: currentTrade.amountToBuy,
        timeType: 3,
        price: body.price,
      };
      return from(broker.createOrder(order)).pipe(
        mergeMap(({ confirmationId, freeSpaceNew, transactionFees }) => {
          return from(broker.executeOrder(order, confirmationId));
        })
      );
    }
  );

  const order$ = orderCond();
  return order$.pipe(
    retryWhen(
      genericRetryExecutor({
        maxRetryAttempts: 10,
        scalingDuration: 60000,
        excludedStatusCodes: [500, 400],
      })
    ),
    errorLogger,
    mergeMap((order) =>
      of({ tickerStructure, order, currentTrade, body, logger, broker, total })
    )
  );
};

export const tansactionMaker = mergeMap(
  ({ tickerStructure, options, currentTrade, body, logger, broker, total }) => {
    const makerCond = R.ifElse(
      () => R.equals(body.mode, "trade"),
      () => {
        return orderHandler({
          tickerStructure,
          currentTrade,
          body,
          logger,
          broker,
          total,
          options,
        });
      },
      () => of({ tickerStructure, currentTrade, body, logger, broker, total })
    );
    return makerCond();
  }
);

export const transactionChecker = mergeMap(
  ({
    order,
    tickerStructure,
    options,
    currentTrade,
    body,
    logger,
    broker,
    total,
  }) => {
    const makerCond = R.ifElse(
      () => R.equals(body.mode, "trade"),
      () => {
        return from(broker.getOrders({ active: true })).pipe(
          pluck("orders"),
          mergeMap((orders) => {
            return R.not(
              R.length(
                R.find((currentOrder) => R.equals(order, currentOrder), orders)
              )
            )
              ? of({
                  tickerStructure,
                  options,
                  currentTrade,
                  body,
                  logger,
                  broker,
                  total,
                }).pipe(
                  tap(() => {
                    formatAndSendMessage({
                      color: "green",
                      type: "trade completed",
                      message: `Trade completed succesfully`,
                    });
                  })
                )
              : throwError("Status of order isn`t closed");
          }),
          retryWhen(
            genericRetryExecutor({
              maxRetryAttempts: 10,
              scalingDuration: 30000,
              excludedStatusCodes: [500, 400],
            })
          ),
          catchError((error) => {
            formatAndSendMessage({
              color: "red",
              type: "trade canceled",
              message: `${error} after maximium attempts. Going to retry all cycle...`,
            });

            return defer(() => broker.deleteOrder(order)).pipe(
              retryWhen(
                genericRetryExecutor({
                  excludedStatusCodes: [500, 400],
                })
              ),
              mergeMap(() => throwError(error))
            );
          })
        );
      },
      () => of({ tickerStructure, currentTrade, body, logger, broker, total })
    );
    return makerCond();
  }
);
