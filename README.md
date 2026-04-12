# abstract-bot-api

`abstract-bot-api` is a small abstraction layer over chat providers.

It solves two practical problems:

1. You want one handler style across multiple bot providers.
2. You want deeply nested code to be able to reply, show typing, send progress,
   or inspect the current incoming event without manually threading provider
   clients through your call stack.

The second part is implemented with request-scoped dependency injection via
[`@uri/inject`](https://jsr.io/@uri/inject).

## Installation

```ts
import * as botApi from "jsr:@uri/abstract-bot-api";
```

## Supported Providers

Current provider support:

1. Telegram
2. Slack
3. Microsoft Teams
4. WhatsApp Cloud API
5. Facebook Messenger
6. Green API

## Core Idea

Inside a provider webhook handler, the library injects a request-scoped context.
From anywhere further down the stack, your code can call the abstract API
directly.

Common examples:

```ts
import {
  lastEvent,
  medium,
  messageId,
  progressBar,
  reply,
  sendQuotedReply,
  sendReaction,
  typing,
  userId,
  withSpinner,
  withTyping,
} from "jsr:@uri/abstract-bot-api";
```

Useful runtime accessors:

1. `lastEvent(): ConversationEvent`
2. `medium(): string`
3. `userId(): string`
4. `messageId(): string`
5. `referenceId(): string`
6. `botPhone(): string`

Useful actions:

1. `reply(text): Promise<string>`
2. `sendQuotedReply(text, replyToMessageId): Promise<string>`
3. `editMessage(messageId, text): Promise<void>`
4. `deleteMessage(chatId, messageId): Promise<void>`
5. `replyImage(payload): Promise<string>`
6. `sendFile(url): Promise<void>`
7. `typing(): Promise<void>`
8. `sendReaction(messageId, emoji): Promise<void>`

Useful helpers:

1. `withTyping(fn)`
2. `withSpinner(text, fn)`
3. `progressBar(text): Promise<(percentage: number) => Promise<void>>`

## Event Model

Incoming events are normalized into a `ConversationEvent`:

```ts
type ConversationEvent =
  | {
    kind: "message";
    text?: string;
    contact?: { phone: string; name: string };
    attachments?: MediaAttachment[];
    ownPhone?: string;
    referencedMessageId?: string;
  }
  | {
    kind: "edit";
    text: string;
    onMessageId: string;
    attachments?: MediaAttachment[];
  }
  | {
    kind: "reaction";
    reaction: string;
    onMessageId: string;
  };
```

That means your task handler can usually ignore provider-specific webhook shapes
and just inspect `lastEvent()`.

## Minimal Example

```ts
import { coerce, sleep } from "gamla";
import {
  bouncerServer,
  lastEvent,
  makeTelegramHandler,
  reply,
  setTelegramWebhook,
  whatsappBusinessHandler,
  whatsappWebhookVerificationHandler,
  withSpinner,
} from "jsr:@uri/abstract-bot-api";

const url = coerce(Deno.env.get("URL"));
const port = coerce(Deno.env.get("PORT"));

const telegramToken = coerce(Deno.env.get("TELEGRAM_TOKEN"));
const telegramWebhookSecret = coerce(
  Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
);
const telegramPath = "/telegram";

const whatsappAccessToken = coerce(Deno.env.get("WHATSAPP_ACCESS_TOKEN"));
const whatsappAppSecret = coerce(Deno.env.get("WHATSAPP_APP_SECRET"));
const whatsappVerificationToken = coerce(
  Deno.env.get("WHATSAPP_VERIFICATION_TOKEN"),
);
const whatsappPath = "/whatsapp";

const handleMessage = async () => {
  const event = lastEvent();
  await withSpinner("Thinking", sleep)(1000);
  return reply(`Got ${JSON.stringify(event)}`);
};

await bouncerServer(url, port, [
  makeTelegramHandler(
    telegramToken,
    telegramPath,
    handleMessage,
    telegramWebhookSecret,
  ),
  whatsappBusinessHandler(
    whatsappAccessToken,
    whatsappAppSecret,
    whatsappPath,
    handleMessage,
  ),
  whatsappWebhookVerificationHandler(
    whatsappVerificationToken,
    whatsappPath,
  ),
]);

await setTelegramWebhook(
  telegramToken,
  `${url}${telegramPath}`,
  telegramWebhookSecret,
);
```

## Webhook Security

Webhook verification is enforced before bounced handlers are queued.

This is important because many handlers use `bounce: true`, which means inbound
requests are accepted quickly and processed asynchronously. Verification
therefore must happen at the HTTP boundary, not later inside deferred execution.

Current verification model by provider:

| Provider           | Verification mechanism                            |
| ------------------ | ------------------------------------------------- |
| Telegram           | `X-Telegram-Bot-Api-Secret-Token`                 |
| Slack              | `X-Slack-Signature` + `X-Slack-Request-Timestamp` |
| WhatsApp Cloud API | `X-Hub-Signature-256`                             |
| Facebook Messenger | `X-Hub-Signature-256`                             |
| Microsoft Teams    | Bot Framework JWT in `Authorization`              |
| Green API          | configured `Authorization` header token           |

The internal deferred endpoint is also protected and cannot be called directly
from outside the process.

## Provider Setup

### Telegram

Handler:

```ts
makeTelegramHandler(
  telegramToken,
  path,
  doTask,
  secretToken,
);
```

Webhook registration:

```ts
await setTelegramWebhook(telegramToken, webhookUrl, secretToken);
```

Requirements:

1. Set a webhook secret token when registering the webhook.
2. Pass the same secret token to `makeTelegramHandler`.

### Slack

Handler:

```ts
slackWebhookHandler(
  botToken,
  signingSecret,
  path,
  doTask,
);
```

Requirements:

1. Use your Slack bot token for outbound API calls.
2. Use your Slack signing secret for inbound request verification.

Notes:

1. Supports Slack `url_verification`.
2. Normalizes message, edit, and reaction events.

### Microsoft Teams

Handler:

```ts
teamsWebhookHandler(
  appId,
  appPassword,
  path,
  doTask,
);
```

Requirements:

1. Use Bot Framework app credentials for outbound calls.
2. Inbound requests are verified via Bot Framework JWT validation.

### WhatsApp Cloud API

Handlers:

```ts
whatsappBusinessHandler(
  accessToken,
  appSecret,
  path,
  doTask,
);

whatsappWebhookVerificationHandler(
  verificationToken,
  path,
);
```

Requirements:

1. `accessToken` for outbound Graph API calls.
2. `appSecret` for `X-Hub-Signature-256` verification.
3. `verificationToken` for Meta webhook subscription challenge.

### Facebook Messenger

Handlers:

```ts
messengerWebhookHandler(
  accessToken,
  appSecret,
  path,
  doTask,
);

messengerWebhookVerificationHandler(
  verificationToken,
  path,
);
```

Requirements:

1. `accessToken` for outbound Messenger API calls.
2. `appSecret` for `X-Hub-Signature-256` verification.
3. `verificationToken` for Meta webhook subscription challenge.

### Green API

Register webhook:

```ts
await registerWebhook(credentials, webhookUrl, webhookAuthorizationHeader);
```

Handler:

```ts
greenApiHandler(
  credentials,
  path,
  doTask,
  webhookAuthorizationHeader,
);
```

Requirements:

1. Configure `webhookAuthorizationHeader` when registering the webhook.
2. Pass the same expected header value to `greenApiHandler`.

Notes:

1. Green API appears to document webhook auth via `Authorization` header token
   rather than signed request payloads.

## Bouncer Server

`bouncerServer(domain, port, endpoints)` runs a small HTTP server and routes
inbound requests to endpoint handlers.

Endpoint types:

1. `bounce: false`
2. `bounce: true`

`bounce: true` means the request is authenticated, acknowledged immediately, and
processed asynchronously through the library’s deferred internal endpoint.

That deferred endpoint is protected internally by a generated token.

## Breaking Changes

Recent security changes introduced signature or token verification into the
inbound handlers. That means these APIs now require more explicit secrets than
older versions:

1. `makeTelegramHandler` requires `secretToken`
2. `setTelegramWebhook` accepts `secretToken`
3. `whatsappBusinessHandler` requires `appSecret`
4. `messengerWebhookHandler` requires `appSecret`
5. `slackWebhookHandler` requires `signingSecret`
6. `greenApiHandler` requires `webhookAuthorizationHeader`
7. `registerWebhook` accepts `webhookAuthorizationHeader`

## Design Notes

This library intentionally keeps the abstraction small.

It does not try to flatten every provider feature into one giant interface.
Instead, it focuses on the operations that are commonly needed in real bot
handlers:

1. read the current inbound event
2. reply
3. reply in-thread or quoted
4. show typing/progress/spinner state
5. edit or delete messages when supported
6. access context without passing provider clients everywhere

## Development

Run checks:

```sh
deno task check
```

Run focused tests:

```sh
deno test --allow-env --allow-net src/taskBouncer.test.ts src/webhookAuth.test.ts
```
