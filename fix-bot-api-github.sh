cd /home/uri/uriva/abstract-bot-api
git fetch origin main
git checkout main
cat << 'EOF2' >> src/github.ts

export const githubInjectDeps = (
  payload: GithubWebhookPayload,
  getInstallationToken: (installationId: number) => Promise<string>
) => (doTask: TaskHandler) => async () => {
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
};
EOF2
deno check src/index.ts
