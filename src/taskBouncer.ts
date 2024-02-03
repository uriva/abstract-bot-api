import { sideLog } from "gamla";
import http from "node:http";

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

const success = (res: http.ServerResponse) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Data received successfully" }));
};

// deno-lint-ignore no-explicit-any
type BouncedTask = { url: string; payload: any };

const bouncer =
  (domain: string, handler: (task: BouncedTask) => Promise<void>) =>
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    console.log(req.url, req.method);
    if (req.method === "POST" && req.url === "/") {
      getJson<BouncedTask>(req)
        .then(handler)
        .then(() => success(res));
      return;
    }
    if (req.method === "POST") {
      getJson<BouncedTask["payload"]>(req).then((payload) => {
        // Don't await on this, so telegram won't retry when task takes a long time to finish.
        addTask(domain, { url: req.url, payload } as BouncedTask).catch((e) => {
          console.error("error submitting task", e);
        });
        return success(res);
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };

const addTask = (domain: string, msg: BouncedTask) =>
  fetch(domain, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

export const bouncerServer = (
  domain: string,
  port: string,
  handlers: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (payload: BouncedTask["payload"]) => Promise<any>
  >,
) =>
  new Promise<http.Server>((resolve) => {
    const server = http.createServer(
      bouncer(domain, ({ url, payload }: BouncedTask) => {
        if (url in handlers) return handlers[url](sideLog(payload));
        console.log("no handler for request", url, payload);
        return Promise.resolve();
      }),
    );
    server.listen(port, () => {
      resolve(server);
    });
  });
