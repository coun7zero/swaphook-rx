const R = require("ramda");
const compareAsc = require("date-fns/compareAsc");
const parseISO = require("date-fns/parseISO");
const differenceInSeconds = require("date-fns/differenceInSeconds");

const ethers = require("ethers");
const {
  ChainId,
  Fetcher,
  WETH,
  Route,
  Trade,
  TokenAmount,
  TradeType,
  Percent,
} = require("@uniswap/sdk");

const RESERVE_TO_GAS = 200; // Move to config

const uniswapAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Move to config

import {
  from,
  forkJoin,
  of,
  defer,
  throwError,
  BehaviorSubject,
  ReplaySubject,
  Observable,
} from "rxjs";
import {
  map,
  tap,
  mergeMap,
  retryWhen,
  bufferTime,
  take,
  pluck,
  delay,
} from "rxjs/operators";

import { formatAndSendMessage, sendMessage, formatToTable } from "./log";
import {
  deferAndRetry,
  genericRetryExecutor,
  retryOnErrorExectutor,
} from "./utils";

const increaceGasLimit = map(
  R.pipe(
    R.invoker(0, "toNumber"),
    R.multiply(150),
    R.flip(R.divide)(100),
    Math.round,
    ethers.BigNumber.from
  )
);

const gasChecker = ({ body }) =>
  mergeMap((payload) => {
    // FIX ME!!!
    // @ts-ignore
    const { gasLimit, gasPrice, etherPrice } = payload;
    const maxGasPrice = Math.ceil(R.divide(RESERVE_TO_GAS, 6));
    const estimatedMaxGasPrice = Math.ceil(
      R.multiply(
        etherPrice,
        ethers.utils.formatUnits(
          R.multiply(gasLimit, gasPrice, "gwei").toString(),
          "ether"
        )
      )
    );
    const insufficientFunds = R.gte(estimatedMaxGasPrice, maxGasPrice);
    const cond = R.ifElse(
      () => insufficientFunds,
      () =>
        throwError({
          code: "INSUFFICIENT_FUNDS",
          rewrite: {
            maxRetryAttempts: 144,
            scalingDuration: 300000, //12 hours
            includedStatusCodes: ["INSUFFICIENT_FUNDS"],
            enableAttemptMultiplier: false,
          },
          message: "The gas price is too high. Retrying in 5 minutes",
        }),
      () => of(payload)
    );
    const statusChecker = mergeMap(() => cond());

    const printEstimatedGasSettings = tap(() => {
      return R.ifElse(
        () => insufficientFunds,
        () => {
          sendMessage(
            `Insufficient funds for ${body.symbol}/${body.currency} transaction. Retrying...`
          );
          return R.always(null);
        },
        () => R.always(null)
      );
    });

    return of(payload).pipe(printEstimatedGasSettings, statusChecker);
  });

const logTransaction = (type) =>
  tap((transaction) => {
    const hash = R.prop("hash", transaction);
    formatAndSendMessage({
      color: "green",
      type,
      message: `Transaction hash: [${hash}](https://etherscan.io/tx/${hash})`,
    });
  });

const transactionHandler = (provider) =>
  mergeMap((transaction) => {
    const hash = R.prop("hash", transaction);
    return defer(() => provider.waitForTransaction(hash, 1, 60000))
      .pipe(
        retryWhen(
          genericRetryExecutor({
            maxRetryAttempts: 10,
            scalingDuration: 60000,
            includedStatusCodes: ["TIMEOUT"],
          })
        )
      )
      .pipe(
        mergeMap((receipt) => {
          return R.equals(1, R.prop("status", receipt))
            ? of(receipt)
            : throwError({
                message: "Transaction reverted",
              });
        })
      );
  });

const logReceipt = (type) =>
  tap((receipt) => {
    const blockNumber = R.prop("blockNumber", receipt);
    formatAndSendMessage({
      color: "green",
      type,
      message: `The transaction was mined in block ${blockNumber}`,
    });
  });

