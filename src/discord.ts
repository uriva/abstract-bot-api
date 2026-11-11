import { decodeBase64 } from "@std/encoding";
import type { Injector } from "@uri/inject";
import { empty, identity, nonempty, pipe } from "gamla";
import {
  type ConversationEvent,
  type ImageReplyPayload,
  injectDeleteMessage,
  injectEditMessage,
  injectFileLimitMB,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectProgressBar,
  injectQuotedReply,
  injectReaction,
  injectReferenceId,
  injectReply,
  injectReplyImage,
  injectSendFile,
  injectSpinner,
  injectTyping,
  injectUserId,
  type InteractiveButton,
  type MediaAttachment,
  type TaskHandler,
} from "./api.ts";
import { stripUndefined } from "./fbUtils.ts";
import { extractImgTag, extractVideoTag } from "./telegram.ts";
import { extractButtonsTag } from "./whatsapp.ts";

export const discordApiBaseUrl = "https://discord.com/api/v10";
export const discordMaxMessageLength = 2000;
const discordMaxFileSizeBytes = 10 * 1024 * 1024;

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
};

export type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  size?: number;
};

export type DiscordMessageCreateEvent = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  mentions?: DiscordUser[];
  attachments?: DiscordAttachment[];
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  referenced_message?: {
    id: string;
    author?: DiscordUser;
  } | null;
  type?: number;
};

export type DiscordMessageUpdateEvent = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  edited_timestamp?: string | null;
  attachments?: DiscordAttachment[];
  message_reference?: { message_id?: string };
};

export type DiscordReactionAddEvent = {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  member?: { user?: DiscordUser };
  emoji: { id?: string | null; name?: string | null };
};

export type DiscordInteractionCreateEvent = {
  id: string;
  type: number;
  token: string;
  channel_id?: string;
  guild_id?: string;
  user?: DiscordUser;
  member?: { user?: DiscordUser };
  data?: {
    custom_id?: string;
    component_type?: number;
  };
  message?: {
    id: string;
    components?: Array<{
      components?: Array<{ custom_id?: string; label?: string }>;
    }>;
  };
};

export type DiscordDispatchEvent =
  | { t: "MESSAGE_CREATE"; d: DiscordMessageCreateEvent }
  | { t: "MESSAGE_UPDATE"; d: DiscordMessageUpdateEvent }
  | { t: "MESSAGE_REACTION_ADD"; d: DiscordReactionAddEvent }
  | { t: "INTERACTION_CREATE"; d: DiscordInteractionCreateEvent };

const discordJsonHeaders = (botToken: string): Record<string, string> => ({
  Authorization: `Bot ${botToken}`,
  "Content-Type": "application/json",
});

const discordAuthHeader = (botToken: string): Record<string, string> => ({
  Authorization: `Bot ${botToken}`,
});

const splitIndexAtLimit = (text: string, limit: number): number => {
  const slice = text.slice(0, limit);
  const newlineIndex = slice.lastIndexOf("\n");
  if (newlineIndex > limit / 2) return newlineIndex + 1;
  const spaceIndex = slice.lastIndexOf(" ");
  return spaceIndex > limit / 2 ? spaceIndex + 1 : limit;
};

export const splitDiscordMessage = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= discordMaxMessageLength) return [trimmed];
  const cut = splitIndexAtLimit(trimmed, discordMaxMessageLength);
  return [
    trimmed.slice(0, cut).trimEnd(),
    ...splitDiscordMessage(trimmed.slice(cut)),
  ];
};

const parseDiscordError = async (response: Response): Promise<string> => {
  const text = await response.text();
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
};

const postDiscordChannelMessage = async (
  botToken: string,
  channelId: string,
  body: Record<string, unknown>,
): Promise<string> => {
  const response = await fetch(
    `${discordApiBaseUrl}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: discordJsonHeaders(botToken),
      body: JSON.stringify(stripUndefined(body)),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Discord send message failed: ${await parseDiscordError(response)}`,
    );
  }
  const json: { id?: string } = await response.json();
  return json.id ?? "";
};

