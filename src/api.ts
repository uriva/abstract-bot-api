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
  | "alice-and-bot"
  | "email"
  | "whatsapp"
  | "facebook-messenger"
  | "green-api"
  | "slack"
  | "telegram"
  | "microsoft-teams"
  | "supergreen/whatsapp"
  | "supergreen/telegram"
  | "no-medium"
  | "github";

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
export const getReply = replyInjection.getStore;

const editMessageInjection: Injection<
  (id: string, text: string) => Promise<void>
> = context((_id: string, _text: string): Promise<void> => {
  throw new Error("editMessage not supported by this connector");
});
export const injectEditMessage = editMessageInjection.inject;
export const editMessage = editMessageInjection.access;

export type ImageReplyPayload =
  | { link: string; caption?: string }
  | {
    data: string;
    caption?: string;
    mimeType?: string;
    filename?: string;
  };

const replyImageInjection: Injection<
  (image: ImageReplyPayload) => Promise<string>
> = context((image: ImageReplyPayload): Promise<string> => {
  console.log("Reply image:", image);
  return Promise.resolve(crypto.randomUUID());
});
export const injectReplyImage = replyImageInjection.inject;
export const replyImage = replyImageInjection.access;

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

const reactionInjection: Injection<
  (messageId: string, emoji: string) => Promise<void>
> = context((_messageId: string, _emoji: string) => {
  console.log("Reaction not supported by this connector");
  return Promise.resolve();
});
export const injectReaction = reactionInjection.inject;
export const sendReaction = reactionInjection.access;

const deleteMessageInjection: Injection<
  (chatId: string, messageId: string) => Promise<void>
> = context((_chatId: string, _messageId: string) => {
  console.log("Delete message not supported by this connector");
  return Promise.resolve();
});
export const injectDeleteMessage = deleteMessageInjection.inject;
export const deleteMessage = deleteMessageInjection.access;

const quotedReplyInjection: Injection<
  (text: string, replyToMessageId: string) => Promise<string>
> = context((text: string, _replyToMessageId: string) => {
  console.log(
    "Quoted reply not supported by this connector, sending as plain reply",
  );
  return reply(text);
});
export const injectQuotedReply = quotedReplyInjection.inject;
export const sendQuotedReply = quotedReplyInjection.access;

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
  let finishedProcessing = false;
  let stopSpinning: (() => Promise<void>) | undefined;
  const spinnerTimeout = setTimeout(async () => {
    stopSpinning = await spinner(text);
    if (finishedProcessing) {
      await stopSpinning();
    }
  }, 3000);

  try {
    return await f(...xs);
  } finally {
    finishedProcessing = true;
    clearTimeout(spinnerTimeout);
    if (stopSpinning) await stopSpinning();
  }
};

export type MediaAttachment =
  | { kind: "inline"; mimeType: string; dataBase64: string; caption?: string }
  | { kind: "file"; mimeType: string; fileUri: string; caption?: string };

type MessageEvent = {
  kind: "message";
  id: string;
  time: number;
  text?: string;
  contact?: { phone: string; name: string };
  attachments?: MediaAttachment[];
  ownPhone?: string;
  referencedMessageId?: string;
};

type EditEvent = {
  kind: "edit";
  id: string;
  text: string;
  onMessageId: string;
  attachments?: MediaAttachment[];
};

type ReactionEvent = {
  kind: "reaction";
  id: string;
  reaction: string;
  onMessageId: string;
};

export type ConversationEvent = MessageEvent | EditEvent | ReactionEvent;

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
