/**
 * Verso/collaboration — a save names the room generation it comes from.
 *
 * The collaborative editor saves through the ordinary `PUT /posts/:id`. The backend tells that save —
 * which IS the room's state — from a write made outside the room (a revision restore, another editor),
 * which resets the room. What tells them apart is `X-Collab-Epoch`: the epoch the document was seeded
 * from. These tests drive the real session against the fake server and the real `api()` against a
 * stubbed `fetch`, and check that the header is attached exactly when a live session exists for THAT
 * post, follows the room into a new generation, and disappears when the session ends.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { VersoCollabSession } from "../client";
import { collabSaveHeaders, setCollabSaveEpoch } from "../saveEpoch";
import { FakeCollabServer, ManualTimers } from "./fakeServer";
import type { VersoData } from "../../types";

const BASE: VersoData = { root: { props: { title: "T" } }, content: [] };
const SITE = "s_aaaaaaaaaaaaaaaa";

afterEach(() => {
  setCollabSaveEpoch(7, null);
  setCollabSaveEpoch(8, null);
  vi.unstubAllGlobals();
});

describe("collabSaveHeaders", () => {
  it("only a PUT to the post of a live session carries the epoch", () => {
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({});
    setCollabSaveEpoch(7, 3);
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({ "X-Collab-Epoch": "3" });
    expect(collabSaveHeaders("/posts/7?x=1", "PUT")).toEqual({ "X-Collab-Epoch": "3" });
    // Another post, another verb, a sub-route: nothing.
    expect(collabSaveHeaders("/posts/70", "PUT")).toEqual({});
    expect(collabSaveHeaders("/posts/7", "GET")).toEqual({});
    expect(collabSaveHeaders("/posts/7/meta", "PUT")).toEqual({});
    setCollabSaveEpoch(7, null);
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({});
  });
});

describe("the session publishes its generation", () => {
  it("welcome sets it, a new generation replaces it, stop clears it", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 3, name: "Ana" });
    const timers = new ManualTimers();
    const session = new VersoCollabSession({
      postId: 7, transport: server.transport(), siteId: SITE, flushMs: 10, presenceMs: 10,
      setTimer: timers.set, clearTimer: timers.clear,
    });
    session.start();
    await timers.run();
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({ "X-Collab-Epoch": "1" });

    // The room is reset (a revision restored elsewhere): the next welcome is a new generation.
    server.epoch = 2;
    server.dropStream(SITE);
    await timers.run();
    await timers.run();
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({ "X-Collab-Epoch": "2" });

    session.stop();
    expect(collabSaveHeaders("/posts/7", "PUT")).toEqual({});
  });
});

describe("api() attaches it to the save", () => {
  it("PUT /posts/:id goes out with X-Collab-Epoch while the session is live", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ id: 8 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { postsApi } = await import("@/lib/api");

    await postsApi.update(8, { title: "x" } as any);
    expect(calls[0].headers["X-Collab-Epoch"]).toBeUndefined();

    setCollabSaveEpoch(8, 5);
    await postsApi.update(8, { title: "y" } as any);
    expect(calls[1].headers["X-Collab-Epoch"]).toBe("5");
  });
});
