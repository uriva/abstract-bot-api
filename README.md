# abstract-bot-api

This library provides a unified API over the following ways to chat:

1. telegram
1. whatsapp
1. green-api (unofficial whatsapp api)
1. websocket (for web page chat) 1

## API

The abstract api methods:

`reply` - a simple reply that gets text

`messageId` - the incoming message id

`referenceId` - if the message quoted another message

`medium` - which service was used

`userId` - the user id who sent the current message

`withSpinner` - wrap a function with logic that provides a waiting animation for
users

`progressBar` - wrap a function with logic that provides a loading bar animation

The cool thing is you can call these methods from anywhere in your code, so you
don't need to pass through things to deeply nested functions.

## example

Here's an example usage:

```ts
import {
    AbstractIncomingMessage,
    bouncerServer,
    makeTelegramHandler,
    setTelegramWebhook,
    withSpinner,
} from "../src/index.ts";

import { gamla } from "../deps.ts";
import { reply } from "../src/api.ts";
import {
    whatsappBusinessHandler,
    whatsappWebhookVerificationHandler,
} from "../src/whatsapp.ts";

const { coerce, sleep } = gamla;
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
