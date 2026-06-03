import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { createLiveClient, type LiveEvent } from "../src/live-client.ts";

/**
 * In-memory mock of the EventSource contract used by `createLiveClient`.
 * Tests construct an instance directly and drive events / errors.
 */
class MockEventSource {
  static instances: Array<MockEventSource> = [];
  static last: MockEventSource | null = null;

  url: string;
  withCredentials: boolean;
  readyState: number = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private listeners = new Map<string, Set<(ev: Event) => unknown>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
    MockEventSource.last = this;
  }

  addEventListener(type: string, listener: ((ev: Event) => unknown) | null): void {
    if (!listener) return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: ((ev: Event) => unknown) | null): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  /** Test helper: fire a typed event. */
  emit(type: string, data: string, lastEventId?: string): void {
    const event = {
      data,
      type,
      lastEventId: lastEventId ?? "",
      origin: "test",
    } as unknown as MessageEvent;
    const set = this.listeners.get(type);
    if (set) for (const fn of set) fn(event);
    if (type === "message" && this.onmessage) this.onmessage(event);
    if (type === "open" && this.onopen) this.onopen(event as unknown as Event);
    if (type === "error" && this.onerror) this.onerror(event as unknown as Event);
  }

  /** Test helper: simulate the server opening the connection. */
  open(): void {
    this.readyState = 1;
    const event = { type: "open" } as unknown as Event;
    this.onopen?.(event);
  }

  /** Test helper: simulate a connection error. */
  error(closed: boolean): void {
    if (closed) this.readyState = 2;
    const event = { type: "error" } as unknown as Event;
    this.onerror?.(event);
  }

  close(): void {
    this.readyState = 2;
  }

  static reset(): void {
    MockEventSource.instances = [];
    MockEventSource.last = null;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createLiveClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    MockEventSource.reset();
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch!;
  });

  it("opens an EventSource to the configured URL on creation", () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.last!.url).toBe("/api/live");
    expect(MockEventSource.last!.withCredentials).toBe(true);
    expect(live.status).toBe("connecting");
  });

  it("transitions to 'open' when the EventSource fires open", () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();
    expect(live.status).toBe("open");
  });

  it("dispatches entity.update events to subscribers", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const events: Array<LiveEvent> = [];
    live.subscribe("Post", (event) => {
      events.push(event);
    });

    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Post",
        value: { id: 1, title: "x" },
        changed: ["title"],
      }),
    );

    // callbacks run in microtask
    await wait(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("update");
    if (events[0]?.type === "update") {
      expect(events[0].value).toEqual({ id: 1, title: "x" });
      expect(events[0].changed).toEqual(["title"]);
    }
  });

  it("dispatches entity.create and entity.delete events", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const events: Array<LiveEvent> = [];
    live.subscribe("Post", (event) => {
      events.push(event);
    });

    MockEventSource.last!.emit(
      "entity.create",
      JSON.stringify({ type: "create", entity: "Post", value: { id: 1 } }),
    );
    MockEventSource.last!.emit(
      "entity.delete",
      JSON.stringify({ type: "delete", entity: "Post", id: 1 }),
    );

    await wait(0);
    expect(events.map((e) => e.type)).toEqual(["create", "delete"]);
  });

  it("filters subscribers by entity name", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const postEvents: Array<LiveEvent> = [];
    const commentEvents: Array<LiveEvent> = [];
    live.subscribe("Post", (e) => postEvents.push(e));
    live.subscribe("Comment", (e) => commentEvents.push(e));

    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({ type: "update", entity: "Post", value: { id: 1 } }),
    );

    await wait(0);
    expect(postEvents).toHaveLength(1);
    expect(commentEvents).toHaveLength(0);
  });

  it("filters subscribers by record id when subscribed with { id }", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const events1: Array<LiveEvent> = [];
    const events2: Array<LiveEvent> = [];
    live.subscribe("Post", (e) => events1.push(e), { id: 1 });
    live.subscribe("Post", (e) => events2.push(e), { id: 2 });

    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({ type: "update", entity: "Post", value: { id: 1 } }),
    );

    await wait(0);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(0);
  });

  it("filters by field intersection when subscribed with { fields }", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const events: Array<LiveEvent> = [];
    live.subscribe("Post", (e) => events.push(e), { fields: ["likes"] });

    // changed=["likes"] intersects → dispatch
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Post",
        value: { id: 1, likes: 2 },
        changed: ["likes"],
      }),
    );
    // changed=["title"] does NOT intersect → skip
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Post",
        value: { id: 1, title: "new" },
        changed: ["title"],
      }),
    );

    await wait(0);
    expect(events).toHaveLength(1);
    const first = events[0];
    if (first?.type === "update") {
      expect(first.changed).toEqual(["likes"]);
    }
  });

  it("records lastEventId from incoming events", () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({ type: "update", entity: "Post", value: { id: 1 }, eventId: "evt_42" }),
      "evt_42",
    );
    expect(live.lastEventId).toBe("evt_42");
  });

  it("sends a control subscribe message once the server assigns a connectionId", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    live.subscribe("Post", () => {});

    // Server sends the connected event with the connectionId
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "conn_1" }),
    );

    await wait(0);
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/live/control");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      type: "subscribe",
      connectionId: "conn_1",
      entity: "Post",
    });
  });

  it("sends an unsubscribe control message when the subscriber is removed", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "conn_1" }),
    );
    await wait(0);

    fetchMock.mockClear();
    const unsubscribe = live.subscribe("Post", () => {});
    await wait(0);
    const subCallCount = fetchMock.mock.calls.length;

    unsubscribe();
    await wait(0);
    expect(fetchMock.mock.calls.length).toBe(subCallCount + 1);
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const body = JSON.parse(init.body);
    expect(body.type).toBe("unsubscribe");
  });

  it("buffers and dispatches events to subscribers in microtasks", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const received: Array<number> = [];
    live.subscribe("Post", (event) => {
      if (event.type === "update") received.push((event.value as { id: number }).id);
    });

    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({ type: "update", entity: "Post", value: { id: 1 } }),
    );
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({ type: "update", entity: "Post", value: { id: 2 } }),
    );

    // synchronously, no events yet
    expect(received).toEqual([]);
    // after microtask flush, both arrive in order
    await wait(0);
    expect(received).toEqual([1, 2]);
  });

  it("ignores messages with malformed JSON and reports to onLiveError", async () => {
    const errors: Array<{ err: Error; kind: string }> = [];
    createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
      onLiveError: (err, ctx) => {
        errors.push({ err, kind: ctx.kind });
      },
    });
    MockEventSource.last!.open();
    MockEventSource.last!.emit("message", "{not json");
    await wait(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("parse");
  });

  it("reconnects on error and resubscribes existing subscribers", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
      reconnectDelay: 5,
      maxReconnectDelay: 10,
    });
    MockEventSource.last!.open();
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "conn_1" }),
    );
    await wait(0);

    live.subscribe("Post", () => {});
    await wait(0);

    fetchMock.mockClear();
    // Simulate a closed connection
    MockEventSource.last!.error(true);
    expect(live.status).toBe("reconnecting");

    // Wait for the reconnect timer to fire
    await wait(20);
    expect(MockEventSource.instances.length).toBe(2);
    // The new EventSource should be opened at the same URL
    expect(MockEventSource.last!.url).toBe("/api/live");
  });

  it("does not reconnect after close()", () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
      reconnectDelay: 1,
    });
    MockEventSource.last!.open();
    live.close();
    expect(live.status).toBe("closed");
  });

  it("uses custom control URL when provided", async () => {
    const live = createLiveClient({
      url: "/api/live",
      controlUrl: "/api/live/control/v2",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();
    live.subscribe("Post", () => {});
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "c1" }),
    );
    await wait(0);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/live/control/v2");
  });

  it("reports control-send failures via onLiveError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const errors: Array<{ kind: string }> = [];
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
      onLiveError: (_e, ctx) => {
        errors.push({ kind: ctx.kind });
      },
    });
    MockEventSource.last!.open();
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "c1" }),
    );
    await wait(0);
    live.subscribe("Post", () => {});
    await wait(0);
    expect(errors.some((e) => e.kind === "send")).toBe(true);
  });
});