export const diversificationSetter = mergeMap(
  ({ broker, body, options, logger }) => {
    const { total, portfolio, walletAddress } = broker;
    const balanceProcessor = R.pipe(
      R.indexBy(R.pipe(R.prop("input"), R.prop("tokenSymbol"), R.toUpper)),
      R.map(({ output }) => {
        const { tokenDecimal, value } = output;
        return parseFloat(
          ethers.utils.formatUnits(ethers.utils.parseEther(value), tokenDecimal)
        );
      })
    );

    const simplePortfolio = R.mergeAll({
      ...balanceProcessor(portfolio),
      [body.currency]: parseFloat(total[body.currency]),
    });
    formatToTable({
      message: `The current amount in currency in uniswap':`,
      data: simplePortfolio,
    });

    const totalAmount = R.sum(R.values(simplePortfolio));

    const calculatedBuyForAmountInCurrency = R.multiply(
      totalAmount,
      body.amount
    ).toFixed(2);
    const fixedCurrencyFromPortfolio =
      simplePortfolio[body.currency].toFixed(2);
    const realCalculatedBuyForAmountInCurrency = R.gt(
      parseFloat(calculatedBuyForAmountInCurrency),
      parseFloat(fixedCurrencyFromPortfolio)
    )
      ? fixedCurrencyFromPortfolio
      : calculatedBuyForAmountInCurrency;

    const amountToBuy = R.divide(calculatedBuyForAmountInCurrency, body.price);
    return of({
      broker,
      body,
      tickerStructure: {
        ask: R.prop("price", body),
      },
      options,
      total,
      logger,
      currentTrade: {
        totalAmount,
        amountToSell: R.propOr(0, [body.symbol])(total),
        amountToBuy,
        amountAlreadyTraded: R.propOr(0, [body.symbol])(simplePortfolio),
        buyForAmountInCurrency: realCalculatedBuyForAmountInCurrency,
      },
    });
  }
);

const orderHandler = ({
  currentTrade,
  logger,
  options,
  body,
  broker,
  total,
}) => {
  const {
    walletAddress,
    wallet,
    provider,
    symbolTokenData,
    currencyTokenData,
    etherPriceGetter,
  } = broker;
  const chainId = ChainId.MAINNET;
  const { buyForAmountInCurrency, amountToSell } = currentTrade;
  const weth = WETH[chainId];
  return forkJoin({
    currencyTokenData: of(currencyTokenData),
    symbolTokenData: of(symbolTokenData),
    pair1: R.equals("sell", R.prop("action", body))
      ? deferAndRetry(() =>
          Fetcher.fetchPairData(weth, symbolTokenData, provider)
        )
      : deferAndRetry(() =>
          Fetcher.fetchPairData(weth, currencyTokenData, provider)
        ),
    pair2: R.equals("sell", R.prop("action", body))
      ? deferAndRetry(() =>
          Fetcher.fetchPairData(currencyTokenData, weth, provider)
        )
      : deferAndRetry(() =>
          Fetcher.fetchPairData(symbolTokenData, weth, provider)
        ),
  }).pipe(
    mergeMap(({ pair1, pair2, currencyTokenData, symbolTokenData }) => {
      const cond = R.ifElse(
        () => R.equals("sell", R.prop("action", body)),
        () => {
          const route = new Route([pair1, pair2], symbolTokenData);
          const path = [
            R.prop("address", symbolTokenData),
            R.prop("address", weth),
            R.prop("address", currencyTokenData),
          ];
          const trade = new Trade(
            route,
            new TokenAmount(
              symbolTokenData,
              ethers.utils.parseUnits(
                amountToSell,
                R.prop("decimals", symbolTokenData)
              )
            ),
            TradeType.EXACT_INPUT
          );
          return {
            route,
            path,
            trade,
          };
        },
        () => {
          const route = new Route([pair1, pair2], currencyTokenData);
          const path = [
            R.prop("address", currencyTokenData),
            R.prop("address", weth),
            R.prop("address", symbolTokenData),
          ];

          const trade = new Trade(
            route,
            new TokenAmount(
              currencyTokenData,
              ethers.utils.parseUnits(
                buyForAmountInCurrency,
                R.prop("decimals", currencyTokenData)
              )
            ),
            TradeType.EXACT_INPUT
          );
          return {
            route,
            path,
            trade,
          };
        }
      );
      return of(cond());
    }),
    tap(({ route, trade }) => {
      // https://uniswap.org/docs/v2/javascript-SDK/pricing/
      return formatToTable({
        message: `Current pricing in Uniswap:`,
        data: {
          inputMidPrice: route.midPrice.toSignificant(6),
          outputMidPrice: route.midPrice.invert().toSignificant(6),
          executionPrice: trade.executionPrice.toSignificant(6),
          nextMidPrice: trade.nextMidPrice.toSignificant(6),
        },
      });
    }),
    mergeMap(({ trade, path }) => {
      const slippageTolerance = new Percent("50", "10000");
      const amountOutMin = trade.minimumAmountOut(slippageTolerance).raw;
      const amountInMax = trade.maximumAmountIn(slippageTolerance).raw;
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const uniswapContract = new ethers.Contract(
        uniswapAddress,
        [
          `function swapExactTokensForTokens(
            uint amountIn,
            uint amountOutMin,
            address[] calldata path,
            address to,
            uint deadline
          )`,
        ],
        wallet
      );
      return deferAndRetry(() => {
        return forkJoin({
          gasPrice: deferAndRetry(() => wallet.getGasPrice()),
          uniswapContract: of(uniswapContract),
          amountInMax: of(amountInMax),
          amountOutMin: of(amountOutMin),
          path: of(path),
          deadline: of(deadline),
          etherPrice: etherPriceGetter(),
        })
          .pipe(
            mergeMap((payload) => {
              return from(
                uniswapContract.estimateGas.swapExactTokensForTokens(
                  ethers.BigNumber.from(amountInMax.toString()).toHexString(),
                  ethers.BigNumber.from(amountOutMin.toString()).toHexString(),
                  path,
                  walletAddress,
                  deadline
                )
              ).pipe(
                increaceGasLimit,
                map((gasLimit) => ({ ...payload, gasLimit })),
                gasChecker({ body })
              );
            })
          )
          .toPromise();
      });
    }),
    mergeMap(
      ({
        gasLimit,
        gasPrice,
        uniswapContract,
        amountInMax,
        amountOutMin,
        path,
        deadline,
      }) => {
        return deferAndRetry(() =>
          R.prop("swapExactTokensForTokens", uniswapContract)(
            ethers.BigNumber.from(amountInMax.toString()).toHexString(),
            ethers.BigNumber.from(amountOutMin.toString()).toHexString(),
            path,
            walletAddress,
            deadline,
            {
              gasPrice,
              gasLimit,
            }
          )
        );
      }
    ),
    logTransaction("swapExactTokensForTokens"),
    transactionHandler(provider),
    logReceipt("swapExactTokensForTokens")
  );
};

