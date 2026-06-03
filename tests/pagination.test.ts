import { describe, it, expect } from "vite-plus/test";
import { createCollection } from "@tanstack/db";
import { paginatedCollectionOptions } from "../src/pagination.ts";

type Item = { id: string; title: string };

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("pagination", () => {
  describe("paginatedCollectionOptions", () => {
    it("creates a collection config with default direction", () => {
      const config = paginatedCollectionOptions<Item>({
        id: "test",
        getKey: (item) => item.id,
        pageSize: 10,
        cursor: "id",
        fetchPage: async () => ({ items: [], hasNextPage: false }),
      });

      expect(config.id).toBe("test");
      expect(config.getKey({ id: "1", title: "t" })).toBe("1");
      expect(config.sync).toBeDefined();
      expect(config.utils).toBeDefined();
      expect(config.utils.subscribe).toBeDefined();
      expect(config.utils.getState).toBeDefined();
    });

    it("creates a collection config with bidirectional pagination", () => {
      const config = paginatedCollectionOptions<Item>({
        id: "test",
        getKey: (item) => item.id,
        pageSize: 20,
        cursor: "id",
        direction: "both",
        fetchPage: async () => ({ items: [], hasNextPage: true, hasPreviousPage: true }),
      });

      expect(config.id).toBe("test");
      expect(config.utils.loadNextPage).toBeDefined();
      expect(config.utils.loadPreviousPage).toBeDefined();
    });

    it("getState returns initial pagination state", () => {
      const config = paginatedCollectionOptions<Item>({
        getKey: (item) => item.id,
        pageSize: 10,
        cursor: "id",
        fetchPage: async () => ({ items: [], hasNextPage: false }),
      });

      const state = config.utils.getState();
      expect(state.hasNextPage).toBe(true);
      expect(state.hasPreviousPage).toBe(false);
      expect(state.isLoadingNext).toBe(false);
      expect(state.isLoadingPrevious).toBe(false);
      expect(state.error).toBeUndefined();
    });

    it("subscribe returns an unsubscribe function", () => {
      const config = paginatedCollectionOptions<Item>({
        getKey: (item) => item.id,
        pageSize: 10,
        cursor: "id",
        fetchPage: async () => ({ items: [], hasNextPage: false }),
      });

      const callback = () => {};
      const unsubscribe = config.utils.subscribe(callback);
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    it("throws when pageSize is not a positive integer", () => {
      expect(() =>
        paginatedCollectionOptions<Item>({
          getKey: (item) => item.id,
          pageSize: 0,
          cursor: "id",
          fetchPage: async () => ({ items: [] }),
        }),
      ).toThrow(/pageSize/);

      expect(() =>
        paginatedCollectionOptions<Item>({
          getKey: (item) => item.id,
          pageSize: -1,
          cursor: "id",
          fetchPage: async () => ({ items: [] }),
        }),
      ).toThrow(/pageSize/);

      expect(() =>
        paginatedCollectionOptions<Item>({
          getKey: (item) => item.id,
          pageSize: 1.5,
          cursor: "id",
          fetchPage: async () => ({ items: [] }),
        }),
      ).toThrow(/pageSize/);
    });
  });

  describe("paginatedCollectionOptions with real collection", () => {
    it("fetches the first page during initial sync", async () => {
      const fetchCalls: Array<{ limit: number; isInitial?: boolean }> = [];
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-1",
          getKey: (item) => item.id,
          pageSize: 3,
          cursor: "id",
          fetchPage: async (params) => {
            fetchCalls.push({ limit: params.limit, isInitial: params.isInitial });
            return {
              items: [
                { id: "1", title: "a" },
                { id: "2", title: "b" },
                { id: "3", title: "c" },
              ],
              hasNextPage: true,
              totalCount: 5,
            };
          },
        }),
      );

      await waitFor(() => collection.size === 3);
      expect(collection.size).toBe(3);
      expect(fetchCalls).toEqual([{ limit: 3, isInitial: true }]);
      const state = collection.utils.getState();
      expect(state.hasNextPage).toBe(true);
      expect(state.totalCount).toBe(5);
      expect(state.loadedCount).toBe(3);
    });

    it("loadNextPage fetches the next page using the cursor", async () => {
      const calls: Array<{ after?: string | number; before?: string | number; limit: number }> = [];
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-2",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async (params) => {
            calls.push({ after: params.after, before: params.before, limit: params.limit });
            if (params.after === "2") {
              return {
                items: [
                  { id: "3", title: "c" },
                  { id: "4", title: "d" },
                ],
                hasNextPage: false,
              };
            }
            return {
              items: [
                { id: "1", title: "a" },
                { id: "2", title: "b" },
              ],
              hasNextPage: true,
            };
          },
        }),
      );

      await waitFor(() => collection.size === 2);
      const loadNext = collection.utils.loadNextPage;
      expect(loadNext).toBeDefined();
      await loadNext!();
      await waitFor(() => collection.size === 4);
      expect(calls).toEqual([{ limit: 2 }, { after: "2", limit: 2 }]);
      expect(collection.utils.getState().hasNextPage).toBe(false);
    });

    it("deduplicates items across pages by getKey", async () => {
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-3",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async (params) => {
            if (params.after === "2") {
              return {
                items: [
                  { id: "2", title: "duplicate" },
                  { id: "3", title: "c" },
                ],
                hasNextPage: false,
              };
            }
            return {
              items: [
                { id: "1", title: "a" },
                { id: "2", title: "b" },
              ],
              hasNextPage: true,
            };
          },
        }),
      );

      await waitFor(() => collection.size === 2);
      await collection.utils.loadNextPage();
      await waitFor(() => collection.size === 3);
      expect(collection.size).toBe(3);
      const items = collection.toArray as unknown as Array<Item>;
      const item2 = items.find((i) => i.id === "2");
      expect(item2?.title).toBe("b");
    });

    it("loadPreviousPage works for bidirectional pagination", async () => {
      const calls: Array<{ after?: string | number; before?: string | number; limit: number }> = [];
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-4",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          direction: "both",
          fetchPage: async (params) => {
            calls.push({ after: params.after, before: params.before, limit: params.limit });
            if (params.before === "3") {
              return {
                items: [
                  { id: "1", title: "a" },
                  { id: "2", title: "b" },
                ],
                hasPreviousPage: false,
              };
            }
            return {
              items: [
                { id: "3", title: "c" },
                { id: "4", title: "d" },
              ],
              hasNextPage: true,
              hasPreviousPage: true,
            };
          },
        }),
      );

      await waitFor(() => collection.size === 2);
      const loadPrevious = collection.utils.loadPreviousPage;
      expect(loadPrevious).toBeDefined();
      await loadPrevious!();
      await waitFor(() => collection.size === 4);
      expect(calls[1]).toEqual({ before: "3", limit: 2 });
      expect(collection.utils.getState().hasPreviousPage).toBe(false);
    });

    it("loadPreviousPage is undefined for forward-only direction", async () => {
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-5",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async () => ({
            items: [{ id: "1", title: "a" }],
            hasNextPage: true,
          }),
        }),
      );

      await waitFor(() => collection.size === 1);
      expect(collection.utils.loadPreviousPage).toBeUndefined();
    });

    it("refetchFirstPage clears and re-fetches the first page", async () => {
      let callCount = 0;
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-6",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                items: [
                  { id: "1", title: "a" },
                  { id: "2", title: "b" },
                ],
                hasNextPage: true,
              };
            }
            return {
              items: [
                { id: "x", title: "fresh" },
                { id: "y", title: "data" },
              ],
              hasNextPage: false,
            };
          },
        }),
      );

      await waitFor(() => collection.size === 2);
      expect(callCount).toBe(1);
      await collection.utils.refetchFirstPage!();
      await waitFor(() => collection.size === 2 && callCount === 2);
      const items = collection.toArray as unknown as Array<Item>;
      expect(items.map((i) => i.id).sort()).toEqual(["x", "y"]);
      expect(collection.utils.getState().hasNextPage).toBe(false);
      expect(collection.utils.getState().loadedCount).toBe(2);
    });

    it("captures fetch errors in state.error", async () => {
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-7",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async () => {
            throw new Error("network down");
          },
        }),
      );

      await waitFor(() => collection.utils.getState().error !== undefined);
      expect(collection.utils.getState().error).toBeInstanceOf(Error);
      expect((collection.utils.getState().error as Error).message).toBe("network down");
    });

    it("loadNextPage is a no-op when no more pages", async () => {
      const collection = createCollection(
        paginatedCollectionOptions<Item>({
          id: "page-test-8",
          getKey: (item) => item.id,
          pageSize: 2,
          cursor: "id",
          fetchPage: async () => ({
            items: [{ id: "1", title: "a" }],
            hasNextPage: false,
          }),
        }),
      );

      await waitFor(() => collection.size === 1);
      expect(collection.utils.getState().hasNextPage).toBe(false);
      const loadNext = collection.utils.loadNextPage;
      expect(loadNext).toBeDefined();
      await loadNext!();
      expect(collection.size).toBe(1);
    });
  });
});
