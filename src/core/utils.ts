const R = require("ramda");
const chalk = require("chalk");
const crypto = require("crypto");

const Table = require("cli-table");

const createWelcomeScreen = () => {
  const version = "1.0.0";

  const welcomeScreen = `
   swaphook @ ${version}           \`/sh-
                               ./shy+.
                              :Nd.
              ydooo: /oosdo    \`hh\`
              .mh      \`md\`      hy
               .Nh    \`md\`       .M:
                -Nh  \`mm\`         hy
                 yM- +M+          yh
    \`o          sM:   oM/         mo
    :N.        oM:     oM:       /N.
     sd\`      +Mo..\` ...yM:     -N/
      om-     :::::- -:::::    /N/
       -dy.                  :dh.
         :hh+-            -ods-
           \`:shhyso++osyhho-
                \`.----.
                `;
  return welcomeScreen;
};

export const printWelcomeScreen = (sendTelegramMessage) => {
  const formattedTelegramWelcomeScreen = `*Welcome*
  \`\`\`bash
${createWelcomeScreen()}
  \`\`\`
  `;

  sendTelegramMessage(formattedTelegramWelcomeScreen);
};

export const printMessage = (message) => {
  process.stdout.write(new Date().toISOString() + "\n");
  process.stdout.write(message + "\n");
};
printMessage(`${chalk.bold("Welcome")}\n${createWelcomeScreen()}`);

export const formatMessage = ({ color, type, message }) => {
  return `${chalk[color].inverse(` ${type} `)} ${chalk[color].bold(message)}`;
};

export const formatTelegramMessage = ({ color, type, message }) => {
  return `*${type}*
  ${message}
  `;
};

export const formatAndSendMessageFactory = (sendTelegramMessage) => (data) => {
  printMessage(formatMessage(data));
  sendTelegramMessage(formatTelegramMessage(data));
};

export const formatToTableFactory =
  (sendTelegramMessage) =>
  ({ color = "blue", type = "fetched data", message, data }) => {
    const table = new Table({
      chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
    });
    R.forEach(
      (row) => table.push(row),
      R.values(R.mapObjIndexed((value, key) => ({ [key]: value }))(data))
    );
    const stringifiedTable = table.toString();
    const formattedMessage = `${formatMessage({
      color,
      type,
      message,
    })}\n${stringifiedTable}`;
    const formattedTelegramMessage = `*${type}*
  ${message}:
  \`\`\`bash
${stringifiedTable}
  \`\`\`
  `;
    printMessage(formattedMessage);
    sendTelegramMessage(formattedTelegramMessage);
  };

export const destroyBroker = (payload) => {
  // In the future, include logout from the session
  delete payload.broker;
};

export const getToken = ({ secret, key }) => {
  return crypto.createHmac("sha256", secret).update(key).digest("base64");
};

export const tokenValidator = (token, { secret, key }) => {
  return R.equals(getToken({ secret, key }), token);
};
