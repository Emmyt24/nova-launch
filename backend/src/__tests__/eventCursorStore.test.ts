import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { EventCursorStore, parseLedgerFromCursor } from "../services/eventCursorStore";

const CURSOR_KEY = "stellar_event_cursor";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgresql://nova_user:nova_password@localhost:5432/nova_launch?schema=public";

describe("EventCursorStore — real Postgres", () => {
  let prisma: PrismaClient;
  let store: EventCursorStore;

  beforeEach(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: { url: TEST_DB_URL },
      },
    });
    store = new EventCursorStore(prisma);
    await prisma.integrationState.deleteMany({ where: { key: CURSOR_KEY } });
  });

  afterEach(async () => {
    try {
      await prisma.integrationState.deleteMany({ where: { key: CURSOR_KEY } });
    } catch {
      // ignore cleanup errors
    }
    await prisma.$disconnect();
  });

  describe("write-then-read round trip", () => {
    it("persists and reloads the same cursor value", async () => {
      const cursor = "1234567-42";

      await store.save(cursor);
      const loaded = await store.load();

      expect(loaded).toBe(cursor);
    });

    it("returns null when no row exists", async () => {
      const loaded = await store.load();
      expect(loaded).toBeNull();
    });

    it("overwrites an existing cursor with a newer value", async () => {
      await store.save("1000-1");
      await store.save("2000-1");

      const loaded = await store.load();
      expect(loaded).toBe("2000-1");
    });
  });

  describe("missing-row bootstrap", () => {
    it("returns the STELLAR_CURSOR_ORIGIN env value when no row exists", async () => {
      const origin = "5000-0";
      process.env.STELLAR_CURSOR_ORIGIN = origin;

      try {
        const loaded = await store.load();
        expect(loaded).toBe(origin);
      } finally {
        delete process.env.STELLAR_CURSOR_ORIGIN;
      }
    });

    it("returns null when no row exists and no env fallback is set", async () => {
      delete process.env.STELLAR_CURSOR_ORIGIN;
      const loaded = await store.load();
      expect(loaded).toBeNull();
    });

    it("save after load-null creates the row", async () => {
      expect(await store.load()).toBeNull();

      await store.save("3000-1");

      expect(await store.load()).toBe("3000-1");
    });
  });

  describe("corrupted cursor value recovery", () => {
    it("getCursorLag returns null for a malformed cursor", async () => {
      await prisma.integrationState.create({
        data: { key: CURSOR_KEY, value: "not-a-valid-cursor" },
      });

      const lag = await store.getCursorLag(6000);
      expect(lag).toBeNull();
    });

    it("getCursorLag returns null when the cursor row is missing", async () => {
      const lag = await store.getCursorLag(6000);
      expect(lag).toBeNull();
    });

    it("overwrites a corrupted cursor with a valid one", async () => {
      await prisma.integrationState.create({
        data: { key: CURSOR_KEY, value: "garbage-data" },
      });

      expect(await store.load()).toBe("garbage-data");

      await store.save("7000-1");

      expect(await store.load()).toBe("7000-1");
      expect(await store.getCursorLag(7005)).toBe(5);
    });
  });

  describe("concurrent writer race", () => {
    it("no lost update when two writers advance the same cursor", async () => {
      await store.save("0-0");

      const writes = [
        store.save("100-1"),
        store.save("200-1"),
      ];

      await Promise.all(writes);

      const finalCursor = await store.load();
      expect(finalCursor).toBeOneOf(["100-1", "200-1"]);

      const row = await prisma.integrationState.findUnique({
        where: { key: CURSOR_KEY },
      });
      expect(row).not.toBeNull();
      expect(row!.value).toBe(finalCursor);
    });

    it("no lost update under rapid sequential saves", async () => {
      await store.save("0-0");

      const cursors = [
        "10-1",
        "20-1",
        "30-1",
        "40-1",
        "50-1",
      ];

      await Promise.all(cursors.map((c) => store.save(c)));

      const finalCursor = await store.load();
      expect(cursors).toContain(finalCursor);

      const row = await prisma.integrationState.findUnique({
        where: { key: CURSOR_KEY },
      });
      expect(row).not.toBeNull();
      expect(row!.value).toBe(finalCursor);
    });
  });
});
