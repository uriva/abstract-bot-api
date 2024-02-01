import {
  AbstractIncomingMessage,
  bouncerServer,
  makeTelegramHandler,
  setTelegramWebhook,
} from "../src/index.ts";

import { coerce } from "gamla";

import { User } from "https://deno.land/x/grammy_types@v3.3.0/mod.ts";
import { logInContext } from "../src/api.ts";

const url = "<url here>";
const telegramToken = "<telegram token here>";
const botServerSuffix = "<bot server suffix>";

const taskHandler = (task: AbstractIncomingMessage) => {
  console.log("got task", task);
  return logInContext("hi there");
};

await bouncerServer(
  url,
  coerce(Deno.env.get("PORT")),
  {
    [botServerSuffix]: makeTelegramHandler(
      telegramToken,
      taskHandler,
      (t: string) => Promise.resolve(console.log(t)),
      () => Promise.resolve(),
      (_: User) => false,
    ),
  },
);
await setTelegramWebhook(telegramToken, `${url}/${botServerSuffix}`);
