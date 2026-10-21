/**
 * Types for core/client-abort.js — the plain-JS client-abort guard shared byte for byte with
 * gateway/src/client-abort.js and frontend/client-abort.js. See the module header there.
 */
import type { IncomingMessage, Server } from 'http';

/** Node's own "the client went away" error on a request stream (`Error: aborted`, ECONNRESET). */
export function isClientAbort(err: unknown): boolean;
/** Give this request a permanent 'error' listener (idempotent). */
export function guardRequest(req: IncomingMessage): void;
/** Guard every request `server` receives, before any other 'request' listener runs. */
export function installClientAbortGuard<T extends Pick<Server, 'prependListener'>>(server: T): T;