export const sendDiscordMessage = (botToken: string) =>
async (
  channelId: string,
  text: string,
  replyToMessageId?: string,
): Promise<string> => {
  const chunks = splitDiscordMessage(text);
  if (empty(chunks)) return "";
  return await chunks.reduce<Promise<string>>(
    async (prevPromise, chunk, index) => {
      await prevPromise;
      return await postDiscordChannelMessage(botToken, channelId, {
        content: chunk,
        message_reference: index === 0 && replyToMessageId
          ? { message_id: replyToMessageId, fail_if_not_exists: false }
          : undefined,
      });
    },
    Promise.resolve(""),
  );
};

const chunkButtonsIntoRows = (
  buttons: InteractiveButton[],
): InteractiveButton[][] =>
  empty(buttons)
    ? []
    : [buttons.slice(0, 5), ...chunkButtonsIntoRows(buttons.slice(5, 25))];

export const sendDiscordButtons = (botToken: string) =>
async (
  channelId: string,
  text: string,
  buttons: InteractiveButton[],
): Promise<string> => {
  const chunks = splitDiscordMessage(text);
  const leadingChunks = chunks.length > 1 ? chunks.slice(0, -1) : [];
  const finalText = chunks.length > 0
    ? chunks[chunks.length - 1]
    : "Please select an option:";
  await leadingChunks.reduce<Promise<unknown>>(
    async (prev, chunk) => {
      await prev;
      return await postDiscordChannelMessage(botToken, channelId, {
        content: chunk,
      });
    },
    Promise.resolve(),
  );
  const components = chunkButtonsIntoRows(buttons.slice(0, 25)).map((row) => ({
    type: 1,
    components: row.map((b, idx) => ({
      type: 2,
      style: 2,
      label: b.title.slice(0, 80) || `Option ${idx + 1}`,
      custom_id: (b.id || b.title).slice(0, 100) || `btn_${idx}`,
    })),
  }));
  return await postDiscordChannelMessage(botToken, channelId, {
    content: finalText,
    components,
  });
};

export const editDiscordMessage =
  (botToken: string) =>
  async (channelId: string, messageId: string, text: string): Promise<void> => {
    const trimmed = text.trim().slice(0, discordMaxMessageLength);
    if (!trimmed) return;
    const response = await fetch(
      `${discordApiBaseUrl}/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: discordJsonHeaders(botToken),
        body: JSON.stringify({ content: trimmed }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Discord edit message failed: ${await parseDiscordError(response)}`,
      );
    }
  };

export const deleteDiscordMessage =
  (botToken: string) =>
  async (channelId: string, messageId: string): Promise<void> => {
    const response = await fetch(
      `${discordApiBaseUrl}/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: discordAuthHeader(botToken),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Discord delete message failed: ${await parseDiscordError(response)}`,
      );
    }
  };

const formatDiscordEmoji = (emoji: string): string => {
  const customMatch = emoji.match(/^<a?:([^:>]+:\d+)>$/);
  return encodeURIComponent(customMatch ? customMatch[1] : emoji.trim());
};

