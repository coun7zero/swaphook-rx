const R = require("ramda");

import DeGiro, { DeGiroEnums, DeGiroTypes } from "degiro-api";
const { PORTFOLIO_POSITIONS_TYPE_ENUM } = DeGiroEnums;

import { mergeMap, tap, catchError, map, skip } from "rxjs/operators";
import { pipe, of, throwError, from, iif, forkJoin } from "rxjs";

import { HttpError, HttpStatus } from "@marblejs/core";

import { formatToTable, errorLogger } from "./log";
import { deferAndRetry } from "./utils";

const brokerCreator = ({ body, config, logger }) => {
  const broker = new DeGiro(config["degiro"]["config"]);
  return deferAndRetry(() => broker.login()).pipe(
    map(() => ({
      body,
      logger,
      broker,
    }))
  );
};

const marketSetter =
  (config) =>
  ({ body, logger }) =>
    iif(
      () => config[body.exchange],
      brokerCreator({ body, config, logger }),
      throwError(
        new HttpError(
          JSON.stringify("Cannot find an exchange or API config"),
          HttpStatus.BAD_REQUEST
        )
      )
    );

const balanceFetcher = mergeMap(({ broker, body, logger }) => {
  return forkJoin(
    deferAndRetry(() =>
      broker.getPortfolio({
        type: PORTFOLIO_POSITIONS_TYPE_ENUM.OPEN,
        getProductDetails: false,
      })
    ).pipe(
      mergeMap((total) => {
        return deferAndRetry(() =>
          broker.getProductsByIds(
            R.map((product) => R.prop("id", product), total)
          )
        ).pipe(
          map((names) => {
            return {
              name: "products",
              raw: total,
              reduced: R.reduce(
                (acc, { id, plBase }) => ({
                  [names[id].symbol]: R.or(
                    Math.abs(plBase["EUR"]).toFixed(2),
                    0
                  ),
                  ...acc,
                }),
                {},
                total
              ),
            };
          })
        );
      })
    ),
    deferAndRetry(() => broker.getCashFunds()).pipe(
      map((total) => ({
        name: "funds",
        raw: total,
        reduced: R.reduce(
          (acc, { currencyCode, value }) => ({
            [currencyCode]: R.or(value, 0),
            ...acc,
          }),
          {},
          total
        ),
      }))
    )
  ).pipe(
    map((response) => {
      return {
        raw: R.prop("raw", R.find(R.propEq("name", "products"), response)),
        total: R.mergeAll(R.map(R.prop("reduced"), response)),
      };
    }),
    //@ts-ignore
    map(({ total, raw }) => ({
      total: {
        [body["symbol"]]: 0,
        ...total,
        // ignore or convert to EUR
        PLN: 0,
      },
      raw,
    })),
    map(({ total, raw }) => ({ broker, total, raw, body, logger }))
  );
});

const balanceLogger = tap(({ total, body, logger }) => {
  return formatToTable({
    message: `Current position at degiro:`,
    data: total,
  });
});

const portfolioValidator = mergeMap(({ raw, broker, total, body, logger }) => {
  // We should rewrite all `from` executions like in Uniswap with proper error handling. Additionally, add information about the validator with required `isin` if it cannot find the given symbol
  const text = R.has("isin", body)
    ? R.prop("isin", body)
    : R.prop("symbol", body);

  return deferAndRetry(() => broker.searchProduct({ text })).pipe(
    mergeMap((response) => {
      const foundProduct = R.find(
        (product) =>
          R.and(
            R.propEq("currency", R.prop("currency", body))(product),
            R.propEq("symbol", R.prop("symbol", body))(product)
          ),
        response
      );
      const productId = R.prop("id", foundProduct);
      const currentAmount = R.propOr(
        0,
        "size",
        R.find((product) => R.equals(productId, R.prop("id", product)), raw)
      );

      return iif(
        () => {
          return !R.isNil(foundProduct);
        },
        of({
          broker,
          total,
          body: {
            ...body,
            productId,
            price: parseFloat(R.prop("price", body)).toFixed(2),
          },
          currentTrade: { amountToSell: currentAmount },
          logger,
        }),
        throwError(
          new HttpError(
            "The provided symbol isn't valid",
            HttpStatus.BAD_REQUEST
          )
        )
      );
    })
  );
});

export const degiroBroker = (config) => {
  return mergeMap(
    pipe(
      marketSetter(config),
      balanceFetcher,
      portfolioValidator,
      errorLogger,
      balanceLogger
    )
  );
};
