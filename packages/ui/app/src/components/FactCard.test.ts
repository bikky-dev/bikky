import { describe, expect, it } from "vitest";
import {
  memoryLastOperationLabel,
  memoryLastOperationUserName,
  memoryOriginAgentLabel,
  memoryOriginLabel,
  memoryUserName,
  type Fact,
} from "./FactCard";

const baseFact: Fact = {
  id: "fact-1",
  content: "Remember this",
  category: "engineering",
  entities: [],
  confidence: 0.9,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("FactCard provenance labels", () => {
  it("uses origin user.name as the visible memory user", () => {
    const fact: Fact = {
      ...baseFact,
      origin: {
        user: { name: "Saber", id: "git-saber", type: "user" },
        agent: { name: "Bikky daemon", id: "daemon:local", type: "daemon" },
        interface: "daemon",
        operation: { action: "create", subsystem: "extraction" },
      },
    };

    expect(memoryUserName(fact)).toBe("Saber");
    expect(memoryOriginAgentLabel(fact)).toBe("Bikky daemon");
    expect(memoryOriginLabel(fact)).toBe("daemon/extraction/create");
  });

  it("falls back to legacy metadata actor labels and last-operation labels", () => {
    const fact: Fact = {
      ...baseFact,
      metadata: { actor_label: "Legacy Actor" },
      last_operation_origin: {
        user: { name: "Updater", id: "user:updater", type: "user" },
        agent: { name: "Bikky UI", id: "ui:local", type: "ui" },
        interface: "ui",
        operation: { action: "update", route: "PUT /api/memory/facts/:id" },
      },
    };

    expect(memoryUserName(fact)).toBe("Legacy Actor");
    expect(memoryLastOperationUserName(fact)).toBe("Updater");
    expect(memoryLastOperationLabel(fact)).toBe("ui/update");
  });
});
