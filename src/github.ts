import {
  type ConversationEvent,
  injectEditMessage,
  injectReply,
  injectSendFile,
  type TaskHandler,
  injectMedium,
  injectLastEvent,
  injectUserId,
  injectMessageId,
} from "./api.ts";
import { type Endpoint } from "./taskBouncer.ts";
import { verifyGithubSignature } from "./webhookAuth.ts";
import { pipe } from "gamla";

export type GithubWebhookPayload = {
  action: string;
  issue?: {
    number: number;
    title: string;
    pull_request?: {
      url: string;
    };
  };
  pull_request?: {
    number: number;
    title: string;
    body: string;
    user: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    user: { login: string };
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  installation?: {
    id: number;
  };
};

export const githubNormalizeEvent = (
  payload: GithubWebhookPayload,
): ConversationEvent | null => {
  const isPullRequestEvent = payload.pull_request !== undefined;
  const isIssueCommentEvent = payload.comment !== undefined;

  if (isPullRequestEvent) {
    if (payload.action !== "opened" && payload.action !== "synchronize") {
      return null;
    }
    return {
      kind: "message",
      id: payload.pull_request!.number.toString(),
      time: Date.now(),
      text: `${payload.action === "opened" ? "New Pull Request" : "Pull Request Updated"}: ${payload.pull_request!.title}\n\n${payload.pull_request!.body || ""}`,
    };
  }

  if (isIssueCommentEvent) {
    if (payload.action !== "created") {
      return null;
    }
    // Ignore bot comments
    if (payload.comment!.user.login.endsWith("[bot]")) {
      return null;
    }
    return {
      kind: "message",
      id: payload.comment!.id.toString(),
      time: Date.now(),
      text: payload.comment!.body,
    };
  }

  return null;
};

export const sendGithubComment = async (
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number }> => {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post comment: ${await response.text()}`);
  }
  return response.json();
};

export const editGithubComment = async (
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<{ id: number }> => {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to edit comment: ${await response.text()}`);
  }
  return response.json();
};

export const handleGithub = (
  appSecret: string,
  path: string,
  getInstallationToken: (installationId: number) => Promise<string>,
  doTask: TaskHandler,
): Endpoint<GithubWebhookPayload> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  authenticate: ({ headers, rawBody }) =>
    verifyGithubSignature(appSecret, headers, rawBody),
  handler: async (payload: GithubWebhookPayload) => {
    const event = githubNormalizeEvent(payload);
    if (!event || event.kind !== "message") return;

    const issueNumber = payload.issue?.number || payload.pull_request?.number;
    if (!issueNumber) return;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const installationId = payload.installation?.id;
    if (!installationId) return;

    const userId = payload.comment?.user.login || payload.pull_request?.user.login || "unknown";

    await pipe(
      injectLastEvent(() => event),
      injectMedium(() => "github"),
      injectUserId(() => userId),
      injectMessageId(() => event.id),
      injectReply(async (text: string) => {
        const token = await getInstallationToken(installationId);
        const res = await sendGithubComment(token, owner, repo, issueNumber, text);
        return res.id.toString();
      }),
      injectEditMessage(async (messageId: string, text: string) => {
        const token = await getInstallationToken(installationId);
        await editGithubComment(token, owner, repo, parseInt(messageId), text);
      }),
      injectSendFile(async (url: string) => {
        const token = await getInstallationToken(installationId);
        const text = `Attachment: [${url}](${url})`;
        await sendGithubComment(token, owner, repo, issueNumber, text);
      })
    )(doTask)();
  },
});