export const addDiscordReaction = (botToken: string) =>
async (
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> => {
  const formatted = formatDiscordEmoji(emoji);
  if (!formatted) return;
  const response = await fetch(
    `${discordApiBaseUrl}/channels/${channelId}/messages/${messageId}/reactions/${formatted}/@me`,
    {
      method: "PUT",
      headers: discordAuthHeader(botToken),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Discord reaction failed: ${await parseDiscordError(response)}`,
    );
  }
};

export const sendDiscordTyping =
  (botToken: string) => async (channelId: string): Promise<void> => {
    await fetch(`${discordApiBaseUrl}/channels/${channelId}/typing`, {
      method: "POST",
      headers: discordAuthHeader(botToken),
    });
  };

export const openDiscordDm =
  (botToken: string) => async (recipientId: string): Promise<string> => {
    const response = await fetch(`${discordApiBaseUrl}/users/@me/channels`, {
      method: "POST",
      headers: discordJsonHeaders(botToken),
      body: JSON.stringify({ recipient_id: recipientId }),
    });
    if (!response.ok) {
      throw new Error(
        `Discord open DM failed: ${await parseDiscordError(response)}`,
      );
    }
    const json: { id?: string } = await response.json();
    if (!json.id) throw new Error("Discord open DM returned no channel id");
    return json.id;
  };

const uploadDiscordBlob = async (
  botToken: string,
  channelId: string,
  blob: Blob,
  filename: string,
  caption?: string,
): Promise<string> => {
  const form = new FormData();
  form.append("files[0]", blob, filename);
  if (caption) {
    form.append(
      "payload_json",
      JSON.stringify({ content: caption.slice(0, discordMaxMessageLength) }),
    );
  }
  const response = await fetch(
    `${discordApiBaseUrl}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: discordAuthHeader(botToken),
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Discord file upload failed: ${await parseDiscordError(response)}`,
    );
  }
  const json: { id?: string } = await response.json();
  return json.id ?? "";
};

const filenameFromUrl = (url: string): string => {
  const pathname = new URL(url, "https://placeholder.local").pathname;
  const lastSegment = pathname.split("/").pop();
  return lastSegment && lastSegment.includes(".") ? lastSegment : "attachment";
};

export const sendDiscordFile =
  (botToken: string) =>
  async (channelId: string, url: string, caption?: string): Promise<string> => {
    const fileRes = await fetch(url).catch(() => null);
    if (!fileRes || !fileRes.ok) {
      return await sendDiscordMessage(botToken)(
        channelId,
        caption ? `${caption}\n${url}` : url,
      );
    }
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    if (bytes.byteLength > discordMaxFileSizeBytes) {
      return await sendDiscordMessage(botToken)(
        channelId,
        caption ? `${caption}\n${url}` : url,
      );
    }
    const contentType = fileRes.headers.get("content-type") ??
      "application/octet-stream";
    return await uploadDiscordBlob(
      botToken,
      channelId,
      new Blob([bytes], { type: contentType }),
      filenameFromUrl(url),
      caption,
    );
  };

export const sendDiscordImage =
  (botToken: string) =>
  async (channelId: string, image: ImageReplyPayload): Promise<string> => {
    if ("link" in image) {
      return await sendDiscordFile(botToken)(
        channelId,
        image.link,
        image.caption,
      );
    }
    const rawBase64 = image.data.includes(",")
      ? image.data.split(",")[1]
      : image.data;
    const bytes = Uint8Array.from(decodeBase64(rawBase64));
    const mimeType = image.mimeType ?? "image/png";
    const ext = mimeType.split("/")[1]?.split(";")[0] ?? "png";
    const filename = image.filename ?? `image.${ext}`;
    return await uploadDiscordBlob(
      botToken,
      channelId,
      new Blob([bytes], { type: mimeType }),
      filename,
      image.caption,
    );
  };

export const ackDiscordInteraction = async (
  interactionId: string,
  interactionToken: string,
): Promise<void> => {
  await fetch(
    `${discordApiBaseUrl}/interactions/${interactionId}/${interactionToken}/callback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 6 }),
    },
  );
};

const progressMessage = (text: string, progress: number): string => {
  const completed = Math.round(progress * 20);
  return `${text} [${"#".repeat(completed)}${"-".repeat(20 - completed)}] ${
    Math.round(progress * 100)
  }%`;
};

const makeDiscordProgressBar = (
  send: (text: string) => Promise<string>,
  edit: (id: string, text: string) => Promise<void>,
) =>
async (text: string): Promise<(percentage: number) => Promise<void>> => {
  const id = await send(progressMessage(text, 0));
  const state = { lastProgress: 0 };
  return async (percentage: number) => {
    if (!id || percentage === state.lastProgress) return;
    state.lastProgress = percentage;
    await edit(id, progressMessage(text, percentage));
  };
};

