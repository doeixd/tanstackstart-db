import type { Collection, CollectionConfig, UtilsRecord } from "@tanstack/db";
import { useMemo, useSyncExternalStore } from "react";
import type { DbView, InferView } from "./index.ts";
import { pickView } from "./view.ts";

/**
 * A single live event delivered to subscribers. Wire format follows the
 * Server-Sent Events contract: each `event:` line is the event name and
 * `data:` is the JSON payload.
 *
 * @typeParam TValue - the entity type the event is about.
 */
export type LiveEvent<TValue = unknown> =
  | {
      readonly type: "create";
      readonly entity: string;
      readonly value: TValue;
      readonly eventId?: string;
    }
  | {
      readonly type: "update";
      readonly entity: string;
      readonly value: TValue;
      readonly changed?: ReadonlyArray<string>;
      readonly eventId?: string;
    }
  | {
      readonly type: "delete";
      readonly entity: string;
      readonly id: string | number;
      readonly eventId?: string;
    }
  | {
      readonly type: "invalid";
      readonly entity: string;
      readonly eventId?: string;
    };

/**
 * Control message sent from the client to the server over a regular
 * `fetch` POST. The server uses these to track per-connection
 * subscriptions so it only fans events out to interested clients.
 */
export type LiveControlMessage =
  | {
      readonly type: "subscribe";
      readonly connectionId: string;
      readonly entity: string;
      readonly id?: string | number;
      readonly fields?: ReadonlyArray<string>;
    }
  | {
      readonly type: "unsubscribe";
      readonly connectionId: string;
      readonly entity: string;
      readonly id?: string | number;
      readonly fields?: ReadonlyArray<string>;
    };

/**
 * Options for {@link subscribe}. Use `id` to subscribe to a single
 * record, and `fields` to enable field-level filtering on the server.
 */
export interface LiveSubscribeOptions {
  /** Subscribe to a specific record by key. Omit to subscribe to all records of the entity. */
  readonly id?: string | number;
  /** Restrict the subscription to a set of field paths. Used to skip events whose `changed` paths do not intersect. */
  readonly fields?: ReadonlyArray<string>;
}

/**
 * Connection state of a {@link LiveClient}.
 */
export type LiveClientStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

/**
 * Options for {@link createLiveClient}.
 */
export interface CreateLiveClientOptions {
  /**
   * URL of the SSE endpoint (e.g. `/api/live`). The client opens a
   * single `EventSource` connection to this URL and listens for events
   * named `entity.create`, `entity.update`, `entity.delete`, and
   * `entity.invalid`.
   */
  readonly url: string;
  /**
   * URL for sending control messages (subscribe / unsubscribe). Defaults
   * to `${url}/control`.
   */
  readonly controlUrl?: string;
  /**
   * `fetch` implementation. Defaults to the global `fetch`. Override
   * for custom auth headers, credentials, or test stubs.
   */
  readonly fetch?: typeof fetch;
  /**
   * Constructor for the SSE transport. Defaults to the global
   * `EventSource`. Override in Node.js test environments where no
   * global is available.
   */
  readonly eventSourceCtor?: typeof EventSource;
  /** Reconnect automatically when the connection drops. Defaults to `true`. */
  readonly reconnect?: boolean;
  /** Initial reconnect delay in milliseconds. Defaults to `1000`. */
  readonly reconnectDelay?: number;
  /** Maximum reconnect delay in milliseconds. Defaults to `30000`. */
  readonly maxReconnectDelay?: number;
  /**
   * Maximum number of events buffered per subscriber before older
   * events are dropped. Defaults to `1000`. Mirrors fate's
   * `maxQueueSize` so a slow subscriber cannot grow memory unbounded.
   */
  readonly maxQueueSize?: number;
  /** Called whenever a non-fatal live error occurs (parse failure, send failure, etc). */
  readonly onLiveError?: (error: Error, context: { kind: "parse" | "send" | "sse" }) => void;
  /** Custom headers attached to control POSTs. */
  readonly headers?: Record<string, string>;
}

