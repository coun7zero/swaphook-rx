const R = require("ramda");
const { request } = require("universal-rxjs-ajax");
const compareAsc = require("date-fns/compareAsc");
const fromUnixTime = require("date-fns/fromUnixTime");

const fs = require("fs");
const ethers = require("ethers");
const { ChainId, Fetcher } = require("@uniswap/sdk");

import {
  mergeMap,
  tap,
  catchError,
  map,
  pluck,
  skip,
  retryWhen,
} from "rxjs/operators";
import { pipe, of, forkJoin, throwError } from "rxjs";

import { formatAndSendMessage, formatToTable, errorLogger } from "./log";

import { deferAndRetry, retryOnErrorExectutor } from "./utils";

const contractExtractor = (symbol, contractAddress) =>
  mergeMap((tokens) => {
    const filteredTokens = R.filter(
      (token) => R.equals(R.prop("symbol", token), symbol),
      tokens
    );
    const onSameSymbols = () => {
      const findTokenByContractAdress = R.find((token) =>
        R.equals(R.prop("address", token), contractAddress)
      );
      const token = findTokenByContractAdress(filteredTokens);

      return R.and(R.not(R.isNil(contractAddress)), R.not(R.isNil(token)))
        ? of(token)
        : throwError({
            status: 500,
            message:
              "Two or more tokens use the same symbol. You have to define `contractAdress`manually",
          });
    };

    const symbolChecker = () =>
      R.isNil(filteredTokens[0])
        ? throwError({
            status: 500,
            message: "The symbol doesn`t exist",
          })
        : of(filteredTokens[0]);

    return R.gt(filteredTokens.length, 1) ? onSameSymbols() : symbolChecker();
  });

const etherscanResponseValidator = mergeMap((plainResponse) => {
  const response = R.prop("response", plainResponse);
  const errorOccurs = R.or(
    R.equals("NOTOK", R.prop("message", response)),
    R.equals("0", R.prop("status", response))
  );

  return errorOccurs ? throwError(response) : of(plainResponse);
});

const chainId = ChainId.MAINNET;

const mnemonicPhrase = fs.readFileSync("./.secret").toString().trim();

const brokerCreator = ({ body, config, logger }) => {
  const provider = ethers.getDefaultProvider(
    config["uniswap"].network,
    config["uniswap"].config
  );
  const etherscanProvider = new ethers.providers.EtherscanProvider(
    config["uniswap"].network,
    config["uniswap"].config.etherscan
  );
  const account = new ethers.Wallet.fromMnemonic(mnemonicPhrase);
  const wallet = account.connect(provider);

  const contractsAdresses$ = forkJoin({
    provider: of(provider),
    wallet: of(wallet),
    etherPriceGetter: of(() =>
      deferAndRetry(() => etherscanProvider.getEtherPrice())
    ),
    etherPrice: deferAndRetry(() => etherscanProvider.getEtherPrice()),
    etherBalance: deferAndRetry(() => wallet.getBalance()).pipe(
      map(ethers.utils.formatEther),
      map(parseFloat)
    ),
    currencyToken: request({
      url: "https://tokens.coingecko.com/uniswap/all.json",
      method: "GET",
    })
      .pipe(retryOnErrorExectutor)
      .pipe(
        pluck("response", "tokens"),
        contractExtractor(body.currency, body.contractAddress),
        pluck("address"),
        map(ethers.utils.getAddress)
      ),
    symbolToken: request({
      url: "https://tokens.coingecko.com/uniswap/all.json",
      method: "GET",
    })
      .pipe(retryOnErrorExectutor)
      .pipe(
        pluck("response", "tokens"),
        contractExtractor(body.symbol, body.contractAddress),
        pluck("address"),
        map(ethers.utils.getAddress)
      ),
  });

  const contractsDetails$ = contractsAdresses$.pipe(
    tap(({ currencyToken, symbolToken }) => {
      formatAndSendMessage({
        color: "green",
        type: "uniswap",
        message: `Conract adresses:
        * ${[
          body.currency,
        ]}: [${currencyToken}](https://etherscan.io/address/${currencyToken})
        * ${[
          body.symbol,
        ]}: [${symbolToken}](https://etherscan.io/address/${symbolToken})`,
      });
    }),
    mergeMap((broker) => {
      const { currencyToken, symbolToken, provider, wallet } = broker;
      return forkJoin({
        currentBlockNumber: deferAndRetry(() => provider.getBlockNumber()),
        walletAddress: deferAndRetry(() => wallet.getAddress()),
        currencyTokenData: deferAndRetry(() =>
          Fetcher.fetchTokenData(chainId, currencyToken, provider)
        ),
        symbolTokenData: deferAndRetry(() =>
          Fetcher.fetchTokenData(chainId, symbolToken, provider)
        ),
        abi: request({
          url: `https://api.etherscan.io/api?module=contract&action=getabi&address=${currencyToken}&apikey=${config["uniswap"].config.etherscan}`,
          method: "GET",
        })
          .pipe(etherscanResponseValidator, retryOnErrorExectutor)
          .pipe(
            pluck("response", "result"),
            map((stringifiedAbi: string) => JSON.parse(stringifiedAbi))
          ),
      }).pipe(map((responses) => ({ ...broker, ...responses })));
    })
  );
  const portfolio$ = contractsDetails$.pipe(
    mergeMap((broker) => {
      const {
        currentBlockNumber,
        walletAddress,
        currencyToken,
        currencyTokenData,
        symbolToken,
        symbolTokenData,
        wallet,
        abi,
      } = broker;
      const block30daysAgo = Math.ceil(
        parseInt(currentBlockNumber as string, 10) - (30 * 24 * 60 * 60) / 13.5
      );

      const currencyTokenContract = new ethers.Contract(
        currencyToken,
        abi,
        wallet
      );
      const symbolTokenContract = new ethers.Contract(symbolToken, abi, wallet);
      return forkJoin({
        currencyBalance: deferAndRetry(() =>
          currencyTokenContract.balanceOf(walletAddress)
        ).pipe(
          map((balance) =>
            ethers.utils.formatUnits(
              balance,
              R.prop("decimals", currencyTokenData)
            )
          )
        ),
        symbolBalance: deferAndRetry(() =>
          symbolTokenContract.balanceOf(walletAddress)
        ).pipe(
          map((balance) =>
            ethers.utils.formatUnits(
              balance,
              R.prop("decimals", symbolTokenData)
            )
          )
        ),
        historyData: request({
          url: `https://api.etherscan.io/api?module=account&action=tokentx&address=${walletAddress}&startblock=${block30daysAgo}&sort=asc&apikey=${config["uniswap"].config.etherscan}`,
          method: "GET",
        })
          .pipe(etherscanResponseValidator, retryOnErrorExectutor)
          .pipe(pluck("response", "result")),
      }).pipe(map((responses) => ({ ...broker, ...responses })));
    })
  );
  return portfolio$.pipe(
    mergeMap((broker) => {
      const { etherPrice } = broker;
      return of({
        body: { ...body, price: R.multiply(body.price, etherPrice) },
        logger,
        broker,
      });
    })
  );
};

