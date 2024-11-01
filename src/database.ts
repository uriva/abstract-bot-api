import type { TaskHandler } from "./api.ts";
import type { Endpoint } from "./taskBouncer.ts";
import { makeKey, now, websocketInject } from "./websocket.ts";

type ClientRequest = { from: string; text: string; token: string };

export const makeDatabaseHandler = (
    storer: <T>(value: T) => Promise<void>,
    doTask: TaskHandler,
    path: string,
    botName: string,
    authenticate: (token: string, userId: string) => Promise<boolean>,
): Endpoint => ({
    bounce: true,
    method: "POST",
    path,
    handler: async ({ from, text, token }: ClientRequest) => {
        if (!await authenticate(token, from)) return;
        await storer({ from, key: makeKey(), text, time: now() });
        return websocketInject(
            (x) => storer({ ...x, time: now(), from: botName }),
            from,
        )(doTask)({ text });
    },
});
