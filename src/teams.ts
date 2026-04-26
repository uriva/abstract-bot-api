import { identity, pipe } from "gamla";
import {
  type ConversationEvent,
  injectBotPhone,
  injectDeleteMessage,
  injectEditMessage,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectProgressBar,
  injectQuotedReply,
  injectReferenceId,
  injectReply,
  injectSpinner,
  injectTyping,
  injectUserId,
  type MediaAttachment,
  type TaskHandler,
} from "./api.ts";
import { convertHtmlToFacebookFormat, stripUndefined } from "./fbUtils.ts";
import type { Endpoint } from "./taskBouncer.ts";
import { verifyBotFrameworkJwt } from "./webhookAuth.ts";

type TeamsAccount = { id: string; name?: string };
type TeamsAttachment = {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: { downloadUrl?: string } & Record<string, unknown>;
};

export type TeamsActivity = {
  type: string;
  id: string;
  text?: string;
  textFormat?: string;
  from?: TeamsAccount;
  recipient?: TeamsAccount;
  conversation?: { id: string };
  serviceUrl?: string;
  replyToId?: string;
  attachments?: TeamsAttachment[];
  reactionsAdded?: { type: string }[];
};

type TeamsTokenResponse = {
  access_token: string;
};

const convertToTeamsFormat = (text: string): string =>
  convertHtmlToFacebookFormat(text).trim();

const connectorUrl = (serviceUrl: string, path: string): string =>
  new URL(path, serviceUrl).toString();

const getTeamsAccessToken = async (
  appId: string,
  appPassword: string,
): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: appId,
    client_secret: appPassword,
    scope: "https://api.botframework.com/.default",
  });
  const response = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  const token = await response.json() as TeamsTokenResponse;
  return token.access_token;
};

const teamsHeaders = (accessToken: string) => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

