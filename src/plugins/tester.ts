const http = require("http");
const chalk = require("chalk");
const R = require("ramda");

const env = process.env.NODE_ENV || "development";

import config from "../../config";

const TIMEOUT = env === "production" ? 2000 : 0;

import { printMessage, formatMessage, getToken } from "../core/utils";

export const testerClient = () => {
  const brokerName = process.argv.slice(2)[0] || "degiro";
  const data = config["tester"][brokerName];
  const parsedExchangeName = R.contains("/", data.exchange)
    ? R.last(R.split("/", data.exchange))
    : data.exchange;
  const postData = JSON.stringify({
    ...data,
    token: getToken(
      config[brokerName][R.toLower(parsedExchangeName)].credentials
    ),
  });
  setTimeout(() => {
    const options = {
      hostname: env === "production" ? config["ngrok"]["address"] : "localhost",
      port: env === "production" ? "80" : "1337",
      path: `/${brokerName}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    printMessage(
      formatMessage({
        color: "cyan",
        type: "tester",
        message: "The Tester plugin is on",
      })
    );

    const req = http.request(options, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        printMessage(
          formatMessage({
            color: "cyan",
            type: "tester",
            message: "Test of the request completed successfully",
          })
        );
      });
    });

    req.on("error", (e) => {
      printMessage(
        formatMessage({
          color: "red",
          type: "tester",
          message: `There is a problem with a request: ${e.message}`,
        })
      );
    });
    req.write(postData);
    req.end();
  }, TIMEOUT);
};
