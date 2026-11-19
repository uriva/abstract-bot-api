import { context, type Injection } from "@uri/inject";

const httpFetchContext: Injection<() => typeof fetch> = context(() =>
  globalThis.fetch
);

export const injectHttpFetch = httpFetchContext.inject;

export const httpFetch: typeof fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => httpFetchContext.access()(input, init);
