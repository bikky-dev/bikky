/**
 * Per-destination Qdrant client cache.
 *
 * Multi-destination bikky may talk to several Qdrant Cloud accounts (or
 * collections) in parallel. We keep one `QdrantClient` per destination keyed
 * by `destination.name`, lazily constructed on first use.
 *
 * The cache also tracks per-destination `collectionReady` so the daemon can
 * keep retrying `ensureCollection` for destinations whose collection failed
 * to materialize at startup, without blocking other destinations.
 */
import type { Destination, QdrantClientConfig } from "../config.js";
import { QdrantClient, type QdrantLogFn } from "./qdrant-client.js";

export interface PoolOptions {
  client: QdrantClientConfig;
  log?: QdrantLogFn;
}

interface Entry {
  destination: Destination;
  client: QdrantClient;
  collectionReady: boolean;
  lastError: string | null;
}

export class QdrantPool {
  private readonly entries = new Map<string, Entry>();
  private readonly options: PoolOptions;

  constructor(destinations: ReadonlyArray<Destination>, options: PoolOptions) {
    this.options = options;
    for (const destination of destinations) {
      this.upsertEntry(destination);
    }
  }

  /** Returns the names of all destinations in the pool, in registration order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** All Destination objects currently registered. */
  destinations(): Destination[] {
    return [...this.entries.values()].map((e) => e.destination);
  }

  /** Get the QdrantClient for a destination by name. Throws if unknown. */
  client(name: string): QdrantClient {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Destination '${name}' is not in the pool. Known: ${this.names().join(", ") || "(none)"}`);
    }
    return entry.client;
  }

  /** Get the collection name for a destination. */
  collection(name: string): string {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Destination '${name}' is not in the pool.`);
    return entry.destination.collection;
  }

  /** Whether the destination's collection has been confirmed ready. */
  isCollectionReady(name: string): boolean {
    return this.entries.get(name)?.collectionReady === true;
  }

  /** Last error observed for a destination, or null. */
  lastError(name: string): string | null {
    return this.entries.get(name)?.lastError ?? null;
  }

  /**
   * Run `ensureCollection` for a single destination. Updates the pool's
   * readiness flag and last-error state. Re-throws on failure so the caller
   * can decide whether to retry, log, or skip.
   */
  async ensureCollection(
    name: string,
    vectorSize: number,
    indexes: Array<{ field_name: string; field_schema: string }>,
  ): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Destination '${name}' is not in the pool.`);
    try {
      await entry.client.ensureCollection(vectorSize, indexes);
      entry.collectionReady = true;
      entry.lastError = null;
    } catch (e) {
      entry.collectionReady = false;
      entry.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /**
   * Run a callback against every destination's client, in parallel. Errors
   * from one destination do not prevent others from running. Returns the per-
   * destination result (or error) so callers can act on the outcome.
   */
  async fanOut<T>(
    fn: (destination: Destination, client: QdrantClient) => Promise<T>,
  ): Promise<Array<{ destination: Destination; result: T | null; error: Error | null }>> {
    const promises = [...this.entries.values()].map(async (entry) => {
      try {
        const result = await fn(entry.destination, entry.client);
        return { destination: entry.destination, result, error: null as Error | null };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return { destination: entry.destination, result: null as T | null, error: err };
      }
    });
    return Promise.all(promises);
  }

  /** Replace the entire pool with a new destination set. Existing clients are dropped. */
  rebuild(destinations: ReadonlyArray<Destination>): void {
    this.entries.clear();
    for (const destination of destinations) this.upsertEntry(destination);
  }

  private upsertEntry(destination: Destination): void {
    const client = new QdrantClient({
      url: destination.qdrant_url,
      apiKey: destination.qdrant_api_key,
      collection: destination.collection,
      timeoutMs: this.options.client.timeout_ms,
      retries: this.options.client.retries,
      retryBaseDelayMs: this.options.client.retry_base_delay_ms,
      log: this.options.log,
    });
    this.entries.set(destination.name, {
      destination,
      client,
      collectionReady: false,
      lastError: null,
    });
  }
}