const marketSetter =
  (config) =>
  ({ body, logger }) => {
    return brokerCreator({ body, config, logger });
  };

const balanceFetcher = (config) =>
  mergeMap(({ broker, body, logger }) => {
    const {
      historyData,
      walletAddress,
      currencyBalance,
      symbolBalance,
      etherBalance,
    } = broker;
    const historyMapped = R.map((el) => {
      return {
        ...el,
        gasPrice: ethers.utils.formatEther(el.gasPrice),
        value: ethers.utils.formatEther(el.value),
      };
    }, historyData);
    const outputTransactions = R.filter(
      (transaction) =>
        R.equals(R.toLower(transaction.from), R.toLower(walletAddress)),
      historyMapped
    );
    const completeTransactions = R.reduce(
      (collection, outputBuyTransaction) => {
        const inputTransaction = R.find(
          (transaction) =>
            transaction.hash === outputBuyTransaction.hash &&
            outputBuyTransaction.from === transaction.to &&
            (outputBuyTransaction.tokenSymbol === body.currency ||
              transaction.tokenSymbol === body.currency),
          historyMapped
        );
        return inputTransaction
          ? [
              ...collection,
              {
                timestamp: fromUnixTime(
                  parseInt(outputBuyTransaction.timeStamp)
                ),
                input: inputTransaction,
                output: outputBuyTransaction,
                tick: `${outputBuyTransaction.tokenSymbol}/${inputTransaction.tokenSymbol}`,
                value: outputBuyTransaction.value,
                amount: inputTransaction.value,
                type:
                  outputBuyTransaction.tokenSymbol === body.currency
                    ? "BUY"
                    : "SELL",
              },
            ]
          : collection;
      },
      [],
      outputTransactions
    );
    const sortedTransactionsByDate = R.sort(
      ({ timestamp: dateLeft }, { timestamp: dateRight }) =>
        compareAsc(dateLeft, dateRight),
      completeTransactions
    );

    const portfolio = R.filter(({ input, output, timestamp }) => {
      const seekingTick = `${input.tokenSymbol}/${output.tokenSymbol}`;
      const element = R.findLast(
        ({ tick }) => R.equals(seekingTick, tick),
        sortedTransactionsByDate
      );
      // Handle it in the validator at the beginning as well:
      const isExcluded = R.includes(
        input.tokenSymbol,
        config["uniswap"].options.excludedSymbols
      );
      return R.isNil(element)
        ? R.not(isExcluded)
        : timestamp > element.timestamp;
    }, sortedTransactionsByDate);

    const total = {
      ...R.mergeAll(
        R.map((transaction) => {
          return {
            [R.toUpper(transaction.input.tokenSymbol)]:
              ethers.utils.formatUnits(
                ethers.utils.parseEther(transaction.input.value),
                R.prop("tokenDecimal", transaction.input)
              ),
          };
        }, portfolio)
      ),
      [body.currency]: currencyBalance,
      [body.symbol]: symbolBalance,
      ["ETH"]: etherBalance,
    };

    return of({
      broker: { ...broker, total, portfolio, walletAddress },
      total,
      body,
      logger,
    });
  });

const balanceLogger = tap(({ total, body, logger }) => {
  return formatToTable({
    message: `The current position in ${body.exchange}:`,
    data: total,
  });
});

export const uniswapBroker = (config) => {
  return mergeMap(
    pipe(
      marketSetter(config),
      balanceFetcher(config),
      retryOnErrorExectutor,
      errorLogger,
      balanceLogger
    )
  );
};
