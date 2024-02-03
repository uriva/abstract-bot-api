import { complement, equals, nonempty, pipe, withContext } from "gamla";
import http from "node:http";
import { WebSocket, WebSocketServer } from "npm:ws";

import { TaskHandler, UniqueUserId } from "./api.ts";

type SocketMessage = {
  key?: number;
  text?: string;
  percentage?: number;
  spinner?: boolean;
  url?: string;
  urlText?: string;
};

type Manager = {
  mapping: Record<string, WebSocket[]>;
  buffered: Record<string, SocketMessage[]>;
};

const webCommunications = (
  send: (x: SocketMessage) => Promise<void>,
  userId: string,
  uploadToCloudStorage: (path: string) => Promise<string>,
) => ({
  fileLimitMB: () => Infinity,
  userId: () => userId,
  makeProgressBar: (text: string) => {
    const key = Date.now();
    return Promise.resolve((percentage: number) => {
      send({ key, text, percentage });
    });
  },
  spinner: async (text: string) => {
    const key = Date.now();
    await send({ key, text, spinner: true });
    return () => send({ key, text, spinner: false });
  },
  logText: pipe((text: string) => ({ text }), send),
  sendFile: pipe(uploadToCloudStorage, (url: string) => ({ url }), send),
  logURL: (text: string, url: string, urlText: string) =>
    send({ text, url, urlText }),
});

const jsonOnSocket = <T>(msg: T) => (socket: WebSocket) =>
  new Promise<void>((resolve) =>
    socket.send(
      JSON.stringify({ timestamp: Date.now(), ...msg }),
      () => resolve(),
    )
  );

const sendToUser =
  (manager: Manager) => (userId: string) => (msg: SocketMessage) =>
    Promise.any((manager.mapping[userId] || []).map(jsonOnSocket(msg))).catch(
      () => storeInBufffer(manager)(userId, msg),
    );

const storeInBufffer =
  (manager: Manager) => (userId: string, msg: SocketMessage) => {
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
  Promise.all(past.map(sendToUser(manager)(id))).then(() =>
    console.log("sent past messages")
  );
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
  uploadToCloudStorage: (path: string) => Promise<string>,
) => {
  const { addSocket, removeSocket, sendToUser } = makeSocketManager();
  // deno-lint-ignore no-explicit-any
  new WebSocketServer({ server }).on("connection", (ws: any) => {
    console.log("Client connected");
    ws.on("message", async (message: string) => {
      console.log(`Received: ${message}`);
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
      withContext(
        webCommunications(
          sendToUser(uniqueId),
          humanReadableId,
          uploadToCloudStorage,
        ),
        doTask,
      )({ text });
    });
    ws.on("close", () => {
      removeSocket(ws);
      console.log("Client disconnected");
    });
  });
};

type WsLogin = (
  token: string,
) => Promise<null | { humanReadableId: string; uniqueId: UniqueUserId }>;
