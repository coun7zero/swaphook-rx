const R = require("ramda");
const compareAsc = require("date-fns/compareAsc");

import { from, forkJoin, of, throwError } from "rxjs";
import {
  map,
  tap,
  mergeMap,
  retryWhen,
  catchError,
  pluck,
} from "rxjs/operators";

import {
  formatAndSendMessage,
  formatToTable,
  sendMessage,
  errorLogger,
} from "./log";
import { genericRetryExecutor } from "./utils";

const TRADES_LENGTH = 10;
const BACKUP_VALUE = 2;

const mapSymbolsToPromises = ({ tickerStructure, body, broker, options }) =>
  R.mapObjIndexed((amount, symbol) => {
    const { currency } = body;
    const ticker = `${symbol}/${currency}`;

    const myTradesFetcher = () => {
      return broker.fetchMyTrades(ticker, TRADES_LENGTH);
    };
    const symbolChecker = () =>
      R.gt(parseFloat(amount), 0) &&
      R.not(R.includes(symbol, options.excludedSymbols));
    const mapperCond = R.ifElse(
      symbolChecker,
      () =>
        from(myTradesFetcher()).pipe(
          catchError(() => of([])),
          mergeMap((trades) => {
            const isBuySide = R.equals("buy");
            const tradesPredicate = (trade) => isBuySide(R.prop("side", trade));
            const filteredBuyTrades = R.filter(tradesPredicate, trades);
            return R.ifElse(
              R.always(R.length(filteredBuyTrades)),
              () => of(trades),
              () => {
                sendMessage(
                  `Empty trade history. Fetching the current price for ${symbol} for the diversification calculator`
                );
                return from(broker.fetchTicker(ticker)).pipe(
                  catchError(() => of(undefined)),
                  map((tickerStructure) => {
                    return tickerStructure
                      ? [
                          {
                            price: R.prop("ask", tickerStructure),
                            timestamp: R.prop("timestamp", tickerStructure),
                            side: "buy",
                          },
                        ]
                      : [];
                  })
                );
              }
            )();
          })
        ),
      R.always(of([]))
    );
    return mapperCond();
  });

const myTradesPromiseCreator = ({
  tickerStructure,
  body,
  broker,
  options,
  total,
}) => mapSymbolsToPromises({ tickerStructure, body, broker, options })(total);

const reduceTradesByLastAmount = ({
  tickerStructure,
  options,
  logger,
  broker,
  body,
  total,
}) =>
  R.mapObjIndexed((trades, symbol) => {
    const { currency } = body;
    const transactionGetter = () => {
      const currentAmount = total[symbol];
      const sortedTransactionsByDate = R.sort(
        ({ timestamp: dateLeft }, { timestamp: dateRight }) =>
          compareAsc(dateLeft, dateRight),
        trades
      );
      const newestBuyTransaction = R.last(sortedTransactionsByDate);

      const latestPrice = R.prop("price", newestBuyTransaction);
      const currentAmountInCurrency = R.multiply(latestPrice, currentAmount);
      // Move to a separate function
      const fee = broker.calculateFee(
        `${symbol}/${currency}`,
        "market",
        body.action,
        currentAmountInCurrency,
        body.price,
        "taker"
      );
      const feeWithBackupRatio = R.multiply(
        BACKUP_VALUE,
        options.fee || fee.rate
      );
      const currentAmountFee = R.multiply(
        feeWithBackupRatio,
        currentAmountInCurrency
      );
      const currentAmountInCurrencyWithFee = R.sum([
        currentAmountInCurrency,
        currentAmountFee,
      ]);
      return currentAmountInCurrencyWithFee.toFixed(2);
    };
    // Theoretically, it always returns trades here:
    const reducerCond = R.ifElse(
      R.always(R.length(trades)),
      transactionGetter,
      R.always(total[symbol])
    );
    return reducerCond();
  });

const symbolsAmountsInCurrencyGetter = (
  lastTradesPerSymbols,
  { tickerStructure, options, logger, broker, body, total }
) =>
  reduceTradesByLastAmount({
    tickerStructure,
    options,
    logger,
    broker,
    body,
    total,
  })(lastTradesPerSymbols);

