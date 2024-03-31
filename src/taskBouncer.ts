import http from "node:http";
import querystring from "node:querystring";
import url from "node:url";
import formidable from "npm:formidable";
import { gamla } from "../deps.ts";
import { injectUrl } from "./api.ts";

const { coerce } = gamla;

const getBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      // 10MB
      if (data.length > 1e7) throw new Error("request too large");
      data += chunk.toString();
    });
    req.on("end", () => {
      resolve(data);
    });
    req.on("error", reject);
  });

const parseFormData = <T>(formData: string): unknown => {
  const parsedFormData = querystring.parse(formData);
  const result: { [key: string]: string | string[] } = {};
  for (const key in parsedFormData) {
    const value = parsedFormData[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      result[key] = value.map((v) => decodeURIComponent(v));
    } else {
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
};

const getJson = async <T>(req: http.IncomingMessage): Promise<T> => {
  const contentType = req.headers["content-type"];
  if (contentType?.includes("application/json")) {
    return JSON.parse(await getBody(req));
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return parseFormData(await getBody(req)) as T;
  }
  if (contentType?.includes("multipart/form-data")) {
    const [fields, files] = await formidable({}).parse(req);
    return { fields, files } as T;
  }
  throw new Error(`Unsupported incoming type: ${contentType}`);
};

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
  if (req.method === "POST" && req.url === "/") {
    getJson<Task>(req)
      .then(deferredHandler)
      .then(() => success(res, null))
      .catch((e) => {
        console.error(e);
        res.writeHead(500);
        res.end();
      });
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
  ).catch((e: Error) => {
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

export const bouncerHandler = (domain: string, endpoints: Endpoint[]) =>
  bouncer(
    domain,
    (task: Task) =>
      endpoints.find(({ path, method }) =>
        path === task.url && method === task.method
      )?.bounce ?? false,
    (task: Task) => {
      for (
        const { handler } of endpoints.filter(({ path, method }) =>
          path === task.url && method === task.method
        )
      ) return injectUrl(() => task.url)(handler)(task.payload);
      console.log("no handler for request", task);
      return Promise.resolve();
    },
  );

export const bouncerServer = (
  domain: string,
  port: string,
  endpoints: Endpoint[],
) =>
  new Promise<http.Server>((resolve) => {
    const server = http.createServer(bouncerHandler(domain, endpoints));
    server.listen(port, () => {
      resolve(server);
    });
  });
