import { combineRoutes } from "@marblejs/core";

import { ccxt$ } from "../brokers/ccxt/effect";
import { degiro$ } from "../brokers/degiro/effect";
import { uniswap$ } from "../brokers/uniswap/effect";

export const api$ = combineRoutes("/", { effects: [ccxt$, degiro$, uniswap$] });
