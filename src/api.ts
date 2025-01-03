import { context } from "https://deno.land/x/context_inject@0.0.3/src/index.ts";

export const { inject: injectFileLimitMB, access: fileLimitMB } = context(() =>
  Number.POSITIVE_INFINITY
);

export const { inject: injectBotPhone, access: botPhone } = context(
  (): string => {
    throw new Error("no phone in context");
  },
);

type Medium =
  | "whatsapp"
  | "instantdb"
  | "green-api"
  | "telegram"
  | "websocket"
  | "no-medium";

export const { inject: injectMedium, access: medium } = context((): Medium =>
  "no-medium"
);

export const { inject: injectUserId, access: userId } = context((): string => {
  throw new Error("no user ID in context");
});

export const { inject: injectMessageId, access: messageId } = context(
  (): string => {
    throw new Error("no message ID in context");
  },
);

export const { inject: injectReferenceId, access: referenceId } = context(
  (): string => {
    throw new Error("no reference ID in context");
  },
);

export const { inject: injectReply, access: reply } = context(
  (msg: string): Promise<string> => {
    console.log("Reply:", msg);
    return Promise.resolve(crypto.randomUUID());
  },
);

export const { inject: injectSendFile, access: sendFile } = context((
  url: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> => {
  console.log("File:", url);
  return Promise.resolve();
});

export const { inject: injectProgressBar, access: progressBar } = context((
  text: string,
) =>
  Promise.resolve((percentage: number) => {
    console.log("Progress:", text, (percentage * 100).toFixed());
    return Promise.resolve();
  })
);

export const { inject: injectSpinner, access: spinner } = context(
  (text: string) => {
    console.log("Spinner:", text);
    return Promise.resolve(() => Promise.resolve());
  },
);

export const withSpinner = <
  // deno-lint-ignore no-explicit-any
  F extends (...params: any[]) => Promise<any>,
>(text: string, f: F): F =>
// @ts-expect-error ts cannot infer
async (...xs: Parameters<F>) => {
  let stopSpinning: (() => Promise<void>) | undefined;
  const spinnerTimeout = setTimeout(async () => {
    stopSpinning = await spinner(text);
  }, 5000);

  try {
    return await f(...xs);
  } finally {
    clearTimeout(spinnerTimeout);
    if (stopSpinning) await stopSpinning();
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

// deno-lint-ignore no-explicit-any
export type RetainsType = <F extends (...xs: any[]) => any>(f: F) => F;
