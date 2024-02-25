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