const tradeResultsMapper = ({
  tickerStructure,
  options,
  logger,
  broker,
  body,
  total,
}) =>
  map((lastTradesPerSymbols) => {
    const { currency, symbol } = body;
    const symbolsAmountsInCurrency = symbolsAmountsInCurrencyGetter(
      lastTradesPerSymbols,
      { tickerStructure, options, logger, broker, body, total }
    );

    formatToTable({
      message: `The current amount in currency at ccxt/${body.exchange}:`,
      data: symbolsAmountsInCurrency,
    });

    const totalAmount = R.multiply(
      0.99,
      R.sum(
        R.values(
          R.omit(
            R.without([currency], options.excludedSymbols),
            symbolsAmountsInCurrency
          )
        )
      )
    );
    const buyForAmountInCurrencyByRatio = Math.floor(
      R.divide(R.multiply(R.multiply(totalAmount, body.amount), 100), 100)
    );
    const availableAmountInCurrency = R.multiply(
      0.99,
      symbolsAmountsInCurrency[currency]
    );
    const buyForAmountInCurrency = R.gt(
      buyForAmountInCurrencyByRatio,
      availableAmountInCurrency
    )
      ? availableAmountInCurrency
      : buyForAmountInCurrencyByRatio;

    const buyValue = R.divide(
      buyForAmountInCurrency,
      R.prop("ask", tickerStructure)
    );
    const sellValue = total[body.symbol];

    const feeCond = R.ifElse(
      () => R.equals("sell", R.prop("action", body)),
      () => sellValue,
      () => buyValue
    );
    const fee = broker.calculateFee(
      `${symbol}/${currency}`,
      "market",
      body.action,
      feeCond(),
      body.price,
      "taker"
    );
    const feeWithBackupRatio = R.multiply(
      BACKUP_VALUE,
      options.fee || fee.rate
    );
    const amountToBuy = R.subtract(
      buyValue,
      R.multiply(buyValue, feeWithBackupRatio)
    );
    const amountToSell = sellValue;

    return {
      tickerStructure,
      broker,
      options,
      total,
      body,
      logger,
      currentTrade: {
        totalAmount,
        amountToSell,
        amountToBuy,
        amountAlreadyTraded: symbolsAmountsInCurrency[symbol],
        buyForAmountInCurrency,
      },
    };
  });

export const tickerFetcher = mergeMap(
  ({ options, logger, broker, body, total }) => {
    const { symbol, currency } = body;
    const ticker = `${symbol}/${currency}`;

    return from(broker.fetchTicker(ticker)).pipe(
      map((tickerStructure) => ({
        tickerStructure,
        body,
        logger,
        broker,
        total,
        options,
      }))
    );
  }
);

export const diversificationSetter = mergeMap(
  ({ tickerStructure, options, logger, broker, body, total }) => {
    return forkJoin(
      myTradesPromiseCreator({ tickerStructure, body, broker, options, total })
    ).pipe(
      tradeResultsMapper({
        tickerStructure,
        options,
        logger,
        broker,
        body,
        total,
      })
    );
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
  const { symbol, currency, type } = body;
  const ticker = `${symbol}/${currency}`;

  const orderCond = R.ifElse(
    () => R.equals("sell", R.prop("action", body)),
    () =>
      from(
        type === "market"
          ? broker.createMarketSellOrder(ticker, currentTrade.amountToSell)
          : broker.createLimitSellOrder(
              ticker,
              currentTrade.amountToSell,
              R.prop("bid", tickerStructure)
            )
      ),
    () =>
      from(
        type === "market"
          ? broker.createMarketBuyOrder(
              ticker,
              R.equals(true, R.prop("invertMarketBuyOrderValue", options))
                ? currentTrade.amountToBuy
                : currentTrade.buyForAmountInCurrency
            )
          : broker.createLimitBuyOrder(
              ticker,
              R.equals(true, R.prop("invertMarketBuyOrderValue", options))
                ? currentTrade.amountToBuy
                : currentTrade.buyForAmountInCurrency,
              R.prop("ask", tickerStructure)
            )
      )
  );

  const order$ = orderCond();
  return order$.pipe(
    retryWhen(
      genericRetryExecutor({
        excludedStatusCodes: [500, 400],
      })
    ),
    errorLogger,
    mergeMap((order) =>
      of({ tickerStructure, order, currentTrade, body, logger, broker, total })
    )
  );
};

export const transactionMaker = mergeMap(
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
    const checkerCond = R.ifElse(
      () => R.equals(body.mode, "trade"),
      () => {
        const { symbol, currency } = body;
        const ticker = `${symbol}/${currency}`;

        return from(broker.fetchOrder(order.id, ticker)).pipe(
          pluck("status"),
          mergeMap((status) => {
            return R.equals("closed", status)
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
                      message: `Trade completed successfully`,
                    });
                  })
                )
              : throwError("The status of the order isn`t closed");
          }),
          retryWhen(
            genericRetryExecutor({
              maxRetryAttempts: 10,
              scalingDuration: 270000,
              excludedStatusCodes: [500, 400],
              excludedNames: ["OrderNotFound"],
            })
          ),
          catchError((error) => {
            const notFound = error.name === "OrderNotFound";
            if (!notFound) {
              formatAndSendMessage({
                color: "red",
                type: "trade canceled",
                message: `${error} after maximum attempts. Going to retry the cycle...`,
              });
            } else {
              formatAndSendMessage({
                color: "green",
                type: "trade completed",
                message: `'OrderNotFound' but trade assumed as completed successfully`,
              });
            }
            return notFound
              ? of("Ignored")
              : from(broker.cancelOrder(order.id, ticker)).pipe(
                  tap(console.log),
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
    return checkerCond();
  }
);
