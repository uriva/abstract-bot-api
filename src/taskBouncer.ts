import type { Buffer } from "@std/io";
import { coerce } from "gamla";
import http from "node:http";
import querystring from "node:querystring";
import url from "node:url";

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

const parseUrlParamsAsJson = <T>(requestURL: string) =>
  querystring.parse(url.parse(requestURL).query || "") as T;

const pathForDeferred = "/abstract-bot-api-deferred";
const deferredHeader = "x-abstract-bot-api-internal-token";

type TaskAddress = { method: string; url: string };

export type EndpointRequest<T> = {
  address: TaskAddress;
  headers: http.IncomingHttpHeaders;
  payload: T;
  rawBody?: string;
};

const rawBodyToPayload = <T>(
  contentType: string | undefined,
  rawBody: string,
): Promise<T> => {
  if (contentType?.includes("application/json")) {
    return Promise.resolve(JSON.parse(rawBody) as T);
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Promise.resolve(parseFormData(rawBody) as T);
  }
  if (contentType?.includes("multipart/form-data")) {
    return new Promise<T>((resolve) => {
      const [, boundary] = contentType.split("boundary=");
      const formData: Record<string, unknown> = {};
      rawBody.split(`--${boundary}`).forEach((part) => {
        if (part.trim() !== "") {
          const [header, content] = part.split("\r\n\r\n");
          const headers = header.split("\r\n");
          const fieldNameMatch = /name="(.+?)"/.exec(headers[1]);
          const fieldName = fieldNameMatch ? fieldNameMatch[1] : null;
          if (fieldName) {
            const isFile = headers[0].includes("filename");
            const fieldValue = isFile
              ? content
              : content.substring(0, content.length - 2);
            formData[fieldName] = isFile
              ? { filename: fieldName, data: fieldValue }
              : fieldValue;
          }
        }
      });
      resolve(formData as T);
    });
  }
  throw new Error(`Unsupported incoming type: ${contentType}`);
};

const reqToPayload = async <T>(
  req: http.IncomingMessage,
): Promise<{ payload: T; rawBody?: string }> => {
  if (req.method !== "POST") {
    return { payload: parseUrlParamsAsJson<T>(coerce(req.url)) };
  }
  const rawBody = await getBody(req);
  return {
    payload: await rawBodyToPayload<T>(req.headers["content-type"], rawBody),
    rawBody,
  };
};

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

type Authenticate<T> = (
  request: EndpointRequest<T>,
) => Promise<boolean> | boolean;

const runEndpoint = <T>(
  address: TaskAddress,
  addTask: (payload: T) => void,
  { bounce, handler, authenticate }: Endpoint<T>,
) =>
async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const { payload, rawBody } = await reqToPayload<T>(req);
  if (authenticate) {
    const authenticated = await Promise.resolve(
      authenticate({ address, headers: req.headers, payload, rawBody }),
    ).catch((error) => {
      console.error("Endpoint authentication failed", error);
      return false;
    });
    if (!authenticated) {
      res.writeHead(401, corsHeaders);
      res.end();
      return;
    }
  }
  if (bounce) {
    addTask(payload);
    res.writeHead(200, corsHeaders);
    res.end();
  } else {
    handler(payload, res, address);
  }
};

type Task<T> = { payload: T; address: TaskAddress };

type EndpointBase<T> = {
  predicate: (task: TaskAddress) => boolean;
  authenticate?: Authenticate<T>;
};

export type Endpoint<T> =
  & EndpointBase<T>
  & ({
    bounce: false;
    handler: (task: T, res: http.ServerResponse, address: TaskAddress) => void;
  } | {
    bounce: true;
    handler: (payload: T) => Promise<void>;
  });

const deferredHandlerEndpoint = <T>(
  eps: Endpoint<T>[],
  internalToken: string,
): Endpoint<Task<T>> => ({
  bounce: false,
  predicate: ({ method, url }) => method === "POST" && url === pathForDeferred,
  authenticate: ({ headers }) => headers[deferredHeader] === internalToken,
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

const addTask =
  (domain: string, internalToken: string) =>
  (address: TaskAddress) =>
  <T>(payload: T) => {
    fetch(domain + pathForDeferred, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [deferredHeader]: internalToken,
      },
      body: JSON.stringify({ address, payload } satisfies Task<T>),
    })
      // For test purposes, we must consume the body.
      .then((x) => x.body?.cancel())
      .catch((e) => {
        console.error("Bouncer server failed to submit task", e);
      });
  };

const selectAndRunEndpoint = (
  addTask: <T>(task: TaskAddress) => (t: T) => void,
  // deno-lint-ignore no-explicit-any
  endpoints: Endpoint<any>[],
) =>
(req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  const address = reqToTaskAddress(req);
  for (const ep of endpoints.filter(({ predicate }) => predicate(address))) {
    runEndpoint(address, addTask(address), ep)(req, res);
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
    const internalToken = crypto.randomUUID();
    const server = http.createServer(
      selectAndRunEndpoint(
        addTask(domain, internalToken),
        [deferredHandlerEndpoint(endpoints, internalToken), ...endpoints],
      ),
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