const makeDiscordSpinner =
  (botToken: string, channelId: string) =>
  (_text: string): Promise<() => Promise<void>> => {
    const state = { done: false };
    const keepTyping = async (): Promise<void> => {
      if (state.done) return;
      await sendDiscordTyping(botToken)(channelId).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return keepTyping();
    };
    keepTyping();
    return Promise.resolve(() => {
      state.done = true;
      return Promise.resolve();
    });
  };

const replyWithRichDiscordContent =
  (botToken: string, channelId: string) =>
  async (text: string): Promise<string> => {
    const extractedVideo = extractVideoTag(text);
    if (extractedVideo) {
      const fileMsgId = await sendDiscordFile(botToken)(
        channelId,
        extractedVideo.videoUrl,
      );
      if (!extractedVideo.remainingText) return fileMsgId;
      const buttons = extractButtonsTag(extractedVideo.remainingText);
      return buttons && nonempty(buttons.buttons)
        ? await sendDiscordButtons(botToken)(
          channelId,
          buttons.remainingText,
          buttons.buttons,
        )
        : await sendDiscordMessage(botToken)(
          channelId,
          extractedVideo.remainingText,
        );
    }
    const extractedImg = extractImgTag(text);
    if (extractedImg) {
      const imgMsgId = await sendDiscordFile(botToken)(
        channelId,
        extractedImg.imageUrl,
      );
      if (!extractedImg.remainingText) return imgMsgId;
      const buttons = extractButtonsTag(extractedImg.remainingText);
      return buttons && nonempty(buttons.buttons)
        ? await sendDiscordButtons(botToken)(
          channelId,
          buttons.remainingText,
          buttons.buttons,
        )
        : await sendDiscordMessage(botToken)(
          channelId,
          extractedImg.remainingText,
        );
    }
    const extractedButtons = extractButtonsTag(text);
    return extractedButtons && nonempty(extractedButtons.buttons)
      ? await sendDiscordButtons(botToken)(
        channelId,
        extractedButtons.remainingText,
        extractedButtons.buttons,
      )
      : await sendDiscordMessage(botToken)(channelId, text);
  };

export const discordInjectDeps = (
  botToken: string,
  channelId: string,
  authorId: string,
): Injector => {
  const send = (text: string, replyTo?: string) =>
    sendDiscordMessage(botToken)(channelId, text, replyTo);
  const edit = (msgId: string, text: string) =>
    editDiscordMessage(botToken)(channelId, msgId, text);
  return pipe(
    injectMedium(() => "discord"),
    injectUserId(() => authorId),
    injectFileLimitMB(() => 10),
    injectSendFile((url: string) =>
      sendDiscordFile(botToken)(channelId, url).then(() => undefined)
    ),
    injectReplyImage((image: ImageReplyPayload) =>
      sendDiscordImage(botToken)(channelId, image)
    ),
    injectReply(replyWithRichDiscordContent(botToken, channelId)),
    injectEditMessage(edit),
    injectProgressBar(makeDiscordProgressBar((t) => send(t), edit)),
    injectSpinner(makeDiscordSpinner(botToken, channelId)),
    injectTyping(() => sendDiscordTyping(botToken)(channelId)),
    injectReaction((msgId: string, emoji: string) =>
      addDiscordReaction(botToken)(channelId, msgId, emoji)
    ),
    injectDeleteMessage((chatId: string, msgId: string) =>
      deleteDiscordMessage(botToken)(chatId || channelId, msgId)
    ),
    injectQuotedReply((text: string, replyToMessageId: string) =>
      send(text, replyToMessageId)
    ),
  );
};

const discordAttachmentsToMedia = (
  attachments?: DiscordAttachment[],
): MediaAttachment[] =>
  (attachments ?? []).map((att) => ({
    kind: "file" as const,
    mimeType: att.content_type ?? "application/octet-stream",
    fileUri: att.url,
    caption: att.filename,
  }));

