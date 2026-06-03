import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  createLiveEventBus,
  createLiveSseHandler,
  createLiveControlHandler,
} from "../src/live-server.ts";

/**
 * Parses SSE wire-format frames back into typed events.
 */
const parseSseFrames = (raw: string): Array<{ event: string; data: string }> => {
  const frames: Array<{ event: string; data: string }> = [];
  const lines = raw.split("\n");
  let currentEvent: string | null = null;
  let currentData: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (currentEvent !== null) {
        frames.push({ event: currentEvent, data: currentData.join("\n") });
      }
      currentEvent = null;
      currentData = [];
    } else if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    }
  }
  if (currentEvent !== null) {
    frames.push({ event: currentEvent, data: currentData.join("\n") });
  }
  return frames;
};

/** Captures all bytes a write callback receives, and returns the parsed SSE frames. */
const captureSse = () => {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  return {
    send: (event: string, frame: string) => {
      chunks.push(`event: ${event}\n${frame}`);
    },
    raw: () => chunks.join(""),
    frames: () => parseSseFrames(chunks.join("")),
    bytes: () => chunks.map((c) => encoder.encode(c)),
  };
};

describe("createLiveEventBus", () => {
  it("assigns a unique connectionId on addConnection and emits a 'connected' event", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    expect(typeof connectionId).toBe("string");
    expect(connectionId.length).toBeGreaterThan(0);
    const frames = cap.frames();
    expect(frames[0]?.event).toBe("connected");
    const data = JSON.parse(frames[0]?.data ?? "{}");
    expect(data.connectionId).toBe(connectionId);
  });

  it("fans out an update event to connections subscribed to the entity", () => {
    const bus = createLiveEventBus();
    const cap1 = captureSse();
    const cap2 = captureSse();
    const { connectionId: c1 } = bus.addConnection(cap1.send);
    const { connectionId: c2 } = bus.addConnection(cap2.send);
    bus.subscribe(c1, { entity: "Post" });
    bus.subscribe(c2, { entity: "Post" });

    bus.update("Post", 1, { value: { id: 1, title: "hi" } });

    const f1 = cap1.frames().filter((f) => f.event === "entity.update");
    const f2 = cap2.frames().filter((f) => f.event === "entity.update");
    expect(f1).toHaveLength(1);
    expect(f2).toHaveLength(1);
    const payload = JSON.parse(f1[0]?.data ?? "{}");
    expect(payload).toMatchObject({
      type: "update",
      entity: "Post",
      id: 1,
      value: { id: 1, title: "hi" },
    });
  });

  it("does not fan out to connections subscribed to a different entity", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Comment" });

    bus.update("Post", 1, { value: { id: 1 } });
    const updates = cap.frames().filter((f) => f.event === "entity.update");
    expect(updates).toHaveLength(0);
  });

  it("respects per-record subscriptions", () => {
    const bus = createLiveEventBus();
    const cap1 = captureSse();
    const cap2 = captureSse();
    const { connectionId: c1 } = bus.addConnection(cap1.send);
    const { connectionId: c2 } = bus.addConnection(cap2.send);
    bus.subscribe(c1, { entity: "Post", id: 1 });
    bus.subscribe(c2, { entity: "Post", id: 2 });

    bus.update("Post", 1, { value: { id: 1 } });
    const f1 = cap1.frames().filter((f) => f.event === "entity.update");
    const f2 = cap2.frames().filter((f) => f.event === "entity.update");
    expect(f1).toHaveLength(1);
    expect(f2).toHaveLength(0);
  });

  it("respects field-level subscriptions (changed paths)", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post", fields: ["likes"] });

    bus.update("Post", 1, { changed: ["title"], value: { id: 1 } });
    const noIntersection = cap.frames().filter((f) => f.event === "entity.update");
    expect(noIntersection).toHaveLength(0);

    bus.update("Post", 1, { changed: ["likes"], value: { id: 1, likes: 5 } });
    const intersected = cap.frames().filter((f) => f.event === "entity.update");
    expect(intersected).toHaveLength(1);
  });

  it("emits create and delete events", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post" });

    bus.create("Post", { id: 1, title: "x" });
    bus.delete("Post", 1);

    const createFrames = cap.frames().filter((f) => f.event === "entity.create");
    const deleteFrames = cap.frames().filter((f) => f.event === "entity.delete");
    expect(createFrames).toHaveLength(1);
    expect(deleteFrames).toHaveLength(1);
    expect(JSON.parse(deleteFrames[0]?.data ?? "{}").id).toBe(1);
  });

  it("emits invalid events to all subscribers of an entity", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post" });
    bus.invalidate("Post");
    const frames = cap.frames().filter((f) => f.event === "entity.invalid");
    expect(frames).toHaveLength(1);
  });

  it("emits a 'prepend' edge event via connection handle", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);

    bus.connection(connectionId).prependNode("Comment", 5, { id: 5 });
    const frames = cap.frames().filter((f) => f.event === "entity.create");
    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0]?.data ?? "{}");
    expect(payload).toMatchObject({ type: "create", entity: "Comment", id: 5, edge: "prepend" });
  });

  it("emits a 'deleteEdge' event via connection handle", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.connection(connectionId).deleteEdge("Comment", 5);
    const frames = cap.frames().filter((f) => f.event === "entity.delete");
    expect(frames).toHaveLength(1);
  });

  it("drops events and closes the connection when the queue is full", () => {
    const bus = createLiveEventBus({ maxQueueSize: 2 });
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post" });

    bus.update("Post", 1, { value: { id: 1 } });
    bus.update("Post", 1, { value: { id: 1 } });
    bus.update("Post", 1, { value: { id: 1 } });
    bus.update("Post", 1, { value: { id: 1 } });

    expect(bus.stats.dropped).toBeGreaterThan(0);
  });

  it("removes subscriptions when unsubscribe is called", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post" });
    bus.unsubscribe(connectionId, { entity: "Post" });

    bus.update("Post", 1, { value: { id: 1 } });
    const updates = cap.frames().filter((f) => f.event === "entity.update");
    expect(updates).toHaveLength(0);
  });

  it("teardown removes the connection and its subscriptions", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    const { connectionId, teardown } = bus.addConnection(cap.send);
    bus.subscribe(connectionId, { entity: "Post" });
    expect(bus.stats.connections).toBe(1);
    teardown();
    expect(bus.stats.connections).toBe(0);
    bus.update("Post", 1, { value: { id: 1 } });
    expect(cap.frames().filter((f) => f.event === "entity.update")).toHaveLength(0);
  });

  it("close() clears all state", () => {
    const bus = createLiveEventBus();
    const cap = captureSse();
    bus.addConnection(cap.send);
    bus.close();
    expect(bus.stats.connections).toBe(0);
  });
});

