import { printMessage, getToken } from "./src/core/utils";
import config from "./config";

const broker = process.argv.slice(2)[0];
const exchange = process.argv.slice(2)[1];

printMessage(getToken(config[broker][exchange].credentials));
