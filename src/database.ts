import type { TaskHandler } from "./api.ts";
import type { Endpoint } from "./taskBouncer.ts";
import { type ChatEvent, now, websocketInject } from "./websocket.ts";

type ClientRequest = { from: string; text: string; token: string };

export const makeDatabaseHandler = (
  storer: (value: ChatEvent) => Promise<void>,
  doTask: TaskHandler,
  path: string,
  botName: string,
  authenticate: (token: string, userId: string) => Promise<boolean>,
): Endpoint<ClientRequest> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: async ({ from, text, token }: ClientRequest) => {
    if (await authenticate(token, from)) {
      return websocketInject(
        (x) => storer({ ...x, time: now(), from: botName, to: from }),
        from,
      )(doTask)({ text });
    }
  },
});