describe("createLiveSseHandler", () => {
  it("returns a Response with the right SSE headers", () => {
    const bus = createLiveEventBus();
    const handler = createLiveSseHandler(bus);
    const response = handler(new Request("http://localhost/api/live"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-cache");
  });
});

describe("createLiveControlHandler", () => {
  let bus: ReturnType<typeof createLiveEventBus>;
  let handler: ReturnType<typeof createLiveControlHandler>;

  beforeEach(() => {
    bus = createLiveEventBus();
    handler = createLiveControlHandler(bus);
  });

  it("subscribes a connection to an entity on 'subscribe' message", async () => {
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);

    const response = await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "subscribe", connectionId, entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);

    bus.update("Post", 1, { value: { id: 1 } });
    const updates = cap.frames().filter((f) => f.event === "entity.update");
    expect(updates).toHaveLength(1);
  });

  it("unsubscribes a connection on 'unsubscribe' message", async () => {
    const cap = captureSse();
    const { connectionId } = bus.addConnection(cap.send);

    await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "subscribe", connectionId, entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "unsubscribe", connectionId, entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    bus.update("Post", 1, { value: { id: 1 } });
    const updates = cap.frames().filter((f) => f.event === "entity.update");
    expect(updates).toHaveLength(0);
  });

  it("rejects missing connectionId with 400", async () => {
    const response = await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "subscribe", entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects invalid type with 400", async () => {
    const response = await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "banana", connectionId: "x", entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await handler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("end-to-end: bus + SSE + control + subscription work together", async () => {
    const fetchSpy = vi.fn();
    const sseHandler = createLiveSseHandler(bus);
    const controlHandler = createLiveControlHandler(bus);

    // Simulate a client that opens the SSE stream
    const req = new Request("http://localhost/api/live");
    const res = sseHandler(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read the first chunk (should contain the 'connected' event)
    const { value } = await reader.read();
    const firstChunk = decoder.decode(value);
    expect(firstChunk).toContain("event: connected");
    const connectionIdMatch = firstChunk.match(/"connectionId":"([^"]+)"/);
    expect(connectionIdMatch).toBeTruthy();
    const connectionId = connectionIdMatch![1]!;

    // Send a control message
    const controlRes = await controlHandler(
      new Request("http://localhost/api/live/control", {
        method: "POST",
        body: JSON.stringify({ type: "subscribe", connectionId, entity: "Post" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(controlRes.status).toBe(200);

    // Emit an event and read it from the stream
    bus.update("Post", 42, { value: { id: 42, title: "Hello" } });
    const { value: nextValue } = await reader.read();
    const nextChunk = decoder.decode(nextValue);
    expect(nextChunk).toContain("event: entity.update");
    expect(nextChunk).toContain('"id":42');

    void fetchSpy; // silence unused
    await reader.cancel();
  });
});
