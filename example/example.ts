import {
  AbstractIncomingMessage,
  bouncerServer,
  makeTelegramHandler,
  setTelegramWebhook,
} from "../src/index.ts";

import { coerce } from "gamla";
import { logInContext } from "../src/api.ts";
import {
  whatsappBusinessHandler,
  whatsappWebhookVerificationHandler,
} from "../src/whatsapp.ts";

const telegramToken = coerce(Deno.env.get("TELEGRAM_TOKEN"));
const botServerSuffix = "/bot-url-suffix";

const whatsappPath = "/whatsapp-url-suffix";

const handleMessage = (task: AbstractIncomingMessage) => {
  console.log("got task", task);
  return logInContext("hi there i got " + JSON.stringify(task));
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
await setTelegramWebhook(telegramToken, url + botServerSuffix);
