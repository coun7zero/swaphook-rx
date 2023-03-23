// @ts-ignore
process.env.NTBA_FIX_319 = 1;

import { IO } from "fp-ts/lib/IO";

import { createServer, httpListener } from "@marblejs/core";
import { logger$ } from "@marblejs/middleware-logger";
import { bodyParser$, jsonParser } from "@marblejs/middleware-body";

import { api$ } from "./core/effects";
import { testerClient } from "./plugins/tester";

const env = process.env.NODE_ENV || "development";

const middlewares = [
  logger$(),
  bodyParser$({
    parser: jsonParser,
    type: ["application/json", "charset=utf-8"],
  }),
];
const effects = [api$];

const server = createServer({
  port: 1337,
  listener: httpListener({ middlewares, effects }),
});

const main: IO<void> = async () => await (await server)();
main();
