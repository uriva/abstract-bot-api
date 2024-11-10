import type { Buffer } from "https://deno.land/std@0.140.0/io/buffer.ts";
import http from "node:http";
import querystring from "node:querystring";
import url from "node:url";
import { gamla } from "../deps.ts";

const { coerce } = gamla;

const getBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
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
    return new Promise<T>((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk;
      });
      req.on("end", () => {
        const [, boundary] = contentType.split("boundary=");
        const formData: Record<string, unknown> = {};
        body.split(`--${boundary}`).forEach((part) => {
          if (part.trim() !== "") {
            const [header, content] = part.split("\r\n\r\n");
            const headers = header.split("\r\n");
            const fieldNameMatch = /name="(.+?)"/.exec(headers[1]);
            const fieldName = fieldNameMatch ? fieldNameMatch[1] : null;
            if (fieldName) {
              const isFile = headers[0].includes("filename");
              const fieldValue = isFile
                ? content
                : content.substring(0, content.length - 2); // Remove trailing \r\n
              formData[fieldName] = isFile
                ? { filename: fieldName, data: fieldValue }
                : fieldValue;
            }
          }
        });
        resolve(formData as T);
      });
    });
  }
  throw new Error(`Unsupported incoming type: ${contentType}`);
};

const parseUrlParamsAsJson = <T>(requestURL: string) =>
  querystring.parse(url.parse(requestURL).query || "") as T;

const pathForDeferred = "/abstract-bot-api-deferred";

const reqToPayload = <T>(req: http.IncomingMessage): Promise<T> =>
  req.method === "POST"
    ? getJson<T>(req)
    : Promise.resolve(parseUrlParamsAsJson<T>(coerce(req.url)));

type TaskAddress = { method: string; url: string };

const runEndpoint = <T>(
  address: TaskAddress,
  addTask: (payload: T) => void,
  { bounce, handler }: Endpoint<T>,
) =>
async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    const payload: T = await reqToPayload<T>(req);
    if (bounce) {
      addTask(payload);
      res.writeHead(200);
      res.end();
    } else {
      handler(payload, res, address);
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end();
  }
};

type Task<T> = { payload: T; address: TaskAddress };

export type Endpoint<T> = {
  predicate: (task: TaskAddress) => boolean;
  bounce: false;
  handler: (task: T, res: http.ServerResponse, address: TaskAddress) => void;
} | {
  predicate: (address: TaskAddress) => boolean;
  bounce: true;
  handler: (payload: T) => Promise<void>;
};

const deferredHandlerEndpoint = <T>(eps: Endpoint<T>[]): Endpoint<Task<T>> => ({
  bounce: false,
  predicate: ({ method, url }) => method === "POST" && url === pathForDeferred,
  handler: async ({ address, payload }, res) => {
    for (
      const relevantEndpoint of eps.filter(({ predicate }) =>
        predicate(address)
      )
    ) {
      if (!relevantEndpoint.bounce) continue;
      try {
        await relevantEndpoint.handler(payload);
        res.writeHead(200);
        res.end();
      } catch (e) {
        console.error(e);
        res.writeHead(500);
        res.end();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  },
});

const reqToTaskAddress = (req: http.IncomingMessage): TaskAddress => ({
  method: coerce(req.method),
  url: coerce(url.parse(coerce(req.url), true).pathname),
});

const addTask = (deferralUrl: string) => <T>(task: Task<T>) =>
  fetch(deferralUrl + pathForDeferred, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(task),
  });

const selectAndRunEndpoint =
  // deno-lint-ignore no-explicit-any
  (addTask: <T>(task: Task<T>) => void, endpoints: Endpoint<any>[]) =>
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    const address = reqToTaskAddress(req);
    for (
      const endpoint of endpoints.filter(({ predicate }) => predicate(address))
    ) {
      runEndpoint(
        address,
        (payload) => addTask({ address, payload }),
        endpoint,
      )(
        req,
        res,
      );
      return;
    }
    res.writeHead(404);
    res.end();
  };

export const bouncerServer = (
  domain: string,
  port: string,
  // deno-lint-ignore no-explicit-any
  endpoints: Endpoint<any>[],
): Promise<http.Server> =>
  new Promise((resolve) => {
    const server = http.createServer(
      selectAndRunEndpoint((x) =>
        addTask(domain)(x).catch((e) => {
          console.error("Failed processing deferred task", e);
        }), [
        deferredHandlerEndpoint(endpoints),
        ...endpoints,
      ]),
    );
    server.listen(port, () => {
      resolve(server);
    });
  });

export const staticFileEndpoint = (
  text: string,
  contentType: string,
  triggerUrl: string,
  // deno-lint-ignore no-explicit-any
): Endpoint<any> => ({
  predicate: ({ url, method }) => method === "GET" && url === triggerUrl,
  bounce: false,
  handler: (_, res) => {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(text);
  },
});