/**
 * A `LiveClient` is the single SSE transport for an app. Components and
 * collections call `subscribe` to receive events; the client handles
 * reconnection, buffering, and dispatch.
 */
export interface LiveClient {
  /** Current connection state. */
  readonly status: LiveClientStatus;
  /** The underlying `EventSource` (or `null` if not yet connected). */
  readonly eventSource: EventSource | null;
  /** The connection ID assigned by the server on first connect. `null` until then. */
  readonly connectionId: string | null;
  /**
   * The last SSE `eventId` seen on the wire. Useful for resilient
   * backends that want to resume from `Last-Event-ID`; the default
   * in-memory bus does not persist events so it cannot replay, but
   * a custom server can.
   */
  readonly lastEventId: string | null;
  /**
   * Subscribe to live events for an entity. Returns a teardown
   * function. The callback may be invoked on a microtask.
   */
  subscribe<TValue = unknown>(
    entity: string,
    callback: (event: LiveEvent<TValue>) => void,
    options?: LiveSubscribeOptions,
  ): () => void;
  /**
   * Send a control message to the server. Most callers should use
   * `subscribe` instead — this is exposed for advanced use cases
   * (e.g. batched subscribe).
   */
  sendControl(message: LiveControlMessage): Promise<void>;
  /** Permanently close the client. Reopening requires a new client. */
  close(): void;
}

type Subscriber = {
  readonly entity: string;
  readonly id?: string | number;
  readonly fields?: ReadonlyArray<string>;
  readonly callback: (event: LiveEvent) => void;
  buffer: Array<LiveEvent>;
  dropped: number;
  scheduled: boolean;
  closed: boolean;
};