const callTeamsConnector = async <T>(
  appId: string,
  appPassword: string,
  serviceUrl: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> => {
  const accessToken = await getTeamsAccessToken(appId, appPassword);
  const response = await fetch(connectorUrl(serviceUrl, path), {
    method,
    headers: teamsHeaders(accessToken),
    ...(body ? { body: JSON.stringify(stripUndefined(body)) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
};

export const sendTeamsMessage = (appId: string, appPassword: string) =>
async (
  serviceUrl: string,
  conversationId: string,
  text: string,
  replyToId?: string,
): Promise<string> => {
  const normalized = convertToTeamsFormat(text);
  if (!normalized) return "";
  const response = await callTeamsConnector<{ id: string }>(
    appId,
    appPassword,
    serviceUrl,
    `v3/conversations/${conversationId}/activities`,
    "POST",
    {
      type: "message",
      text: normalized,
      textFormat: "markdown",
      replyToId,
    },
  );
  return response.id;
};

export const editTeamsMessage = (appId: string, appPassword: string) =>
async (
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  text: string,
): Promise<void> => {
  const normalized = convertToTeamsFormat(text);
  if (!normalized) return;
  await callTeamsConnector(
    appId,
    appPassword,
    serviceUrl,
    `v3/conversations/${conversationId}/activities/${activityId}`,
    "PUT",
    {
      id: activityId,
      type: "message",
      text: normalized,
      textFormat: "markdown",
    },
  );
};

export const deleteTeamsMessage =
  (appId: string, appPassword: string) =>
  async (
    serviceUrl: string,
    conversationId: string,
    activityId: string,
  ): Promise<void> => {
    await callTeamsConnector(
      appId,
      appPassword,
      serviceUrl,
      `v3/conversations/${conversationId}/activities/${activityId}`,
      "DELETE",
    );
  };

export const sendTeamsTyping =
  (appId: string, appPassword: string) =>
  async (serviceUrl: string, conversationId: string): Promise<void> => {
    await callTeamsConnector(
      appId,
      appPassword,
      serviceUrl,
      `v3/conversations/${conversationId}/activities`,
      "POST",
      { type: "typing" },
    );
  };

const progressMessage = (text: string, progress: number): string => {
  const completed = Math.round(progress * 20);
  return `${text} [${"#".repeat(completed)}${"-".repeat(20 - completed)}] ${
    Math.round(progress * 100)
  }%`;
};

const makeTeamsProgressBar = (
  send: (text: string, replyToId?: string) => Promise<string>,
  edit: (activityId: string, text: string) => Promise<void>,
) =>
async (text: string): Promise<(percentage: number) => Promise<void>> => {
  const activityId = await send(progressMessage(text, 0));
  let lastProgress = 0;
  return async (percentage: number) => {
    if (!activityId || percentage === lastProgress) return;
    lastProgress = percentage;
    await edit(activityId, progressMessage(text, percentage));
  };
};

const spinnerFrames = ["-", "\\", "|", "/"];

const makeTeamsSpinner = (
  send: (text: string, replyToId?: string) => Promise<string>,
  edit: (activityId: string, text: string) => Promise<void>,
) =>
async (text: string): Promise<() => Promise<void>> => {
  const activityId = await send(`${text} ${spinnerFrames[0]}`);
  if (!activityId) return () => Promise.resolve();
  let done = false;
  let frame = 0;
  const tick = async (): Promise<void> => {
    if (done) return;
    frame = (frame + 1) % spinnerFrames.length;
    await edit(activityId, `${text} ${spinnerFrames[frame]}`).catch(() =>
      undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    return tick();
  };
  const spinning = tick();
  return async () => {
    done = true;
    await spinning;
    await edit(activityId, `${text} done.`).catch(() => undefined);
  };
};

const teamsAttachmentsToMedia = (
  attachments?: TeamsAttachment[],
): MediaAttachment[] =>
  (attachments ?? []).flatMap((attachment) => {
    const fileUri = attachment.contentUrl ?? attachment.content?.downloadUrl;
    return fileUri
      ? [{
        kind: "file" as const,
        mimeType: attachment.contentType ?? "application/octet-stream",
        fileUri,
        caption: attachment.name,
      }]
      : [];
  });

type NormalizedTeamsActivity = {
  userId: string;
  messageId: string;
  referenceId?: string;
  event: ConversationEvent;
};

const normalizeTeamsActivity = (
  activity: TeamsActivity,
): NormalizedTeamsActivity | null => {
  if (!activity.from?.id) return null;
  if (activity.type === "messageReaction") {
    const reaction = activity.reactionsAdded?.[0]?.type;
    if (!reaction || !activity.replyToId) return null;
    return {
      userId: activity.from.id,
      messageId: activity.id,
      referenceId: activity.replyToId,
      event: {
        kind: "reaction",
        id: activity.id,
        reaction,
        onMessageId: activity.replyToId,
      },
    };
  }

  if (activity.type === "messageUpdate") {
    return {
      userId: activity.from.id,
      messageId: activity.id,
      referenceId: activity.replyToId,
      event: {
        kind: "edit",
        id: activity.id,
        text: activity.text ?? "",
        onMessageId: activity.id,
        attachments: teamsAttachmentsToMedia(activity.attachments),
      },
    };
  }

  if (activity.type !== "message") return null;
  return {
    userId: activity.from.id,
    messageId: activity.id,
    referenceId: activity.replyToId,
    event: {
      kind: "message",
      id: activity.id,
      text: activity.text ?? "",
      attachments: teamsAttachmentsToMedia(activity.attachments),
      ...(activity.replyToId
        ? { referencedMessageId: activity.replyToId }
        : {}),
    },
  };
};

export const teamsInjectDepsAndRun =
  (appId: string, appPassword: string, doTask: TaskHandler) =>
  (activity: TeamsActivity): Promise<void> => {
    if (!activity.serviceUrl || !activity.conversation?.id) {
      return Promise.resolve();
    }
    const normalized = normalizeTeamsActivity(activity);
    if (!normalized) return Promise.resolve();
    const send = (text: string, replyToId?: string) =>
      sendTeamsMessage(appId, appPassword)(
        activity.serviceUrl!,
        activity.conversation!.id,
        text,
        replyToId,
      );
    const edit = (activityId: string, text: string) =>
      editTeamsMessage(appId, appPassword)(
        activity.serviceUrl!,
        activity.conversation!.id,
        activityId,
        text,
      );
    return pipe(
      injectLastEvent(() => normalized.event),
      injectMedium(() => "microsoft-teams"),
      injectMessageId(() => normalized.messageId),
      injectBotPhone(() => activity.recipient?.id ?? "teams"),
      injectUserId(() => normalized.userId),
      injectReply((text: string) => send(text)),
      injectEditMessage((messageId: string, text: string) =>
        edit(messageId, text)
      ),
      injectDeleteMessage((_chatId: string, messageId: string) =>
        deleteTeamsMessage(appId, appPassword)(
          activity.serviceUrl!,
          activity.conversation!.id,
          messageId,
        )
      ),
      injectProgressBar(makeTeamsProgressBar(send, edit)),
      injectSpinner(makeTeamsSpinner(send, edit)),
      injectTyping(() =>
        sendTeamsTyping(appId, appPassword)(
          activity.serviceUrl!,
          activity.conversation!.id,
        )
      ),
      injectQuotedReply((text: string, replyToMessageId: string) =>
        send(text, replyToMessageId)
      ),
      normalized.referenceId
        ? injectReferenceId(() => normalized.referenceId as string)
        : identity,
    )(doTask)();
  };

export const teamsWebhookHandler = (
  appId: string,
  appPassword: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<TeamsActivity> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  authenticate: ({ headers, payload }) =>
    verifyBotFrameworkJwt(appId, payload.serviceUrl, headers),
  handler: teamsInjectDepsAndRun(appId, appPassword, doTask),
});
