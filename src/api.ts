import { getContextEntry } from "gamla";
import { basename } from "node:path";

const defaultContext = {
  fileLimitMB: () => Infinity,
  userId: () => "",
  // deno-lint-ignore no-explicit-any
  logAdmin: (msg: string): Promise<any> => {
    console.log(msg);
    return Promise.resolve();
  },
  // deno-lint-ignore no-explicit-any
  sendFile: (file: string): Promise<any> =>
    Deno.copyFile(file, `output-${basename(file)}`),
  // deno-lint-ignore no-explicit-any
  logText: (msg: string): Promise<any> => {
    console.log(msg);
    return Promise.resolve();
  },
  makeProgressBar: (text: string) => (percentage: number) => {
    console.log(text, (percentage * 100).toFixed());
  },
  spinner: (text: string) => {
    console.log(text);
    return () => {};
  },
  // deno-lint-ignore no-explicit-any
  logURL: (text: string, url: string, urlText: string): Promise<any> => {
    console.log(text, url, urlText);
    return Promise.resolve();
  },
};

export type Context = typeof defaultContext;

const fromContext = getContextEntry(defaultContext);

export const fileLimitMB = fromContext("fileLimitMB");
export const userIdInContext = fromContext("userId");
export const logInContext = fromContext("logText");
export const logAdminInContext = fromContext("logAdmin");
export const sendFileInContext = fromContext("sendFile");
export const logURLInContext = fromContext("logURL");
export const makeProgressBar = fromContext("makeProgressBar");

export const withSpinner = <
  // deno-lint-ignore no-explicit-any
  F extends (...params: any[]) => Promise<any>,
>(
  text: string,
  f: F,
): F =>
// @ts-expect-error ts cannot infer
async (...xs: Parameters<F>) => {
  const stopSpinning = fromContext("spinner")(text);
  try {
    const result = await f(...xs);
    stopSpinning();
    return result;
  } catch (e) {
    stopSpinning();
    throw e;
  }
};

export type AbstractIncomingMessage = { text: string };

export type TaskHandler =
  // deno-lint-ignore no-explicit-any
  (incoming: AbstractIncomingMessage) => Promise<any>;

export type UniqueUserId = string;