const isUserChatMessageType = (type?: number): boolean =>
  type === undefined || type === 0 || type === 19 || type === 20 || type === 21;

type NormalizedDiscordEnvelope = {
  userId: string;
  channelId: string;
  messageId: string;
  referenceId?: string;
  event: ConversationEvent;
};

const resolveClickedButtonLabel = (
  interaction: DiscordInteractionCreateEvent,
): string => {
  const customId = interaction.data?.custom_id ?? "";
  const allButtons = (interaction.message?.components ?? []).flatMap(
    (row) => row.components ?? [],
  );
  const matched = allButtons.find((b) => b.custom_id === customId);
  return matched?.label || customId;
};

export const normalizeDiscordDispatch = (
  payload: DiscordDispatchEvent,
): NormalizedDiscordEnvelope | null => {
  if (payload.t === "MESSAGE_REACTION_ADD") {
    const { d } = payload;
    if (d.member?.user?.bot || !d.emoji.name) return null;
    return {
      userId: d.user_id,
      channelId: d.channel_id,
      messageId: `${d.message_id}:${d.user_id}:${d.emoji.name}`,
      event: {
        kind: "reaction",
        id: `${d.message_id}:${d.user_id}:${d.emoji.name}`,
        reaction: d.emoji.name,
        onMessageId: d.message_id,
      },
    };
  }
  if (payload.t === "INTERACTION_CREATE") {
    const { d } = payload;
    const user = d.member?.user ?? d.user;
    if (d.type !== 3 || !user || user.bot || !d.channel_id) return null;
    const text = resolveClickedButtonLabel(d);
    if (!text) return null;
    return {
      userId: user.id,
      channelId: d.channel_id,
      messageId: d.id,
      referenceId: d.message?.id,
      event: {
        kind: "message",
        id: d.id,
        time: Date.now(),
        text,
        ...(d.message?.id ? { referencedMessageId: d.message.id } : {}),
      },
    };
  }
  if (payload.t === "MESSAGE_UPDATE") {
    const { d } = payload;
    if (!d.author || d.author.bot || d.content === undefined) return null;
    return {
      userId: d.author.id,
      channelId: d.channel_id,
      messageId: d.id,
      referenceId: d.message_reference?.message_id,
      event: {
        kind: "edit",
        id: `${d.id}:${d.edited_timestamp ?? ""}`,
        text: d.content,
        onMessageId: d.id,
        attachments: discordAttachmentsToMedia(d.attachments),
      },
    };
  }
  const { d } = payload;
  if (d.author.bot || !isUserChatMessageType(d.type)) return null;
  const referenceId = d.message_reference?.message_id;
  return {
    userId: d.author.id,
    channelId: d.channel_id,
    messageId: d.id,
    referenceId,
    event: {
      kind: "message",
      id: d.id,
      time: Date.parse(d.timestamp) || Date.now(),
      text: d.content,
      attachments: discordAttachmentsToMedia(d.attachments),
      ...(referenceId ? { referencedMessageId: referenceId } : {}),
    },
  };
};

export const discordInjectDepsAndRun =
  (botToken: string, doTask: TaskHandler) =>
  async (payload: DiscordDispatchEvent): Promise<void> => {
    if (payload.t === "INTERACTION_CREATE" && payload.d.type === 3) {
      await ackDiscordInteraction(payload.d.id, payload.d.token).catch(
        () => undefined,
      );
    }
    const normalized = normalizeDiscordDispatch(payload);
    if (!normalized || !normalized.userId) return;
    const { referenceId } = normalized;
    await pipe(
      discordInjectDeps(botToken, normalized.channelId, normalized.userId),
      injectLastEvent(() => normalized.event),
      injectMessageId(() => normalized.messageId),
      referenceId ? injectReferenceId(() => referenceId) : identity,
    )(doTask)();
  };
