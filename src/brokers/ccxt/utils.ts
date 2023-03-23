import {
  genericRetryExecutorFactory,
  deferAndRetryFactory,
  retryOnErrorExectutorFactory,
} from "../../core/mixins";

import { sendMessage } from "./log";

export const genericRetryExecutor = genericRetryExecutorFactory(sendMessage);

export const deferAndRetry = deferAndRetryFactory(genericRetryExecutor);

export const retryOnErrorExectutor =
  retryOnErrorExectutorFactory(genericRetryExecutor);
