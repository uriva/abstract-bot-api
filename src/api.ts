import { context } from "https://deno.land/x/context_inject@0.0.3/src/index.ts";

import { gamla } from "./../deps.ts";

const { pipe } = gamla;

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

export const { inject: injectLastEvent, access: lastEvent } = context(
  (): ConversationEvent => {
    throw new Error("no user ID in context");
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

export const { inject: injectTyping, access: typing } = context(
  () => {
    console.log("Typing...");
    return Promise.resolve();
  },
);

export const withTyping = <
  // deno-lint-ignore no-explicit-any
  F extends (...params: any[]) => Promise<any>,
>(f: F): F =>
// @ts-expect-error ts cannot infer
async (...xs: Parameters<F>) => {
  await typing();
  return await f(...xs);
};

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

export type ConversationEvent = {
  text?: string;
  contact?: { phone: string; name: string };
  image?: string;
  caption?: string;
  ownPhone?: string;
};

export type TaskHandler = <T>() => Promise<T>;

export type UniqueUserId = string;

export type ChatEventPreSending = {
  key: string;
  text?: string;
  percentage?: number;
  spinner?: boolean;
  url?: string;
  urlText?: string;
};

export type ChatEvent = ChatEventPreSending & {
  time: number;
  from: string;
  to: string;
};

export const now = () => Date.now();

const makeKey = () => crypto.randomUUID();

export const genericInject = <T extends TaskHandler>(
  send: (x: ChatEventPreSending) => Promise<void>,
  userId: string,
) =>
  pipe(
    injectFileLimitMB(() => Number.POSITIVE_INFINITY)<T>,
    injectUserId(() => userId)<T>,
    injectProgressBar(async (text: string) => {
      const key = makeKey();
      await send({ key, text, percentage: 0 });
      return Promise.resolve((percentage: number) =>
        send({ key, text, percentage })
      );
    })<T>,
    injectSpinner(async (text: string) => {
      const key = makeKey();
      await send({ key, text, spinner: true });
      return () => send({ key, text, spinner: false });
    })<T>,
    injectReply(async (text: string) => {
      const key = makeKey();
      await send({ text, key });
      return key;
    })<T>,
    injectSendFile(pipe((url: string) => ({ url, key: makeKey() }), send))<T>,
  );
