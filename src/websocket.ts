import type http from "node:http";
import { type WebSocket, WebSocketServer } from "npm:ws";
import { gamla } from "../deps.ts";
import {
  type ChatEventPreSending,
  genericInject,
  injectMedium,
  now,
  type TaskHandler,
  type UniqueUserId,
} from "./api.ts";

const { complement, equals, nonempty, pipe } = gamla;

type Manager = {
  mapping: Record<string, WebSocket[]>;
  buffered: Record<string, ChatEventPreSending[]>;
};

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
      pipe(
        genericInject(sendToUser(uniqueId), humanReadableId),
        injectMedium(() => "websocket"),
      )(doTask)({ text });
    });
    ws.on("close", () => {
      removeSocket(ws);
    });
  });
};

type WsLogin = (
  token: string,
) => Promise<null | { humanReadableId: string; uniqueId: UniqueUserId }>;
