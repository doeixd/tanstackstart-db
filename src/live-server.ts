/**
 * Server-side helpers for the live SSE transport.
 *
 * The bus is the in-memory fanout that tracks per-connection
 * subscriptions and emits events to interested clients. It is
 * intentionally framework-agnostic — wire it to Hono, Express, Bun,
 * Deno, or a raw `Request`/`Response` handler. The default fanout is
 * best-effort and does not persist events; see `createDurableLiveEventBus`
 * for a replayable implementation, or supply your own.
 */

/**
 * A single server-side subscription, scoped to one connection.
 */
export interface LiveSubscription {
  readonly entity: string;
  readonly id?: string | number;
  readonly fields?: ReadonlyArray<string>;
}

interface ConnectionEntry {
  readonly id: string;
  readonly send: (event: string, data: string) => void;
  readonly subscriptions: Set<string>;
  readonly createdAt: number;
  /** Number of events dropped because the queue was full. */
  dropped: number;
}

interface SubscriptionEntry {
  readonly sub: LiveSubscription;
  readonly connectionIds: Set<string>;
}

const subscriptionKey = (sub: LiveSubscription): string => {
  const id = sub.id === undefined ? "*" : `${typeof sub.id}:${sub.id}`;
  const fields = sub.fields ? [...sub.fields].sort().join(",") : "*";
  return `${sub.entity}|${id}|${fields}`;
};

const idEquals = (a: string | number | undefined, b: string | number | undefined): boolean => {
  if (a === undefined || b === undefined) return true;
  return String(a) === String(b);
};

const intersects = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean => {
  if (!a || !b) return true;
  if (a.length === 0 || b.length === 0) return true;
  const set = new Set(a);
  for (const item of b) if (set.has(item)) return true;
  return false;
};

/**
 * A connection handle, used by connection-scoped emitters like
 * `connection(connectionId).prependNode(...)`.
 */
export interface LiveConnectionHandle {
  /** Append a node to the connection's list. */
  appendNode(entity: string, id: string | number, value: unknown): void;
  /** Prepend a node to the connection's list. */
  prependNode(entity: string, id: string | number, value: unknown): void;
  /** Delete an edge from the connection's list. */
  deleteEdge(entity: string, id: string | number): void;
  /** Invalidate the connection, forcing it to refetch. */
  invalidate(): void;
}

export interface LiveEventBusOptions {
  /**
   * Maximum number of events buffered per connection. If a connection
   * exceeds this, it is closed so server memory cannot grow without
   * bound. Defaults to `1000`. Mirrors fate's `maxQueueSize`.
   */
  readonly maxQueueSize?: number;
  /**
   * Factory for connection IDs. Defaults to `crypto.randomUUID()`.
   * Override for deterministic IDs in tests.
   */
  readonly createConnectionId?: () => string;
}

export interface LiveEventBus {
  /**
   * Register a new connection. The `send` callback is called for each
   * event the connection should receive. Returns a teardown function
   * that removes the connection and stops all fanout to it.
   */
  addConnection(send: (event: string, data: string) => void): {
    readonly connectionId: string;
    readonly teardown: () => void;
  };
  /**
   * Subscribe a connection to an entity (and optionally a specific
   * record and field set). Called by the control POST handler.
   */
  subscribe(connectionId: string, sub: LiveSubscription): void;
  /**
   * Unsubscribe a connection from a previously subscribed entity.
   * No-op if the subscription does not exist.
   */
  unsubscribe(connectionId: string, sub: LiveSubscription): void;
  /**
   * Emit an `update` event. Fans out to all connections whose
   * subscriptions intersect `entity` + (optional) `id` + (optional)
   * `changed` field paths.
   */
  update<T = unknown>(
    entity: string,
    id: string | number,
    options?: { changed?: ReadonlyArray<string>; value?: T; eventId?: string },
  ): void;
  /**
   * Emit a `create` event. Fans out to all connections subscribed to
   * `entity`. Server-side callers are responsible for ensuring the
   * record was actually created.
   */
  create<T = unknown>(entity: string, value: T, options?: { eventId?: string }): void;
  /**
   * Emit a `delete` event. Fans out to connections subscribed to
   * `entity` and `id`.
   */
  delete(entity: string, id: string | number, options?: { eventId?: string }): void;
  /**
   * Emit an `invalid` event. Forces all subscribers to the entity to
   * refetch.
   */
  invalidate(entity: string, options?: { eventId?: string }): void;
  /**
   * Get a scoped emitter for a single connection. Used for
   * connection-scoped list events.
   */
  connection(connectionId: string): LiveConnectionHandle;
  /**
   * Inspect the current state of the bus. Useful for tests and
   * observability. Returns the number of active connections and the
   * total subscription count.
   */
  readonly stats: {
    readonly connections: number;
    readonly subscriptions: number;
    readonly dropped: number;
  };
  /**
   * Tear down the bus, closing all connections and clearing state.
   */
  close(): void;
}

const DEFAULTS = {
  maxQueueSize: 1000,
} as const;

