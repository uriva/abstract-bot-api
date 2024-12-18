import type http from "node:http";
import { type WebSocket, WebSocketServer } from "npm:ws";
import { gamla } from "../deps.ts";
import {
  injectFileLimitMB,
  injectMedium,
  injectProgressBar,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectUserId,
  type TaskHandler,
  type UniqueUserId,
} from "./api.ts";

const { complement, equals, nonempty, pipe } = gamla;

type ChatEventPreSending = {
  key: string;
  text?: string;
  percentage?: number;
  spinner?: boolean;
  url?: string;
  urlText?: string;
};

export type ChatEvent = ChatEventPreSending & {
  time: number;
  from: string;
  to: string;
};

type Manager = {
  mapping: Record<string, WebSocket[]>;
  buffered: Record<string, ChatEventPreSending[]>;
};

const makeKey = () => crypto.randomUUID();

export const now = () => Date.now();

export const websocketInject = <T extends TaskHandler>(
  send: (x: ChatEventPreSending) => Promise<void>,
  userId: string,
) =>
  pipe(
    injectMedium(() => "websocket")<T>,
    injectFileLimitMB(() => Number.POSITIVE_INFINITY)<T>,
    injectUserId(() => userId)<T>,
    injectProgressBar(async (text: string) => {
      const key = makeKey();
      await send({ key, text, percentage: 0 });
      return Promise.resolve((percentage: number) =>
        send({ key, text, percentage })
      );
    })<T>,
    injectSpinner(async (text: string) => {
      const key = makeKey();
      await send({ key, text, spinner: true });
      return () => send({ key, text, spinner: false });
    })<T>,
    injectReply(async (text: string) => {
      const key = makeKey();
      await send({ text, key });
      return key;
    })<T>,
    injectSendFile(pipe((url: string) => ({ url, key: makeKey() }), send))<T>,
  );

const jsonOnSocket = <T>(msg: T) => (socket: WebSocket) =>
  new Promise<void>((resolve) =>
    socket.send(
      JSON.stringify({ timestamp: now(), ...msg }),
      () => resolve(),
    )
  );

const sendToUser =
  (manager: Manager) => (userId: string) => (msg: ChatEventPreSending) =>
    Promise.any((manager.mapping[userId] || []).map(jsonOnSocket(msg))).catch(
      () => storeInBufffer(manager)(userId, msg),
    );

const storeInBufffer =
  (manager: Manager) => (userId: string, msg: ChatEventPreSending) => {
    manager.buffered[userId] = [...(manager.buffered[userId] || []), msg];
  };

const removeSocket = (manager: Manager) => (ws: WebSocket) => {
  manager.mapping = Object.fromEntries(
    Object.entries(manager.mapping)
      .map(([k, v]) => [k, v.filter(complement(equals(ws)))])
      .filter(([, v]) => nonempty(v as WebSocket[])),
  );
};

const addSocket = (manager: Manager) => (ws: WebSocket, id: string) => {
  removeSocket(manager)(ws);
  manager.mapping = {
    ...manager.mapping,
    [id]: [...(manager.mapping[id] || []), ws],
  };
  const past = manager.buffered[id] || [];
  delete manager.buffered[id];
  Promise.all(past.map(sendToUser(manager)(id))).catch(() => {
    console.log("Failed sending past messages");
  });
};

const makeSocketManager = () => {
  const manager: Manager = { mapping: {}, buffered: {} };
  return {
    sendToUser: sendToUser(manager),
    removeSocket: removeSocket(manager),
    addSocket: addSocket(manager),
  };
};

export const setupWebsocketOnServer = (
  server: http.Server,
  wsLogin: WsLogin,
  doTask: TaskHandler,
) => {
  const { addSocket, removeSocket, sendToUser } = makeSocketManager();
  // deno-lint-ignore no-explicit-any
  new WebSocketServer({ server }).on("connection", (ws: any) => {
    ws.on("message", async (message: string) => {
      const { text, token } = JSON.parse(message) as {
        text: string;
        token: string;
        timestamp: number;
      };
      const loginResult = await wsLogin(token);
      if (!loginResult) {
        ws.close();
        return;
      }
      const { uniqueId, humanReadableId } = loginResult;
      addSocket(ws, uniqueId);
      if (!text) return;
      websocketInject(sendToUser(uniqueId), humanReadableId)(doTask)({ text });
    });
    ws.on("close", () => {
      removeSocket(ws);
    });
  });
};

type WsLogin = (
  token: string,
) => Promise<null | { humanReadableId: string; uniqueId: UniqueUserId }>;
