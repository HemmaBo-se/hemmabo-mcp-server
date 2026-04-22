/**
 * Minimal local types mirroring @vercel/node's VercelRequest / VercelResponse.
 *
 * We define these locally instead of importing from @vercel/node to avoid
 * pulling the entire @vercel/node package (and its transitive dependencies:
 * undici, path-to-regexp, ajv, minimatch, @vercel/build-utils, etc.) into
 * this repo just for type references. Vercel supplies the actual request
 * and response objects at runtime; TypeScript only needs the shape.
 *
 * These declarations are intentionally narrow — only the members this
 * codebase actually uses are included. Extend as needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface VercelRequestQuery {
  [key: string]: string | string[] | undefined;
}

export interface VercelRequestCookies {
  [key: string]: string | undefined;
}

export interface VercelRequestBody {
  [key: string]: unknown;
}

export interface VercelRequest extends IncomingMessage {
  query: VercelRequestQuery;
  cookies: VercelRequestCookies;
  body: any;
}

export interface VercelResponse extends ServerResponse {
  send: (body: any) => VercelResponse;
  json: (jsonBody: any) => VercelResponse;
  status: (statusCode: number) => VercelResponse;
  redirect: (statusOrUrl: number | string, url?: string) => VercelResponse;
}