/**
 * Create an in-memory {@link LiveEventBus}. The bus is the single
 * source of truth for "who is subscribed to what"; the SSE handler is
 * just a transport.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createLiveEventBus, createLiveSseHandler, createLiveControlHandler } from "@doeixd/tanstackstart-db/live-server";
 *
 * const bus = createLiveEventBus();
 *
 * const app = new Hono();
 * app.get("/api/live", createLiveSseHandler(bus));
 * app.post("/api/live/control", createLiveControlHandler(bus));
 *
 * // After a mutation:
 * bus.update("Post", postId, { changed: ["likes"] });
 * ```
 */
export function createLiveEventBus(options: LiveEventBusOptions = {}): LiveEventBus {
  const maxQueueSize = options.maxQueueSize ?? DEFAULTS.maxQueueSize;
  const createConnectionId =
    options.createConnectionId ??
    (() => {
      if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
      }
      // Fallback for environments without crypto.randomUUID
      return `conn_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    });

  const connections = new Map<string, ConnectionEntry>();
  /** Subscriptions indexed by subscription key, with their connection IDs. */
  const subscriptionIndex = new Map<string, SubscriptionEntry>();
  /** Per-connection queue sizes (used to enforce maxQueueSize). */
  const queueSizes = new Map<string, number>();
  let totalDropped = 0;

  const sendToConnection = (entry: ConnectionEntry, event: string, data: string): boolean => {
    if (entry.subscriptions.size === 0 && event !== "connected") {
      // no subscriptions yet; still emit so client knows it is connected
    }
    const currentSize = queueSizes.get(entry.id) ?? 0;
    if (currentSize >= maxQueueSize) {
      entry.dropped += 1;
      totalDropped += 1;
      entry.send("__dropped", JSON.stringify({ reason: "queue_full", max: maxQueueSize }));
      return false;
    }
    try {
      entry.send(event, data);
      queueSizes.set(entry.id, currentSize + 1);
      return true;
    } catch {
      return false;
    }
  };

  const subscriptionMatches = (
    sub: LiveSubscription,
    entity: string,
    id?: string | number,
    changed?: ReadonlyArray<string>,
  ): boolean => {
    if (sub.entity !== entity) return false;
    if (!idEquals(sub.id, id)) return false;
    if (sub.fields && changed) return intersects(sub.fields, changed);
    return true;
  };

  const broadcast = (
    eventName: string,
    entity: string,
    payload: Record<string, unknown>,
    matches: (sub: LiveSubscription) => boolean,
  ) => {
    for (const [, entry] of subscriptionIndex) {
      for (const connId of entry.connectionIds) {
        const conn = connections.get(connId);
        if (!conn) continue;
        if (!matches(entry.sub)) continue;
        const data = JSON.stringify(payload);
        sendToConnection(conn, eventName, data);
      }
    }
  };

  const update: LiveEventBus["update"] = (entity, id, options) => {
    const payload: Record<string, unknown> = { type: "update", entity, id };
    if (options?.value !== undefined) payload["value"] = options.value;
    if (options?.changed) payload["changed"] = [...options.changed];
    if (options?.eventId) payload["eventId"] = options.eventId;
    broadcast("entity.update", entity, payload, (sub) =>
      subscriptionMatches(sub, entity, id, options?.changed),
    );
  };

  const create: LiveEventBus["create"] = (entity, value, options) => {
    const payload: Record<string, unknown> = { type: "create", entity, value };
    if (options?.eventId) payload["eventId"] = options.eventId;
    broadcast("entity.create", entity, payload, (sub) => subscriptionMatches(sub, entity));
  };

  const del: LiveEventBus["delete"] = (entity, id, options) => {
    const payload: Record<string, unknown> = { type: "delete", entity, id };
    if (options?.eventId) payload["eventId"] = options.eventId;
    broadcast("entity.delete", entity, payload, (sub) => subscriptionMatches(sub, entity, id));
  };

  const invalidate: LiveEventBus["invalidate"] = (entity, options) => {
    const payload: Record<string, unknown> = { type: "invalid", entity };
    if (options?.eventId) payload["eventId"] = options.eventId;
    broadcast("entity.invalid", entity, payload, (sub) => subscriptionMatches(sub, entity));
  };

  const connection: LiveEventBus["connection"] = (connectionId) => {
    const entry = connections.get(connectionId);
    return {
      appendNode(entity, id, value) {
        if (!entry) return;
        const payload = { type: "create", entity, id, value, edge: "append" };
        sendToConnection(entry, "entity.create", JSON.stringify(payload));
      },
      prependNode(entity, id, value) {
        if (!entry) return;
        const payload = { type: "create", entity, id, value, edge: "prepend" };
        sendToConnection(entry, "entity.create", JSON.stringify(payload));
      },
      deleteEdge(entity, id) {
        if (!entry) return;
        const payload = { type: "delete", entity, id, edge: true };
        sendToConnection(entry, "entity.delete", JSON.stringify(payload));
      },
      invalidate() {
        if (!entry) return;
        sendToConnection(entry, "entity.invalid", JSON.stringify({ type: "invalid" }));
      },
    };
  };

  return {
    addConnection(send) {
      const connectionId = createConnectionId();
      const entry: ConnectionEntry = {
        id: connectionId,
        send: (event, data) => {
          // Wrap data into the SSE wire format here so callers only pass JSON.
          send(event, `data: ${data}\n\n`);
        },
        subscriptions: new Set(),
        createdAt: Date.now(),
        dropped: 0,
      };
      connections.set(connectionId, entry);
      queueSizes.set(connectionId, 0);
      // Send connected event with the assigned connectionId
      try {
        send("connected", `data: ${JSON.stringify({ type: "connected", connectionId })}\n\n`);
        queueSizes.set(connectionId, (queueSizes.get(connectionId) ?? 0) + 1);
      } catch {
        // ignore
      }
      return {
        connectionId,
        teardown: () => {
          connections.delete(connectionId);
          queueSizes.delete(connectionId);
          for (const subKey of entry.subscriptions) {
            const existing = subscriptionIndex.get(subKey);
            if (existing) {
              existing.connectionIds.delete(connectionId);
              if (existing.connectionIds.size === 0) subscriptionIndex.delete(subKey);
            }
          }
        },
      };
    },
    subscribe(connectionId, sub) {
      const entry = connections.get(connectionId);
      if (!entry) return;
      const key = subscriptionKey(sub);
      entry.subscriptions.add(key);
      const existing = subscriptionIndex.get(key);
      if (existing) {
        existing.connectionIds.add(connectionId);
      } else {
        subscriptionIndex.set(key, { sub, connectionIds: new Set([connectionId]) });
      }
    },
    unsubscribe(connectionId, sub) {
      const entry = connections.get(connectionId);
      if (!entry) return;
      const key = subscriptionKey(sub);
      entry.subscriptions.delete(key);
      const existing = subscriptionIndex.get(key);
      if (existing) {
        existing.connectionIds.delete(connectionId);
        if (existing.connectionIds.size === 0) subscriptionIndex.delete(key);
      }
    },
    update,
    create,
    delete: del,
    invalidate,
    connection,
    get stats() {
      let totalSubs = 0;
      for (const entry of subscriptionIndex.values()) totalSubs += entry.connectionIds.size;
      return { connections: connections.size, subscriptions: totalSubs, dropped: totalDropped };
    },
    close() {
      connections.clear();
      subscriptionIndex.clear();
      queueSizes.clear();
    },
  };
}

/**
 * Create a `Request → Response` handler that opens an SSE stream to
 * the bus. The returned function is framework-agnostic: pass the
 * `Request` and get back a `Response` with `Content-Type:
 * text/event-stream`.
 *
 * @example
 * ```ts
 * app.get("/api/live", createLiveSseHandler(bus));
 * ```
 */
export function createLiveSseHandler(bus: LiveEventBus): (request: Request) => Response {
  return (request: Request): Response => {
    if (request.signal?.aborted) {
      return new Response(null, { status: 499 });
    }
    const encoder = new TextEncoder();
    let teardown: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, frame: string) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\n${frame}`));
          } catch {
            // controller already closed
          }
        };
        const { teardown: td } = bus.addConnection(send);
        teardown = td;
        // Heartbeat every 30s to keep proxies from closing the connection
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            clearInterval(heartbeat);
          }
        }, 30000);
        request.signal?.addEventListener("abort", () => {
          clearInterval(heartbeat);
          if (teardown) teardown();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        if (teardown) teardown();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

/**
 * Create a `Request → Response` handler for control messages
 * (subscribe / unsubscribe). Returns a JSON response.
 *
 * @example
 * ```ts
 * app.post("/api/live/control", createLiveControlHandler(bus));
 * ```
 */
export function createLiveControlHandler(
  bus: LiveEventBus,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return jsonResponse({ ok: false, error: "invalid_body" }, 400);
    }
    const obj = body as Record<string, unknown>;
    const type = obj["type"];
    const connectionId = obj["connectionId"];
    const entity = obj["entity"];
    if (typeof connectionId !== "string") {
      return jsonResponse({ ok: false, error: "missing_connectionId" }, 400);
    }
    if (typeof entity !== "string") {
      return jsonResponse({ ok: false, error: "missing_entity" }, 400);
    }
    if (type !== "subscribe" && type !== "unsubscribe") {
      return jsonResponse({ ok: false, error: "invalid_type" }, 400);
    }
    const sub: LiveSubscription = {
      entity,
      ...(typeof obj["id"] === "string" || typeof obj["id"] === "number"
        ? { id: obj["id"] as string | number }
        : {}),
      ...(Array.isArray(obj["fields"])
        ? {
            fields: (obj["fields"] as ReadonlyArray<unknown>).filter(
              (f): f is string => typeof f === "string",
            ),
          }
        : {}),
    };
    if (type === "subscribe") {
      bus.subscribe(connectionId, sub);
    } else {
      bus.unsubscribe(connectionId, sub);
    }
    return jsonResponse({ ok: true });
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