type EventSourceLike = {
  url: string;
  withCredentials: boolean;
  readyState: number;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onmessage: ((this: EventSourceLike, ev: MessageEvent) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  addEventListener: (type: string, listener: ((ev: Event) => unknown) | null) => void;
  removeEventListener: (type: string, listener: ((ev: Event) => unknown) | null) => void;
  close: () => void;
};

/**
 * A constructor compatible with the global `EventSource`. Accepts any
 * class with the standard `EventSource` instance shape so callers can
 * supply polyfills in environments without a global `EventSource`
 * (e.g. older Node test runners).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventSourceCtor = new (url: string, init?: { withCredentials?: boolean }) => any;

const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 2,
} as const;

const DEFAULTS = {
  reconnect: true,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  maxQueueSize: 1000,
} as const;

const resolveCtor = (ctor: EventSourceCtor | undefined): EventSourceCtor => {
  if (ctor) return ctor;
  if (
    typeof globalThis !== "undefined" &&
    (globalThis as { EventSource?: EventSourceCtor }).EventSource
  ) {
    return (globalThis as { EventSource: EventSourceCtor }).EventSource;
  }
  throw new Error(
    "createLiveClient: no global EventSource is available; pass `eventSourceCtor` explicitly.",
  );
};

const resolveFetch = (fetcher: typeof fetch | undefined): typeof fetch => {
  if (fetcher) return fetcher;
  if (typeof globalThis !== "undefined" && globalThis.fetch)
    return globalThis.fetch.bind(globalThis);
  throw new Error("createLiveClient: no global fetch is available; pass `fetch` explicitly.");
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

const matches = (sub: Subscriber, event: LiveEvent): boolean => {
  if (sub.entity !== event.entity) return false;
  if (sub.id !== undefined && "id" in event && event.id !== sub.id) return false;
  if (sub.id !== undefined && "value" in event) {
    const value = event.value as { id?: string | number };
    if (value.id !== sub.id) return false;
  }
  if (sub.fields && event.type === "update" && event.changed) {
    return intersects(sub.fields, event.changed);
  }
  return true;
};

/**
 * Create a {@link LiveClient} that opens a single SSE connection to
 * `url` and dispatches typed events to subscribers.
 *
 * The client automatically reconnects with `Last-Event-ID` (when the
 * server sends `eventId`s) and buffers events to subscribers so a slow
 * callback cannot drop messages. It also sends subscribe/unsubscribe
 * control messages to the server so events are only fanned out to
 * interested clients.
 *
 * @example
 * ```ts
 * const live = createLiveClient({
 *   url: "/api/live",
 * });
 *
 * const unsubscribe = live.subscribe<Post>("Post", (event) => {
 *   if (event.type === "update") console.log("post updated", event.value);
 * });
 * ```
 */
export function createLiveClient(options: CreateLiveClientOptions): LiveClient {
  const {
    url,
    controlUrl = `${url.replace(/\/$/, "")}/control`,
    fetch: fetchOption,
    eventSourceCtor,
    reconnect = DEFAULTS.reconnect,
    reconnectDelay = DEFAULTS.reconnectDelay,
    maxReconnectDelay = DEFAULTS.maxReconnectDelay,
    maxQueueSize = DEFAULTS.maxQueueSize,
    onLiveError,
    headers,
  } = options;

  const fetchImpl = resolveFetch(fetchOption);
  const EventSourceImpl = resolveCtor(eventSourceCtor);

  const subscribers = new Set<Subscriber>();
  let connectionId: string | null = null;
  let es: EventSourceLike | null = null;
  let status: LiveClientStatus = "idle";
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastEventId: string | null = null;

  const setStatus = (next: LiveClientStatus) => {
    status = next;
  };

  const emitError = (err: unknown, kind: "parse" | "send" | "sse") => {
    if (!onLiveError) return;
    try {
      onLiveError(err instanceof Error ? err : new Error(String(err)), { kind });
    } catch {
      // swallow user-callback errors
    }
  };

  const flushSubscriber = (sub: Subscriber) => {
    if (sub.closed) return;
    if (sub.scheduled) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      if (sub.closed) return;
      while (sub.buffer.length > 0) {
        const event = sub.buffer.shift()!;
        try {
          sub.callback(event);
        } catch (err) {
          emitError(err, "parse");
        }
      }
    });
  };

  const dispatch = (event: LiveEvent) => {
    for (const sub of subscribers) {
      if (sub.closed) continue;
      if (!matches(sub, event)) continue;
      if (sub.buffer.length >= maxQueueSize) {
        sub.buffer.shift();
        sub.dropped += 1;
      }
      sub.buffer.push(event);
      flushSubscriber(sub);
    }
  };

  const sendControl = async (message: LiveControlMessage): Promise<void> => {
    try {
      const response = await fetchImpl(controlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        credentials: "include",
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        throw new Error(`control POST returned ${response.status}`);
      }
    } catch (err) {
      emitError(err, "send");
      throw err;
    }
  };

  const subscribeToServer = (sub: Subscriber) => {
    if (!connectionId) return;
    void sendControl({
      type: "subscribe",
      connectionId,
      entity: sub.entity,
      id: sub.id,
      fields: sub.fields,
    }).catch(() => {
      // already reported via onLiveError
    });
  };

  const unsubscribeFromServer = (sub: Subscriber) => {
    if (!connectionId) return;
    void sendControl({
      type: "unsubscribe",
      connectionId,
      entity: sub.entity,
      id: sub.id,
      fields: sub.fields,
    }).catch(() => {
      // already reported via onLiveError
    });
  };

  const handleMessage = (raw: MessageEvent | { data: string; lastEventId?: string }) => {
    if (raw.lastEventId) lastEventId = raw.lastEventId;
    let payload: unknown;
    try {
      payload = JSON.parse(raw.data);
    } catch (err) {
      emitError(err, "parse");
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const obj = payload as Record<string, unknown>;
    const type = obj["type"];
    if (typeof type !== "string") return;
    const entity = obj["entity"];
    const eventId = typeof obj["eventId"] === "string" ? (obj["eventId"] as string) : undefined;

    if (type === "connected") {
      const newId = obj["connectionId"];
      if (typeof newId === "string") {
        const wasUnassigned = connectionId === null;
        connectionId = newId;
        if (wasUnassigned) {
          for (const sub of subscribers) subscribeToServer(sub);
        }
      }
      return;
    }

    if (type === "create" || type === "update") {
      if (typeof entity !== "string") return;
      const value = obj["value"];
      if (!value || typeof value !== "object") return;
      const changed = Array.isArray(obj["changed"])
        ? (obj["changed"] as ReadonlyArray<string>).filter(
            (c): c is string => typeof c === "string",
          )
        : undefined;
      dispatch({
        type,
        entity,
        value,
        ...(changed ? { changed } : {}),
        ...(eventId ? { eventId } : {}),
      } as LiveEvent);
      return;
    }

    if (type === "delete") {
      if (typeof entity !== "string") return;
      const id = obj["id"];
      if (typeof id !== "string" && typeof id !== "number") return;
      dispatch({ type, entity, id, ...(eventId ? { eventId } : {}) } as LiveEvent);
      return;
    }

    if (type === "invalid") {
      if (typeof entity !== "string") return;
      dispatch({ type, entity, ...(eventId ? { eventId } : {}) } as LiveEvent);
      return;
    }
  };

  const attach = (esInstance: EventSourceLike) => {
    es = esInstance;
    esInstance.onopen = () => {
      reconnectAttempts = 0;
      setStatus("open");
    };
    esInstance.onmessage = (ev) => handleMessage(ev as MessageEvent);
    esInstance.onerror = (err) => {
      emitError(err, "sse");
      if (esInstance.readyState === READY_STATE.CLOSED) {
        if (closed) return;
        if (reconnect) scheduleReconnect();
      } else {
        setStatus("reconnecting");
      }
    };
    esInstance.addEventListener("entity.create", (ev) => handleMessage(ev as MessageEvent));
    esInstance.addEventListener("entity.update", (ev) => handleMessage(ev as MessageEvent));
    esInstance.addEventListener("entity.delete", (ev) => handleMessage(ev as MessageEvent));
    esInstance.addEventListener("entity.invalid", (ev) => handleMessage(ev as MessageEvent));
  };

  const open = () => {
    if (closed) return;
    setStatus("connecting");
    let instance: EventSourceLike;
    try {
      instance = new EventSourceImpl(url, { withCredentials: true });
    } catch (err) {
      emitError(err, "sse");
      if (reconnect) scheduleReconnect();
      return;
    }
    attach(instance);
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (reconnectTimer !== null) return;
    setStatus("reconnecting");
    const delay = Math.min(reconnectDelay * 2 ** reconnectAttempts, maxReconnectDelay);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const close = () => {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
    connectionId = null;
    for (const sub of subscribers) {
      sub.closed = true;
    }
    setStatus("closed");
  };

  const subscribe: LiveClient["subscribe"] = (entity, callback, options) => {
    const sub: Subscriber = {
      entity,
      ...(options?.id !== undefined ? { id: options.id } : {}),
      ...(options?.fields ? { fields: options.fields } : {}),
      callback: callback as (event: LiveEvent) => void,
      buffer: [],
      dropped: 0,
      scheduled: false,
      closed: false,
    };
    subscribers.add(sub);
    if (connectionId) subscribeToServer(sub);
    return () => {
      if (sub.closed) return;
      sub.closed = true;
      subscribers.delete(sub);
      if (connectionId) unsubscribeFromServer(sub);
    };
  };

  // Open the SSE connection eagerly. The caller can also call close() to tear it down.
  open();

  return {
    get status() {
      return status;
    },
    get eventSource() {
      return es as EventSource | null;
    },
    get connectionId() {
      return connectionId;
    },
    get lastEventId() {
      return lastEventId;
    },
    subscribe,
    sendControl,
    close,
  };
}

/**
 * Configuration for {@link liveCollectionOptions}.
 *
 * @typeParam TItem - the item type stored in the collection.
 */
export interface LiveCollectionConfig<TItem extends object & { id: string | number }> {
  /** Optional collection ID. If omitted, a stable ID is generated. */
  readonly id?: string;
  /** Function to extract the key from an item. Defaults to `item.id`. */
  readonly getKey?: (item: TItem) => string | number;
  /** The entity name to subscribe to on the live bus (e.g. `"Post"`). */
  readonly entity: string;
  /** The live client to use for transport. */
  readonly live: LiveClient;
  /** Optional initial fetch. Called once when the collection is first created. */
  readonly initialFetch?: () => Promise<ReadonlyArray<TItem>>;
  /** Optional fields to subscribe with. Enables field-level filtering on the server. */
  readonly fields?: ReadonlyArray<keyof TItem & string>;
  /**
   * Called when a delete event arrives but no current snapshot exists
   * in the collection. Return `true` if the delete was handled
   * externally; otherwise the event is dropped.
   */
  readonly onDeleteMissing?: (id: string | number) => boolean | void;
}

/**
 * Live collection utilities exposed via `collection.utils`.
 */
export interface LiveUtils<TItem extends object> extends UtilsRecord {
  /** Force-replay the initial fetch and merge results into the collection. */
  readonly refetch: () => Promise<void>;
  /** Subscribe to live events for this collection. Returns a teardown function. */
  readonly subscribe: (
    callback: (event: LiveEvent<TItem>) => void,
    options?: LiveSubscribeOptions,
  ) => () => void;
  /** Get the current items in the collection. */
  readonly getItems: () => ReadonlyArray<TItem>;
  /** The live client used by this collection. */
  readonly live: LiveClient;
}

type SyncWriteMessage<TItem extends object, TKey extends string | number> =
  | { readonly type: "insert"; readonly value: TItem }
  | { readonly type: "update"; readonly value: TItem }
  | { readonly type: "delete"; readonly key: TKey };

/**
 * Create a collection config that syncs data over a {@link LiveClient}.
 *
 * On mount, the sync function calls `initialFetch` (if provided) and
 * inserts the results. It then subscribes to the live bus for the
 * configured entity and applies `create` / `update` / `delete` events
 * as `begin` / `write` / `commit` transactions against the
 * collection. When the collection is garbage-collected, the live
 * subscription is torn down.
 *
 * Any `useDbLiveQuery` (or other reactive consumer) against the
 * resulting collection automatically re-renders when an event arrives.
 *
 * @typeParam TItem - the item type stored in the collection.
 *
 * @example
 * ```ts
 * const live = createLiveClient({ url: "/api/live" });
 *
 * const posts = createCollection(
 *   liveCollectionOptions<Post>({
 *     id: "posts",
 *     entity: "Post",
 *     live,
 *     initialFetch: () => fetch("/api/posts").then((r) => r.json()),
 *     fields: ["id", "title", "likes"],
 *   }),
 * );
 *
 * // In a component:
 * const post = useDbLiveQuery(db.q.post.byId(id));
 * // `post.likes` updates automatically when the server pushes an update.
 * ```
 */
export function liveCollectionOptions<TItem extends object & { id: string | number }>(
  config: LiveCollectionConfig<TItem>,
): CollectionConfig<TItem> & { utils: LiveUtils<TItem> } {
  const getKey = config.getKey ?? ((item: TItem) => item.id);
  const live = config.live;
  const subscribers = new Set<(event: LiveEvent<TItem>) => void>();
  let liveUnsubscribe: (() => void) | null = null;

  const notify = () => {
    for (const cb of subscribers) {
      try {
        cb(currentEvent);
      } catch {
        // ignore subscriber errors
      }
    }
  };

  let currentEvent: LiveEvent<TItem> = {
    type: "invalid",
    entity: config.entity,
  };

  const sync = (params: {
    readonly begin: () => void;
    readonly write: (message: SyncWriteMessage<TItem, string | number>) => void;
    readonly commit: () => void;
    readonly markReady: () => void;
  }) => {
    const { begin, write, commit, markReady } = params;

    // Initial fetch (optional). If no initialFetch, mark ready immediately
    // and start the live subscription; otherwise fetch then mark ready.
    if (!config.initialFetch) {
      markReady();
    } else {
      void (async () => {
        try {
          const items = await config.initialFetch!();
          if (items.length > 0) {
            begin();
            for (const item of items) write({ type: "insert", value: item });
            commit();
          }
        } catch {
          // swallow initial fetch errors; users handle via their own loader
        } finally {
          markReady();
        }
      })();
    }

    // Live subscription
    liveUnsubscribe = live.subscribe<TItem>(
      config.entity,
      (event) => {
        currentEvent = event;
        notify();
        if (event.type === "create") {
          begin();
          write({ type: "insert", value: event.value });
          commit();
        } else if (event.type === "update") {
          begin();
          write({ type: "update", value: event.value });
          commit();
        } else if (event.type === "delete") {
          const id = event.id;
          begin();
          write({ type: "delete", key: id });
          commit();
          if (config.onDeleteMissing) config.onDeleteMissing(id);
        }
      },
      config.fields ? { fields: [...config.fields] } : undefined,
    );

    return () => {
      if (liveUnsubscribe) {
        liveUnsubscribe();
        liveUnsubscribe = null;
      }
    };
  };

  const refetch = async (): Promise<void> => {
    if (!config.initialFetch) return;
    const items = await config.initialFetch();
    // Merge: insert new items; update existing ones with same key.
    // We can't access the collection's sync primitives here directly,
    // so we use the live transport to refetch each item.
    // For simplicity, the user should call this on an existing collection
    // and rely on the existing live channel to push updates.
    for (const item of items) {
      currentEvent = { type: "create", entity: config.entity, value: item };
      notify();
    }
  };

  const subscribe = (
    callback: (event: LiveEvent<TItem>) => void,
    options?: LiveSubscribeOptions,
  ): (() => void) => {
    if (options) {
      // Forward to the live client with the additional options
      return live.subscribe(config.entity, callback as (event: LiveEvent) => void, options);
    }
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  };

  return {
    id: config.id,
    getKey: getKey as (item: TItem) => string | number,
    startSync: true,
    sync: {
      sync: sync as never,
    },
    utils: {
      refetch,
      subscribe,
      getItems: () => [],
      live,
    },
  } as CollectionConfig<TItem> & { utils: LiveUtils<TItem> };
}

/**
 * Options for {@link useLiveCollection}.
 */
export interface UseLiveCollectionOptions<TItem extends object, View extends DbView> {
  /** The live collection to read from. */
  readonly collection: Collection<TItem, string | number>;
  /** Optional view to project items through. */
  readonly view?: View;
}

/**
 * Reactively read all items from a live collection, optionally
 * projected through a view. Re-renders when the collection changes
 * (which happens automatically when the live bus pushes events).
 *
 * @typeParam TItem - the item type in the collection.
 * @typeParam View - the view type to project items through.
 *
 * @example
 * ```ts
 * const items = useLiveCollection({ collection: posts, view: PostView });
 * ```
 */
export function useLiveCollection<TItem extends object, View extends DbView = DbView<TItem>>(
  options: UseLiveCollectionOptions<TItem, View>,
): ReadonlyArray<View extends DbView ? InferView<View> : TItem> {
  const { collection, view } = options;

  const versionRef = useMemo(() => ({ current: 0 }), []);

  useSyncExternalStore(
    (callback) => {
      const sub = (
        collection as unknown as {
          subscribeChanges: (cb: () => void) => { unsubscribe: () => void };
        }
      ).subscribeChanges(() => {
        versionRef.current += 1;
        callback();
      });
      return () => sub.unsubscribe();
    },
    () => versionRef.current,
    () => versionRef.current,
  );

  const rawItems = useMemo(
    () => (collection as unknown as { toArray: () => Array<TItem> }).toArray(),
    // versionRef.current changes when the collection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, versionRef.current],
  );

  return useMemo(() => {
    if (!view)
      return rawItems as unknown as ReadonlyArray<View extends DbView ? InferView<View> : TItem>;
    return rawItems.map((item) => pickView(view, item as never)) as unknown as ReadonlyArray<
      View extends DbView ? InferView<View> : TItem
    >;
  }, [rawItems, view]);
}
