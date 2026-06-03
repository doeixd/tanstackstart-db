import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { createCollection } from "@tanstack/db";
import { createLiveClient, liveCollectionOptions } from "../src/live-client.ts";

type Post = { id: string; title: string; likes: number };

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

  open(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" } as unknown as Event);
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
const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      if (typeof setImmediate === "function") {
        setImmediate(resolve);
      } else {
        setTimeout(resolve, 5);
      }
    });
  }
};

describe("liveCollectionOptions integration", () => {
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

  it("inserts initial-fetch items and applies live update events to the collection", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const posts = createCollection(
      liveCollectionOptions<Post>({
        id: "posts",
        entity: "Post",
        live,
        initialFetch: async () => [
          { id: "1", title: "Hello", likes: 0 },
          { id: "2", title: "World", likes: 5 },
        ],
      }),
    );

    // Debug: wait a bit and log
    await waitFor(() => posts.size === 2);
    const items = posts.toArray as unknown as Array<Post>;
    expect(items.map((p) => p.id).sort()).toEqual(["1", "2"]);

    // Simulate the server pushing an update for post 1
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Post",
        value: { id: "1", title: "Hello", likes: 99 },
        changed: ["likes"],
      }),
    );

    await waitFor(() => {
      const found = (posts.toArray as unknown as Array<Post>).find((p) => p.id === "1");
      return found?.likes === 99;
    });
    const updated = (posts.toArray as unknown as Array<Post>).find((p) => p.id === "1");
    expect(updated?.likes).toBe(99);
  });

  it("applies live create and delete events", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const posts = createCollection(
      liveCollectionOptions<Post>({
        id: "posts",
        entity: "Post",
        live,
      }),
    );

    await waitFor(() => posts.size === 0);

    MockEventSource.last!.emit(
      "entity.create",
      JSON.stringify({ type: "create", entity: "Post", value: { id: "1", title: "x", likes: 0 } }),
    );
    await waitFor(() => posts.size === 1);
    expect(posts.has("1")).toBe(true);

    MockEventSource.last!.emit(
      "entity.delete",
      JSON.stringify({ type: "delete", entity: "Post", id: "1" }),
    );
    await waitFor(() => posts.size === 0);
    expect(posts.has("1")).toBe(false);
  });

  it("respects field-level subscription when fields option is provided", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const posts = createCollection(
      liveCollectionOptions<Post>({
        id: "posts",
        entity: "Post",
        live,
        fields: ["id", "title"],
      }),
    );

    await waitFor(() => posts.size === 0);

    // Simulate the connected event
    MockEventSource.last!.emit(
      "message",
      JSON.stringify({ type: "connected", connectionId: "c1" }),
    );
    await wait(0);

    // The control message should include fields
    const subCall = fetchMock.mock.calls.find((call) => {
      const body = JSON.parse(call[1]?.body as string);
      return body.type === "subscribe";
    });
    expect(subCall).toBeDefined();
    const body = JSON.parse(subCall![1]?.body as string);
    expect(body.fields).toEqual(["id", "title"]);
  });

  it("re-renders the collection when an update event arrives", async () => {
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const posts = createCollection(
      liveCollectionOptions<Post>({
        id: "posts",
        entity: "Post",
        live,
        initialFetch: async () => [{ id: "1", title: "Hello", likes: 0 }],
      }),
    );

    await waitFor(() => posts.size === 1);
    const beforeLikes = (posts.toArray as unknown as Array<Post>)[0]?.likes;
    expect(beforeLikes).toBe(0);

    // Send an update
    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Post",
        value: { id: "1", title: "Hello", likes: 42 },
        changed: ["likes"],
      }),
    );

    await waitFor(() => {
      const found = (posts.toArray as unknown as Array<Post>).find((p) => p.id === "1");
      return found?.likes === 42;
    });

    const afterLikes = (posts.toArray as unknown as Array<Post>).find((p) => p.id === "1")?.likes;
    expect(afterLikes).toBe(42);
  });

  it("uses custom getKey when provided", async () => {
    type Item = { id: string; key: string; name: string };
    const live = createLiveClient({
      url: "/api/live",
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last!.open();

    const items = createCollection(
      liveCollectionOptions<Item>({
        id: "items",
        entity: "Item",
        live,
        getKey: (item) => item.key,
        initialFetch: async () => [{ id: "ignored", key: "k1", name: "alice" }],
      }),
    );

    await waitFor(() => items.size === 1);
    expect(items.has("k1")).toBe(true);

    MockEventSource.last!.emit(
      "entity.update",
      JSON.stringify({
        type: "update",
        entity: "Item",
        value: { id: "ignored", key: "k1", name: "bob" },
      }),
    );
    await waitFor(() => {
      const found = (items.toArray as unknown as Array<Item>).find((i) => i.key === "k1");
      return found?.name === "bob";
    });
  });
});
