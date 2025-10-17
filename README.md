# abstract-bot-api

This library solves two problems:

1. You want to switch between chat providers and not change your code.
1. You have deep stacked code that needs to access the chat api (e.g. to send a
   loading message from some internal method), and you don't want to carry
   around credentials as globals (because maybe you have two bots running in the
   same server).

The first problem is solved by making a simple common api for all the services,
while the second is solved using https://github.com/uriva/context-inject.

This library provides a unified API over:

1. telegram
1. whatsapp
1. facebook messenger
1. green-api (unofficial whatsapp api)
1. websocket (for web page chat)

## Installation

`jsr:@uri/abstract-bot-api`

## API

The abstract api methods:

`reply: (text: string) => Promise<string>` - a simple reply that gets text and
returns the sent message id.

`messageId: () => string` - the incoming message id

`referenceId: () => string` - if the message quoted another message

`medium: () => string` - which service was used ('whatsapp', 'green-api' etc')

`userId: () => string` - the user id who sent the current message

`withSpinner: (text: string, f: Function) => Function` - wraps an async function
with logic that provides a waiting animation for users

`progressBar: (text: string) => Promise<(percentage: number) => Promise<void>>` -
get a way to send progress updates that appear in a loading bar animation

The nice thing is you can call these methods from anywhere in your code, so you
don't need to pass through things to deeply nested functions. The library
understands by the call stack the context the messages should go to (see example
below).

## example

Here's an example usage:

```ts
import { coerce, sleep } from "gamla";
import {
  AbstractIncomingMessage,
  bouncerServer,
  makeTelegramHandler,
  setTelegramWebhook,
  withSpinner,
} from "../src/index.ts";
import { reply } from "../src/api.ts";
import {
  whatsappBusinessHandler,
  whatsappWebhookVerificationHandler,
} from "../src/whatsapp.ts";

const telegramToken = coerce(Deno.env.get("TELEGRAM_TOKEN"));
const botServerSuffix = "/bot-url-suffix";

const whatsappPath = "/whatsapp-url-suffix";

const handleMessage = async (task: AbstractIncomingMessage) => {
  console.log("got task", task);
  await withSpinner("waiting needlessly", sleep)(5000);
  return reply("hi there i got " + JSON.stringify(task));
};

const url = coerce(Deno.env.get("URL"));

await bouncerServer(
  url,
  coerce(Deno.env.get("PORT")),
  [
    makeTelegramHandler(telegramToken, botServerSuffix, handleMessage),
    whatsappBusinessHandler(
      coerce(Deno.env.get("WHATSAPP_ACCESS_TOKEN")),
      whatsappPath,
      handleMessage,
    ),
    whatsappWebhookVerificationHandler(
      coerce(Deno.env.get("WHATSAPP_VERIFICATION_TOKEN")),
      whatsappPath,
    ),
  ],
);
await setTelegramWebhook(telegramToken, url + botServerSuffix).then(
  console.log,
);
```
