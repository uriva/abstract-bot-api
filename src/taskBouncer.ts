import { coerce, sideLog } from "gamla";
import http from "node:http";
import querystring from "node:querystring";
import url from "node:url";

const getJson = <T>(req: http.IncomingMessage): Promise<T> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      resolve(JSON.parse(data));
    });
    req.on("error", reject);
  });

const success = (res: http.ServerResponse, output: string | null) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(output ?? JSON.stringify({ message: "Data received successfully" }));
};

// deno-lint-ignore no-explicit-any
type Task = { url: string; payload: any; method: string };

const parseUrlParamsAsJson = (requestURL: string) =>
  querystring.parse(url.parse(requestURL).query || "");

const bouncer = (
  domain: string,
  shouldDefer: (task: Task) => boolean,
  deferredHandler: (task: Task) => Promise<void>,
) =>
(req: http.IncomingMessage, res: http.ServerResponse) => {
  console.log(req.url, req.method);
  if (req.method === "POST" && req.url === "/") {
    getJson<Task>(req)
      .then(deferredHandler)
      .then(() => success(res, null));
    return;
  }
  const params = req.method === "POST"
    ? getJson(req)
    : Promise.resolve(parseUrlParamsAsJson(coerce(req.url)));
  params.then(
    (payload) => {
      const task = {
        method: coerce(req.method),
        url: coerce(url.parse(coerce(req.url), true).pathname),
        payload,
      };
      if (shouldDefer(task)) { // Don't await on this, so telegram won't retry when task takes a long time to finish.
        addTask(domain, task)
          .catch(
            (e) => {
              console.error("error submitting task", e);
            },
          );
        return success(res, null);
      }
      return deferredHandler(task).then((x) =>
        success(res, typeof x === "string" ? x : null)
      );
    },
  ).catch((e) => {
    console.error(e);
    res.writeHead(500);
    res.end();
  });
};

const addTask = (domain: string, msg: Task) =>
  fetch(domain, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

// deno-lint-ignore no-explicit-any
type Handler = (payload: Task["payload"]) => Promise<any>;

export type Endpoint = {
  bounce: boolean;
  handler: Handler;
  method: "POST" | "GET";
  path: string;
};

export const bouncerServer = (
  domain: string,
  port: string,
  endpoints: Endpoint[],
) =>
  new Promise<http.Server>((resolve) => {
    const server = http.createServer(
      bouncer(
        domain,
        (task: Task) =>
          endpoints.find(({ path, method }) =>
            path === task.url && method === task.method
          )?.bounce ?? false,
        (task: Task) => {
          for (
            const endpoint of endpoints.filter(({ path, method }) =>
              path === task.url && method === task.method
            )
          ) {
            return endpoint.handler(sideLog(task.payload));
          }
          console.log("no handler for request", task);
          return Promise.resolve();
        },
      ),
    );
    server.listen(port, () => {
      resolve(server);
    });
  });
