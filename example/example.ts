import {
  AbstractIncomingMessage,
  bouncerServer,
  makeTelegramHandler,
  setTelegramWebhook,
} from "../src/index.ts";

import { User } from "https://deno.land/x/grammy_types@v3.3.0/mod.ts";
import { logInContext } from "../src/api.ts";

const url = "<url here>";
const telegramToken = "<token here>";
const botServerSuffix = "/my-suffix>";

await bouncerServer(
  url,
  "<port>",
  {
    [botServerSuffix]: makeTelegramHandler(
      telegramToken,
      (task: AbstractIncomingMessage) => {
        console.log("got task", task);
        return logInContext("hi there");
      },
      (t: string) => Promise.resolve(console.log(t)),
      () => Promise.resolve(),
      (_: User) => false,
    ),
  },
);
await setTelegramWebhook(telegramToken, url + botServerSuffix);