export const transactionMaker = mergeMap(
  ({ tickerStructure, options, currentTrade, body, logger, broker, total }) => {
    const makerCond = R.ifElse(
      () => R.equals(body.mode, "trade"),
      () => {
        return orderHandler({
          currentTrade,
          body,
          logger,
          broker,
          total,
          options,
        });
      },
      () => of({ currentTrade, body, logger, broker, total })
    );
    return makerCond();
  }
);

const ETH_SWAP_MINUTES_DURATION = 5;
const lastSwapFromCurrencyToETHBuffer$ = new BehaviorSubject({
  status: null,
  timestamp: null,
  promise: null,
});
const lastSwapFromCurrencyToETH$ = lastSwapFromCurrencyToETHBuffer$.pipe(
  take(1)
);
const swapCurrencyToETH = (amountToSell, { broker, body, options, logger }) => {
  const {
    provider,
    currencyTokenData,
    wallet,
    walletAddress,
    etherPriceGetter,
  } = broker;
  const chainId = ChainId.MAINNET;
  const weth = WETH[chainId];
  const createOrder = () =>
    deferAndRetry(() =>
      Fetcher.fetchPairData(weth, currencyTokenData, provider)
    )
      .pipe(
        mergeMap((pair) => {
          const route = new Route([pair], currencyTokenData);
          const path = [
            R.prop("address", currencyTokenData),
            R.prop("address", weth),
          ];

          const trade = new Trade(
            route,
            new TokenAmount(
              currencyTokenData,
              ethers.utils.parseUnits(
                amountToSell,
                R.prop("decimals", currencyTokenData)
              )
            ),
            TradeType.EXACT_INPUT
          );
          const slippageTolerance = new Percent("50", "10000");
          const amountOutMin = trade.minimumAmountOut(slippageTolerance).raw;
          const amountInMax = trade.maximumAmountIn(slippageTolerance).raw;
          const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

          const uniswapContract = new ethers.Contract(
            uniswapAddress,
            [
              `function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
  external
  returns (uint[] memory amounts)`,
            ],
            wallet
          );
          return deferAndRetry(() => {
            return forkJoin({
              gasPrice: deferAndRetry(() => wallet.getGasPrice()),
              etherPrice: etherPriceGetter(),
            })
              .pipe(
                mergeMap((payload) => {
                  return from(
                    uniswapContract.estimateGas.swapExactTokensForETH(
                      ethers.BigNumber.from(
                        amountInMax.toString()
                      ).toHexString(),
                      ethers.BigNumber.from(
                        amountOutMin.toString()
                      ).toHexString(),
                      path,
                      walletAddress,
                      deadline
                    )
                  ).pipe(
                    increaceGasLimit,
                    map((gasLimit) => ({ ...payload, gasLimit })),
                    gasChecker({ body })
                  );
                })
              )
              .toPromise();
          }).pipe(
            mergeMap(({ gasLimit, gasPrice }) => {
              // return deferAndRetry(() => {
              //   const promise = new Promise((resolve, reject) => {
              //     setTimeout(() => {
              //       memory = memory + 1;
              //       return memory === 10
              //         ? resolve("ok")
              //         : reject(new Error("error"));
              //     }, 200);
              //   });

              //   return promise;
              // });
              return deferAndRetry(() =>
                uniswapContract.swapExactTokensForETH(
                  ethers.BigNumber.from(amountInMax.toString()).toHexString(),
                  ethers.BigNumber.from(amountOutMin.toString()).toHexString(),
                  path,
                  walletAddress,
                  deadline,
                  {
                    gasLimit,
                    gasPrice,
                  }
                )
              );
            }),
            logTransaction("swapExactTokensForETH"),
            transactionHandler(provider),
            logReceipt("swapExactTokensForETH")
          );
        })
      )
      .toPromise();

  const updateCurrencyValue = () => {
    const newCurrencyValue =
      broker.total[body.currency] - parseFloat(amountToSell);
    return {
      broker: {
        ...broker,
        total: { ...broker.total, [body.currency]: newCurrencyValue },
      },
      body,
      options,
      logger,
    };
  };
  return new Observable((subscriber) => {
    lastSwapFromCurrencyToETH$.subscribe(({ promise, status, timestamp }) => {
      const timenow = new Date();
      const timeDuration = R.gte(
        ETH_SWAP_MINUTES_DURATION,
        R.divide(differenceInSeconds(timenow, timestamp), 60)
      );
      const cond = R.cond([
        [
          () => R.and(R.equals("completed", status), timeDuration),
          () => {
            formatAndSendMessage({
              color: "green",
              type: `ETH Swap`,
              message: `The order is already completed`,
            });
            subscriber.next(updateCurrencyValue());
            subscriber.complete();
          },
        ],
        [
          () => R.equals("pending", status),
          () => {
            formatAndSendMessage({
              color: "yellow",
              type: `ETH Swap`,
              message: `The order already exists and is pending`,
            });
            from(promise).subscribe({
              next: () => {
                subscriber.next(updateCurrencyValue());
                subscriber.complete();
              },
              error: (err) => {
                subscriber.error(err);
                formatAndSendMessage({
                  color: "red",
                  type: `ETH Swap`,
                  message: `The order is failed`,
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
              type: `ETH Swap`,
              message: `The order is created`,
            });
            const newPromise = createOrder();
            lastSwapFromCurrencyToETHBuffer$.next({
              status: "pending",
              promise: newPromise,
              timestamp: timenow,
            });
            from(newPromise).subscribe({
              next: () => {
                subscriber.next(updateCurrencyValue());
                formatAndSendMessage({
                  color: "blue",
                  type: `ETH Swap`,
                  message: `The order is completed`,
                });
                lastSwapFromCurrencyToETHBuffer$.next({
                  status: "completed",
                  timestamp: new Date(),
                  promise: null,
                });
                subscriber.complete();
              },
              error: (err) => {
                subscriber.error(err);
                formatAndSendMessage({
                  color: "red",
                  type: `ETH Swap`,
                  message: `The order is failed`,
                });
                lastSwapFromCurrencyToETHBuffer$.next({
                  status: "failed",
                  timestamp: new Date(),
                  promise: null,
                });
                subscriber.complete();
              },
            });
          },
        ],
      ]);
      return cond();
    });
  });
};

export const balanceChecker = mergeMap(({ broker, body, options, logger }) => {
  const { etherPrice, etherBalance, currencyBalance } = broker;
  const currentBalanceInUSD = R.multiply(etherPrice, etherBalance);
  const lowerThanLimit = R.lt(currentBalanceInUSD, RESERVE_TO_GAS);
  const difference = R.subtract(RESERVE_TO_GAS, currentBalanceInUSD);
  const amountToSell = `${RESERVE_TO_GAS}`;

  const cond = R.ifElse(
    () =>
      R.and(lowerThanLimit, R.lt(0.5, R.divide(difference, RESERVE_TO_GAS))),
    () => swapCurrencyToETH(amountToSell, { broker, body, options, logger }),
    () => of({ broker, body, options, logger })
  );

  return R.lte(parseFloat(currencyBalance), amountToSell)
    ? throwError({
        status: 500,
        message: "Not enough balance",
      })
    : cond();
});

export const allowanceChecker = mergeMap(
  ({ broker, body, options, logger }) => {
    const {
      abi,
      wallet,
      symbolToken,
      currencyToken,
      walletAddress,
      provider,
      etherPriceGetter,
    } = broker;
    const currentDirection = R.equals("sell", R.prop("action", body))
      ? symbolToken
      : currencyToken;
    const token = new ethers.Contract(currentDirection, abi, wallet);

    return deferAndRetry(() =>
      token.allowance(walletAddress, uniswapAddress)
    ).pipe(
      map((allowance) =>
        allowance.isZero()
          ? 0
          : ethers.constants.MaxUint256.div(allowance).toNumber()
      ),
      mergeMap((allowance) => {
        const cond = R.ifElse(
          () => R.not(R.equals(1, allowance)),
          () => {
            return deferAndRetry(() => {
              return forkJoin({
                gasPrice: deferAndRetry(() => wallet.getGasPrice()),
                etherPrice: etherPriceGetter(),
              })
                .pipe(
                  mergeMap((payload) => {
                    return from(
                      token.estimateGas.approve(
                        uniswapAddress,
                        ethers.constants.MaxUint256
                      )
                    ).pipe(
                      increaceGasLimit,
                      map((gasLimit) => ({ ...payload, gasLimit })),
                      gasChecker({ body })
                    );
                  })
                )
                .toPromise();
            }).pipe(
              mergeMap(({ gasPrice, gasLimit }) => {
                return deferAndRetry(() =>
                  token.approve(uniswapAddress, ethers.constants.MaxUint256, {
                    gasPrice,
                    gasLimit,
                  })
                );
              }),
              logTransaction("approve"),
              transactionHandler(provider),
              logReceipt("approve"),
              mergeMap(() => {
                return of({
                  broker,
                  body,
                  options,
                  logger,
                });
              })
            );
          },
          () => of({ broker, body, options, logger })
        );
        return cond();
      })
    );
  }
);

const lastRequestsBuffer$ = new ReplaySubject(
  Number.POSITIVE_INFINITY,
  5 * 24 * 60 * 60 * 1000
);
export const queueChecker = mergeMap(
  ({ broker, body, options, logger }) =>
    new Observable(function (subscriber) {
      const similarRequestMapper = R.filter((el) => {
        return R.and(
          R.equals(body.symbol, el.symbol),
          R.equals(body.currency, el.currency)
        );
      });
      const newestRequestMapper = R.findLast((el) => {
        return R.gte(
          compareAsc(parseISO(el.timenow), parseISO(body.timenow)),
          0
        );
      });

      const filteredLastRequestStatus$ = lastRequestsBuffer$.pipe(
        bufferTime(0),
        take(1),
        map(similarRequestMapper),
        map(newestRequestMapper)
      );
      const subscription = filteredLastRequestStatus$.subscribe(
        (foundRequest) => {
          const valueType = R.isNil(foundRequest)
            ? -1
            : compareAsc(
                parseISO(R.prop("timenow", foundRequest)),
                parseISO(body.timenow)
              );
          const cond = R.cond([
            [
              () => R.equals(-1, valueType),
              () => {
                lastRequestsBuffer$.next(body);
                subscriber.next({ broker, body, options, logger });
                subscriber.complete();
              },
            ],
            [
              () => R.equals(0, valueType),
              () => {
                subscriber.next({ broker, body, options, logger });
                subscriber.complete();
              },
            ],
            [
              R.T,
              () => {
                const error = new Error("The newer request exists already");
                //@ts-ignore
                error.status = 500;
                subscriber.error(error);
                subscriber.complete();
              },
            ],
          ]);
          subscription.unsubscribe();
          return cond();
        }
      );
    })
);
