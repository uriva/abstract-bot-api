import { gamla } from "../deps.ts";

const { context } = gamla;

export const { inject: injectFileLimitMB, access: fileLimitMB } = context(() =>
  Infinity
);
export const { inject: injectBotPhone, access: botPhone } = context(():
  | string
  | null => null
);

export const { inject: injectUserId, access: userId } = context(() => "");

export const { inject: injectReply, access: reply } = context(
  // deno-lint-ignore no-explicit-any
  (msg: string): Promise<any> => {
    console.log("mock `reply`", msg);
    return Promise.resolve();
  },
);

export const { inject: injectSendFile, access: sendFile } = context((
  url: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> => Promise.resolve(console.log(`Mock \`sendFile\`: ${url}`)));

export const { inject: injectProgressBar, access: progressBar } = context((
  text: string,
) =>
  Promise.resolve((percentage: number) => {
    console.log(text, (percentage * 100).toFixed());
    return Promise.resolve();
  })
);

export const { inject: injectSpinner, access: spinner } = context(
  (text: string) => {
    console.log(text);
    return Promise.resolve(() => Promise.resolve());
  },
);

export const withSpinner = <
  // deno-lint-ignore no-explicit-any
  F extends (...params: any[]) => Promise<any>,
>(
  text: string,
  f: F,
): F =>
// @ts-expect-error ts cannot infer
async (...xs: Parameters<F>) => {
  const stopSpinning = await spinner(text);
  try {
    const result = await f(...xs);
    await stopSpinning();
    return result;
  } catch (e) {
    await stopSpinning();
    throw e;
  }
};

export type AbstractIncomingMessage = {
  text?: string;
  contact?: { phone: string; name: string };
  image?: string;
  caption?: string;
  ownPhone?: string;
};

export type TaskHandler =
  // deno-lint-ignore no-explicit-any
  (incoming: AbstractIncomingMessage) => Promise<any>;

export type UniqueUserId = string;
