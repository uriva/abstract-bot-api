import { identity, pipe } from "gamla";
import {
  type ConversationEvent,
  injectDeleteMessage,
  injectEditMessage,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectProgressBar,
  injectQuotedReply,
  injectReaction,
  injectReferenceId,
  injectReply,
  injectSpinner,
  injectUserId,
  type MediaAttachment,
  type TaskHandler,
} from "./api.ts";
import { convertHtmlToFacebookFormat, stripUndefined } from "./fbUtils.ts";
import type { Endpoint } from "./taskBouncer.ts";
import { verifySlackSignature } from "./webhookAuth.ts";

type SlackApiSuccess<T> = { ok: true } & T;
type SlackApiFailure = { ok: false; error: string };
type SlackApiResponse<T> = SlackApiSuccess<T> | SlackApiFailure;

type SlackFile = {
  mimetype?: string;
  title?: string;
  url_private?: string;
  url_private_download?: string;
};

type SlackMessage = {
  text?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  files?: SlackFile[];
};

type SlackMessageEvent = {
  type: "message" | "app_mention";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  files?: SlackFile[];
  message?: SlackMessage;
  previous_message?: SlackMessage;
};

type SlackReactionEvent = {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: { type: "message"; channel: string; ts: string };
};

type SlackEvent = SlackMessageEvent | SlackReactionEvent;

export type SlackWebhookPayload =
  | { type: "url_verification"; challenge: string }
  | { type: "event_callback"; event_id: string; event: SlackEvent };

const slackHeaders = (botToken: string) => ({
  "Authorization": `Bearer ${botToken}`,
  "Content-Type": "application/json; charset=utf-8",
});

const convertToSlackFormat = (text: string): string =>
  convertHtmlToFacebookFormat(text).trim();

const slackApi = async <T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: slackHeaders(botToken),
    body: JSON.stringify(stripUndefined(body)),
  });
  const json = await response.json() as SlackApiResponse<T>;
  if (!response.ok || !json.ok) {
    const error = json.ok ? response.statusText : json.error;
    throw new Error(`Slack API ${method} failed: ${error}`);
  }
  return json;
};

