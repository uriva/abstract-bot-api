import { context, type Injection, type Injector } from "@uri/inject";
import { pipe } from "gamla";

const fileLimit: Injection<() => number> = context(() =>
  Number.POSITIVE_INFINITY
);

export const injectFileLimitMB = fileLimit.inject;
export const fileLimitMB = fileLimit.access;

const botPhoneInjection: Injection<() => string> = context(
  (): string => {
    throw new Error("no phone in context");
  },
);
export const botPhone = botPhoneInjection.access;
export const injectBotPhone = botPhoneInjection.inject;

type Medium =
  | "whatsapp"
  | "instantdb"
  | "green-api"
  | "telegram"
  | "websocket"
  | "no-medium";

const mediumInjection: Injection<() => Medium> = context((): Medium =>
  "no-medium"
);

export const injectMedium = mediumInjection.inject;
export const medium = mediumInjection.access;

const userIdInjection: Injection<() => string> = context((): string => {
  throw new Error("no user ID in context");
});
export const injectUserId = userIdInjection.inject;
export const userId = userIdInjection.access;

const messageIdInjection: Injection<() => string> = context((): string => {
  throw new Error("no message ID in context");
});
export const injectMessageId = messageIdInjection.inject;
export const messageId = messageIdInjection.access;

const referenceIdInjection: Injection<() => string> = context((): string => {
  throw new Error("no reference ID in context");
});
export const injectReferenceId = referenceIdInjection.inject;
export const referenceId = referenceIdInjection.access;

const lastEventInjection: Injection<() => ConversationEvent> = context(
  (): ConversationEvent => {
    throw new Error("no last event in context");
  },
);
export const injectLastEvent = lastEventInjection.inject;
export const lastEvent = lastEventInjection.access;

const replyInjection: Injection<(msg: string) => Promise<string>> = context(
  (msg: string): Promise<string> => {
    console.log("Reply:", msg);
    return Promise.resolve(crypto.randomUUID());
  },
);
export const injectReply = replyInjection.inject;
export const reply = replyInjection.access;

const sendFileInjection: Injection<(url: string) => Promise<void>> = context(
  (url: string) => {
    console.log("File:", url);
    return Promise.resolve();
  },
);
export const injectSendFile = sendFileInjection.inject;
export const sendFile = sendFileInjection.access;

const progressBarInjection: Injection<
  (text: string) => Promise<(percentage: number) => Promise<void>>
> = context((text: string) =>
  Promise.resolve((percentage: number) => {
    console.log("Progress:", text, (percentage * 100).toFixed());
    return Promise.resolve();
  })
);
export const injectProgressBar = progressBarInjection.inject;
export const progressBar = progressBarInjection.access;

const spinnerInjection: Injection<
  (text: string) => Promise<() => Promise<void>>
> = context((text: string) => {
  console.log("Spinner:", text);
  return Promise.resolve(() => Promise.resolve());
});
export const injectSpinner = spinnerInjection.inject;
export const spinner = spinnerInjection.access;

const typingInjection: Injection<() => Promise<void>> = context(() => {
  console.log("Typing...");
  return Promise.resolve();
});
export const injectTyping = typingInjection.inject;
export const typing = typingInjection.access;

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

// deno-lint-ignore no-explicit-any
export type TaskHandler = () => any;

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

export const now = (): number => Date.now();

const makeKey = (): string => crypto.randomUUID();

export const genericInject = (
  send: (x: ChatEventPreSending) => Promise<void>,
  userId: string,
  event: ConversationEvent,
): Injector =>
  pipe(
    injectLastEvent(() => event),
    injectFileLimitMB(() => Number.POSITIVE_INFINITY),
    injectUserId(() => userId),
    injectProgressBar(async (text: string) => {
      const key = makeKey();
      await send({ key, text, percentage: 0 });
      return Promise.resolve((percentage: number) =>
        send({ key, text, percentage })
      );
    }),
    injectSpinner(async (text: string) => {
      const key = makeKey();
      await send({ key, text, spinner: true });
      return () => send({ key, text, spinner: false });
    }),
    injectReply(async (text: string) => {
      const key = makeKey();
      await send({ text, key });
      return key;
    }),
    injectSendFile(pipe((url: string) => ({ url, key: makeKey() }), send)),
  );
