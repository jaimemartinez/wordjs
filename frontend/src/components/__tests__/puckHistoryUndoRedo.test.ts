/**
 * PuckEditor undo/redo — the @wordjs/puck public store API the wrapper drives.
 *
 * PuckEditor.tsx never re-implements history: HistoryControls and EditorHotkeys read
 * `s.history.hasPast` / `s.history.hasFuture` and call `getPuck().history.back()` / `.forward()`, and
 * `updateComponent` creates undoable entries by dispatching `{ type:'setData', data: fn,
 * recordHistory:true }`. So the wrapper's undo/redo behaviour IS the behaviour of the real store this
 * test builds with the package's own `createAppStore()`. This exercises the exact surface the wrapper
 * uses — a genuine state-transition test, no DOM required.
 *
 * Each assertion pins a transition that PuckEditor depends on; mutate the history slice
 * (frontend/packages/puck/store/slices/history.ts) and a line here goes red — e.g. make `record`
 * stop truncating the redo branch, or make `back()` not decrement the index, and the corresponding
 * `expect` fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAppStore } from "../../../packages/puck/store";

type Store = ReturnType<typeof createAppStore>;

// Mirror updateComponent's dispatch shape: a recordHistory setData that stamps a marker on root props.
const setTitle = (store: Store, title: string) =>
  store.getState().dispatch({
    type: "setData",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: ((prev: any) => ({ root: { ...prev.root, props: { ...(prev.root?.props || {}), title } } })) as any,
    recordHistory: true,
  });

const title = (store: Store): string | undefined =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store.getState().state.data.root as any)?.props?.title;

const hist = (store: Store) => store.getState().history;

// `record` is debounced 250ms; commit a pending record by advancing fake timers past the window.
const commit = () => vi.advanceTimersByTime(300);

describe("PuckEditor undo/redo via the real @wordjs/puck store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a fresh store has no past and no future", () => {
    const store = createAppStore();
    expect(hist(store).hasPast()).toBe(false);
    expect(hist(store).hasFuture()).toBe(false);
  });

  it("recording changes builds a past; back() then forward() restore prior/next data", () => {
    const store = createAppStore();

    setTitle(store, "v1"); commit();
    setTitle(store, "v2"); commit();
    expect(title(store)).toBe("v2");
    expect(hist(store).hasPast()).toBe(true);   // two entries -> index 1 -> hasPast
    expect(hist(store).hasFuture()).toBe(false);

    hist(store).back();
    expect(title(store)).toBe("v1");            // back() dispatched a `set` to the previous state
    expect(hist(store).hasPast()).toBe(false);
    expect(hist(store).hasFuture()).toBe(true);

    hist(store).forward();
    expect(title(store)).toBe("v2");
    expect(hist(store).hasFuture()).toBe(false);
  });

  it("back() is a no-op when there is nothing to undo (guarded by hasPast)", () => {
    const store = createAppStore();
    setTitle(store, "only"); commit();          // one entry -> index 0 -> hasPast false
    expect(hist(store).hasPast()).toBe(false);
    const before = title(store);
    hist(store).back();                         // must not throw, must not change state
    expect(title(store)).toBe(before);
  });

  it("recording after an undo TRUNCATES the redo branch (no orphan future)", () => {
    const store = createAppStore();
    setTitle(store, "a"); commit();
    setTitle(store, "b"); commit();
    hist(store).back();                         // back to "a", "b" now in the future
    expect(hist(store).hasFuture()).toBe(true);

    setTitle(store, "c"); commit();             // a NEW branch from "a"
    expect(title(store)).toBe("c");
    expect(hist(store).hasFuture()).toBe(false); // "b" was dropped
    hist(store).back();
    expect(title(store)).toBe("a");             // the branch point, not "b"
  });
});
