import { coerce, sleep } from "gamla";
import { lastEvent, reply } from "../src/api.ts";
import {
  bouncerServer,
  makeTelegramHandler,
  setTelegramWebhook,
  withSpinner,
} from "../src/index.ts";
import {
  whatsappBusinessHandler,
  whatsappWebhookVerificationHandler,
} from "../src/whatsapp.ts";

const telegramToken = coerce(Deno.env.get("TELEGRAM_TOKEN"));
const telegramWebhookSecret = coerce(Deno.env.get("TELEGRAM_WEBHOOK_SECRET"));
const botServerSuffix = "/bot-url-suffix";

const whatsappPath = "/whatsapp-url-suffix";

const handleMessage = async () => {
  const task = lastEvent();
  console.log("got task", task);
  await withSpinner("waiting needlessly", sleep)(5000);
  return reply(`hi there i got ${JSON.stringify(task)}`);
};

const url = coerce(Deno.env.get("URL"));

await bouncerServer(
  url,
  coerce(Deno.env.get("PORT")),
  [
    makeTelegramHandler(
      telegramToken,
      botServerSuffix,
      handleMessage,
      telegramWebhookSecret,
    ),
    whatsappBusinessHandler(
      coerce(Deno.env.get("WHATSAPP_ACCESS_TOKEN")),
      coerce(Deno.env.get("WHATSAPP_APP_SECRET")),
      whatsappPath,
      handleMessage,
    ),
    whatsappWebhookVerificationHandler(
      coerce(Deno.env.get("WHATSAPP_VERIFICATION_TOKEN")),
      whatsappPath,
    ),
  ],
);
await setTelegramWebhook(
  telegramToken,
  url + botServerSuffix,
  telegramWebhookSecret,
)
  .then(console.log);
