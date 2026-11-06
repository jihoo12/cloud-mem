import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE, getAccessToken } from "./helpers";

const URL_MCP = `${BASE}/mcp`;

let token: string;
let client: Client;

async function connect(headers: Record<string, string> = {}) {
  const connected = new Client({ name: "test", version: "1.0.0" });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(URL_MCP), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
      fetch: (input, init) => exports.default.fetch(new Request(input, init)),
    }),
  );
  return connected;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: "text"; text: string }[];
  return { isError: result.isError ?? false, text: first!.text };
}

async function callJson<T = any>(name: string, args: Record<string, unknown>) {
  const { isError, text } = await call(name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as T;
}

const save = (args: Record<string, unknown>) =>
  callJson<{ id: number }>("memory_save", {
    kind: "memory",
    title: "untitled",
    content: "empty",
    ...args,
  });

const searchIds = async (args: Record<string, unknown>) =>
  (await callJson<{ id: number }[]>("memory_search", args)).map((r) => r.id);

beforeAll(async () => {
  token = await getAccessToken();
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM entries");
  client = await connect();
});

afterEach(async () => {
  await client.close();
});

describe("tools", () => {
  it("lists the tools and sends instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_delete",
      "memory_get",
      "memory_save",
      "memory_search",
      "memory_update",
    ]);
    expect(client.getInstructions()).toContain("Never store secrets");
  });

  it("round-trips an entry and records the device", async () => {
    const remote = await connect({ "X-Device": "laptop" });
    const result = await remote.callTool({
      name: "memory_save",
      arguments: {
        kind: "worklog",
        title: "제목",
        content: "본문",
        project: "cloud-mem",
        tags: ["a", "b"],
      },
    });
    await remote.close();
    const { id } = JSON.parse((result.content as any)[0].text);

    expect(await callJson("memory_get", { id })).toMatchObject({
      id,
      kind: "worklog",
      title: "제목",
      content: "본문",
      project: "cloud-mem",
      tags: ["a", "b"],
      device: "laptop",
    });
  });

  it("rejects invalid input", async () => {
    const { isError } = await call("memory_save", {
      kind: "nonsense",
      title: "t",
      content: "c",
    });
    expect(isError).toBe(true);
  });

  it("reports unknown ids as errors", async () => {
    expect((await call("memory_get", { id: 999 })).isError).toBe(true);
    expect((await call("memory_update", { id: 999, title: "x" })).isError).toBe(true);
    expect((await call("memory_delete", { id: 999 })).isError).toBe(true);
  });

  it("updates only the given fields and clears project with null", async () => {
    const { id } = await save({ title: "old", project: "p", tags: ["t"] });
    await callJson("memory_update", { id, title: "new", project: null });
    expect(await callJson("memory_get", { id })).toMatchObject({
      title: "new",
      project: null,
      tags: ["t"],
      content: "empty",
    });
  });
});

describe("search", () => {
  it("finds Korean words with particles attached", async () => {
    const { id } = await save({ content: "장기기억 메모리를 클라우드에 올렸다" });
    await save({ content: "unrelated" });
    expect(await searchIds({ query: "메모리" })).toEqual([id]);
  });

  it("finds two-character terms below the trigram minimum", async () => {
    const { id } = await save({ content: "오늘 작업을 마쳤다" });
    await save({ content: "휴식" });
    expect(await searchIds({ query: "작업" })).toEqual([id]);
  });

  it("requires all terms to match, across both search strategies", async () => {
    const both = await save({ content: "데이터베이스 작업 기록" });
    await save({ content: "데이터베이스 설계" });
    await save({ content: "작업 일지" });
    expect(await searchIds({ query: "데이터베이스 작업" })).toEqual([both.id]);
  });

  it("matches case-insensitively in title and tags", async () => {
    const byTitle = await save({ title: "Cloudflare notes" });
    const byTag = await save({ tags: ["cloudflare"] });
    expect((await searchIds({ query: "CLOUDFLARE" })).sort()).toEqual(
      [byTitle.id, byTag.id].sort(),
    );
  });

  it("treats query syntax as literal text", async () => {
    const quoted = await save({ content: 'he said "hello world" AND left' });
    const percent = await save({ content: "완료율 5% 달성" });
    const underscore = await save({ content: "zero here 55 a_b" });

    expect(await searchIds({ query: '"hello' })).toEqual([quoted.id]);
    expect(await searchIds({ query: "5%" })).toEqual([percent.id]);
    expect(await searchIds({ query: "%" })).toEqual([percent.id]);
    expect(await searchIds({ query: "_" })).toEqual([underscore.id]);
    // FTS5 operators are plain words, not syntax.
    expect(await searchIds({ query: "AND" })).toEqual([quoted.id]);
    expect(await searchIds({ query: "NOT" })).toEqual([]);
    expect(await searchIds({ query: "title:x*" })).toEqual([]);
  });

  it("combines filters", async () => {
    const match = await save({ kind: "worklog", project: "a", tags: ["x"], content: "공통 내용" });
    await save({ kind: "memory", project: "a", tags: ["x"], content: "공통 내용" });
    await save({ kind: "worklog", project: "b", tags: ["x"], content: "공통 내용" });
    await save({ kind: "worklog", project: "a", tags: ["xy"], content: "공통 내용" });

    expect(
      await searchIds({ query: "공통", kind: "worklog", project: "a", tag: "x" }),
    ).toEqual([match.id]);
  });

  it("lists most recently updated first without a query, with paging", async () => {
    const first = await save({ title: "1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await save({ title: "2" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await callJson("memory_update", { id: first.id, title: "1b" });

    expect(await searchIds({})).toEqual([first.id, second.id]);
    expect(await searchIds({ limit: 1 })).toEqual([first.id]);
    expect(await searchIds({ limit: 1, offset: 1 })).toEqual([second.id]);
  });

  it("filters by since, including times with an offset", async () => {
    const { id } = await save({});
    expect(await searchIds({ since: "2000-01-01" })).toEqual([id]);
    expect(await searchIds({ since: "2999-01-01" })).toEqual([]);
    expect(await searchIds({ since: "2999-01-01T09:00:00+09:00" })).toEqual([]);
    expect((await call("memory_search", { since: "yesterday" })).isError).toBe(true);
  });

  it("reindexes on update and removes on delete", async () => {
    const { id } = await save({ content: "원래내용입니다" });
    await callJson("memory_update", { id, content: "바뀐내용입니다" });
    expect(await searchIds({ query: "원래내용" })).toEqual([]);
    expect(await searchIds({ query: "바뀐내용" })).toEqual([id]);

    await callJson("memory_delete", { id });
    expect(await searchIds({ query: "바뀐내용" })).toEqual([]);
  });

  it("returns a preview around the match instead of the full content", async () => {
    const padding = "가나다라마바사 ".repeat(2000);
    await save({ content: `${padding}찾을문장입니다 ${padding}` });

    const [hit] = await callJson<{ preview: string; content?: string }[]>(
      "memory_search",
      { query: "찾을문장" },
    );
    expect(hit!.content).toBeUndefined();
    expect(hit!.preview).toContain("찾을문장");
    expect(hit!.preview.length).toBeLessThan(1000);

    const [recent] = await callJson<{ preview: string }[]>("memory_search", {});
    expect(recent!.preview.length).toBeLessThanOrEqual(301);
  });
});