export const sendSlackMessage = (botToken: string) =>
async (
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> => {
  const normalized = convertToSlackFormat(text);
  if (!normalized) return "";
  const response = await slackApi<{ ts: string }>(
    botToken,
    "chat.postMessage",
    {
      channel,
      text: normalized,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    },
  );
  return response.ts;
};

export const editSlackMessage =
  (botToken: string) =>
  async (channel: string, ts: string, text: string): Promise<void> => {
    const normalized = convertToSlackFormat(text);
    if (!normalized) return;
    await slackApi(botToken, "chat.update", { channel, ts, text: normalized });
  };

export const deleteSlackMessage =
  (botToken: string) => async (channel: string, ts: string): Promise<void> => {
    await slackApi(botToken, "chat.delete", { channel, ts });
  };

export const addSlackReaction =
  (botToken: string) =>
  async (channel: string, ts: string, reaction: string): Promise<void> => {
    await slackApi(botToken, "reactions.add", {
      channel,
      timestamp: ts,
      name: reaction.replaceAll(":", ""),
    });
  };

const progressMessage = (text: string, progress: number): string => {
  const completed = Math.round(progress * 20);
  return `${text} [${"#".repeat(completed)}${"-".repeat(20 - completed)}] ${
    Math.round(progress * 100)
  }%`;
};

const makeSlackProgressBar = (
  send: (text: string, threadTs?: string) => Promise<string>,
  edit: (ts: string, text: string) => Promise<void>,
) =>
async (text: string): Promise<(percentage: number) => Promise<void>> => {
  const ts = await send(progressMessage(text, 0));
  let lastProgress = 0;
  return async (percentage: number) => {
    if (!ts || percentage === lastProgress) return;
    lastProgress = percentage;
    await edit(ts, progressMessage(text, percentage));
  };
};

const spinnerFrames = ["-", "\\", "|", "/"];

const makeSlackSpinner = (
  send: (text: string, threadTs?: string) => Promise<string>,
  edit: (ts: string, text: string) => Promise<void>,
) =>
async (text: string): Promise<() => Promise<void>> => {
  const ts = await send(`${text} ${spinnerFrames[0]}`);
  if (!ts) return () => Promise.resolve();
  let done = false;
  let frame = 0;
  const tick = async (): Promise<void> => {
    if (done) return;
    frame = (frame + 1) % spinnerFrames.length;
    await edit(ts, `${text} ${spinnerFrames[frame]}`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return tick();
  };
  const spinning = tick();
  return async () => {
    done = true;
    await spinning;
    await edit(ts, `${text} done.`).catch(() => undefined);
  };
};

const filesToAttachments = (files?: SlackFile[]): MediaAttachment[] =>
  (files ?? [])
    .flatMap((file) => {
      const fileUri = file.url_private_download ?? file.url_private;
      return fileUri
        ? [{
          kind: "file" as const,
          mimeType: file.mimetype ?? "application/octet-stream",
          fileUri,
          caption: file.title,
        }]
        : [];
    });

type NormalizedSlackEnvelope = {
  userId: string;
  channel: string;
  messageId: string;
  referenceId?: string;
  event: ConversationEvent;
};

const threadReference = (threadTs?: string, ts?: string): string | undefined =>
  threadTs && threadTs !== ts ? threadTs : undefined;

const normalizeSlackEvent = (
  envelope: Extract<SlackWebhookPayload, { type: "event_callback" }>,
): NormalizedSlackEnvelope | null => {
  const { event_id, event } = envelope;
  if (event.type === "reaction_added") {
    return event.item.type === "message"
      ? {
        userId: event.user,
        channel: event.item.channel,
        messageId: event_id,
        event: {
          kind: "reaction",
          reaction: event.reaction,
          onMessageId: event.item.ts,
        },
      }
      : null;
  }

  if (event.subtype === "bot_message" || event.subtype === "message_deleted") {
    return null;
  }

  if (event.subtype === "message_changed" && event.message) {
    return {
      userId: event.message.user ?? event.previous_message?.user ?? "",
      channel: event.channel,
      messageId: event.message.ts,
      referenceId: threadReference(event.message.thread_ts, event.message.ts),
      event: {
        kind: "edit",
        text: event.message.text ?? "",
        onMessageId: event.message.ts,
        attachments: filesToAttachments(event.message.files),
      },
    };
  }

  if (!event.user) return null;
  return {
    userId: event.user,
    channel: event.channel,
    messageId: event.ts,
    referenceId: threadReference(event.thread_ts, event.ts),
    event: {
      kind: "message",
      text: event.text ?? "",
      attachments: filesToAttachments(event.files),
      ...(threadReference(event.thread_ts, event.ts)
        ? { referencedMessageId: event.thread_ts }
        : {}),
    },
  };
};

export const slackInjectDepsAndRun =
  (botToken: string, doTask: TaskHandler) =>
  (payload: SlackWebhookPayload): Promise<void> => {
    if (payload.type !== "event_callback") return Promise.resolve();
    const normalized = normalizeSlackEvent(payload);
    if (!normalized || !normalized.userId) return Promise.resolve();
    const send = (text: string, threadTs?: string) =>
      sendSlackMessage(botToken)(normalized.channel, text, threadTs);
    const edit = (ts: string, text: string) =>
      editSlackMessage(botToken)(normalized.channel, ts, text);
    return pipe(
      injectLastEvent(() => normalized.event),
      injectMedium(() => "slack"),
      injectMessageId(() => normalized.messageId),
      injectUserId(() => normalized.userId),
      injectReply((text: string) => send(text)),
      injectEditMessage((messageId: string, text: string) =>
        edit(messageId, text)
      ),
      injectProgressBar(makeSlackProgressBar(send, edit)),
      injectSpinner(makeSlackSpinner(send, edit)),
      injectQuotedReply((text: string, replyToMessageId: string) =>
        send(text, replyToMessageId)
      ),
      injectReaction((messageId: string, emoji: string) =>
        addSlackReaction(botToken)(normalized.channel, messageId, emoji)
      ),
      injectDeleteMessage((chatId: string, messageId: string) =>
        deleteSlackMessage(botToken)(chatId, messageId)
      ),
      normalized.referenceId
        ? injectReferenceId(() => normalized.referenceId as string)
        : identity,
    )(doTask)();
  };

export const slackWebhookHandler = (
  botToken: string,
  signingSecret: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<SlackWebhookPayload> => ({
  bounce: false,
  predicate: ({ url, method }) => url === path && method === "POST",
  authenticate: ({ headers, rawBody }) =>
    verifySlackSignature(signingSecret, headers, rawBody),
  handler: (payload, res) => {
    if (payload.type === "url_verification") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(payload.challenge);
      return;
    }
    res.writeHead(200);
    res.end();
    slackInjectDepsAndRun(botToken, doTask)(payload).catch((error) => {
      console.error("Slack handler failed", error);
    });
  },
});
