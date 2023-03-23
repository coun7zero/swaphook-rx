const R = require("ramda");

import { Subject } from "rxjs";
import { mergeMap, tap, distinctUntilChanged } from "rxjs/operators";

import { destroyBroker } from "../core/utils";

import { handler as ccxtHandler } from "../brokers/ccxt/handler";
import { handler as degiroHandler } from "../brokers/degiro/handler";
import { handler as uniswapHandler } from "../brokers/uniswap/handler";

const duplicatedRequestValidator = distinctUntilChanged(
  ({ body: currentBody }, { body: previousBody }) => {
    return R.all(R.equals(true), [
      R.equals(currentBody.timenow, previousBody.timenow),
      R.equals(currentBody.symbol, previousBody.symbol),
      R.equals(currentBody.action, previousBody.action),
    ]);
  }
);

const actionDispatcher$ = new Subject();
const actionSubscriber = (payload) => {
  destroyBroker(payload);
};

export const dispatcherEmitter = (config) =>
  tap(({ broker, logger, body, total, currentTrade }) => {
    const exchange = body.exchange;
    const currentTradeCond = R.ifElse(
      () => R.isNil(currentTrade),
      R.always({}),
      R.always(currentTrade)
    );
    return actionDispatcher$.next({
      options: config[body.broker][exchange].options,
      currentTrade: currentTradeCond(),
      broker,
      body,
      total,
      logger,
    });
  });

actionDispatcher$
  .pipe(
    duplicatedRequestValidator,
    mergeMap((response) => {
      const isEqual = R.curry((brokerName, request) =>
        R.pipe(R.prop("body"), R.prop("broker"), R.equals(brokerName))(request)
      );
      const dispatcherCondition = R.cond([
        [isEqual("ccxt"), ccxtHandler],
        [isEqual("degiro"), degiroHandler],
        [isEqual("uniswap"), uniswapHandler],
      ]);
      return dispatcherCondition(response);
    })
  )
  .subscribe(actionSubscriber);
