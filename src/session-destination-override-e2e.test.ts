import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-session-destination-e2e-"));

const stringEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

interface TextContent {
  type: "text";
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTextContent = (value: unknown): value is TextContent =>
  isRecord(value) && value.type === "text" && typeof value.text === "string";

const writeConfig = (): void => {
  fs.mkdirSync(testHome, { recursive: true });
  fs.writeFileSync(path.join(testHome, "config.json"), JSON.stringify({
    qdrant_url: null,
    qdrant_api_key: null,
    collection: "bikky",
    destinations: [
      {
        name: "perso",
        qdrant_url: "http://127.0.0.1:9",
        qdrant_api_key: "",
        collection: "perso_collection",
        match: { entity: ["[Bb]ikky"], content: ["[Bb]ikky"] },
      },
      {
        name: "work",
        qdrant_url: "http://127.0.0.1:9",
        qdrant_api_key: "",
        collection: "work_collection",
        default: true,
      },
    ],
    qdrant_client: {
      timeout_ms: 25,
      retries: 0,
      retry_base_delay_ms: 1,
    },
    embedding: {
      provider: "ollama",
      model: "qwen-test",
      dimensions: 3,
      base_url: "http://127.0.0.1:9",
      api_key: null,
      timeout_ms: 25,
      retries: 0,
      retry_base_delay_ms: 1,
    },
  }, null, 2) + "\n", "utf-8");
};

const parseToolJson = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> => {
  const content = isRecord(result) ? result.content : null;
  assert.ok(Array.isArray(content), "expected tool result content array");
  const text = content.find(isTextContent);
  assert.ok(text, "expected text tool result");
  return JSON.parse(text.text) as Record<string, unknown>;
};

describe("session destination override MCP e2e", () => {
  before(() => {
    writeConfig();
  });

  after(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it("sets, reads, and clears the override through the real MCP stdio server", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp"],
      cwd: path.dirname(path.dirname(cliPath)),
      env: {
        ...stringEnv(),
        BIKKY_HOME: testHome,
        CI: "1",
        FORCE_COLOR: "0",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    const client = new Client({ name: "bikky-session-destination-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = new Set(tools.tools.map((tool) => tool.name));
      assert.equal(toolNames.has("memory_set_session_destination"), true);
      assert.equal(toolNames.has("memory_get_session_destination"), true);
      assert.equal(toolNames.has("memory_clear_session_destination"), true);

      const setBody = parseToolJson(await client.callTool({
        name: "memory_set_session_destination",
        arguments: { destination: "work" },
      }));
      assert.equal(setBody.status, "session_destination_set");
      assert.equal((setBody.session_destination_override as Record<string, unknown>).destination, "work");

      const getBody = parseToolJson(await client.callTool({
        name: "memory_get_session_destination",
        arguments: {},
      }));
      assert.equal(getBody.status, "session_destination_active");
      assert.equal((getBody.session_destination_override as Record<string, unknown>).active, true);
      assert.equal(fs.existsSync(path.join(testHome, "state", "session-destination-override.json")), true);

      const clearBody = parseToolJson(await client.callTool({
        name: "memory_clear_session_destination",
        arguments: {},
      }));
      assert.equal(clearBody.status, "session_destination_cleared");
      assert.equal((clearBody.session_destination_override as Record<string, unknown>).active, false);
      assert.equal(fs.existsSync(path.join(testHome, "state", "session-destination-override.json")), false);
    } catch (e) {
      assert.fail(`${e instanceof Error ? e.message : String(e)}\nMCP stderr:\n${stderr}`);
    } finally {
      await client.close();
    }
  });
});
