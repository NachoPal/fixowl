import { describe, expect, it } from "vitest";
import { isCodexFamilyModel, type CatalogModel } from "./agent-catalog.ts";
import {
  getModelListSource,
  liveModelCheck,
  livePickerModels,
  OPENAI_MODELS_URL,
  parseOpenAiModels,
  type ModelListProbe,
  type ModelListSource,
} from "./model-list.ts";

describe("parseOpenAiModels", () => {
  it("extracts data[].id verbatim", () => {
    const ids = parseOpenAiModels({
      object: "list",
      data: [
        { id: "gpt-5-codex", object: "model" },
        { id: "gpt-5.1-codex", object: "model" },
      ],
    });
    expect(ids).toEqual(["gpt-5-codex", "gpt-5.1-codex"]);
  });

  it("skips entries lacking a non-empty string id", () => {
    const ids = parseOpenAiModels({
      data: [{ id: "gpt-5-codex" }, { id: "" }, { id: 42 }, {}, null, "x"],
    });
    expect(ids).toEqual(["gpt-5-codex"]);
  });

  it("returns undefined for a shape without a data array", () => {
    expect(parseOpenAiModels(null)).toBeUndefined();
    expect(parseOpenAiModels("nope")).toBeUndefined();
    expect(parseOpenAiModels({})).toBeUndefined();
    expect(parseOpenAiModels({ data: "not-an-array" })).toBeUndefined();
  });

  it("distinguishes an empty served list from an unparseable shape", () => {
    expect(parseOpenAiModels({ data: [] })).toEqual([]);
  });
});

function probe(
  env: Record<string, string | undefined>,
  fetchJson: ModelListProbe["fetchJson"],
): ModelListProbe {
  return { env, fetchJson };
}

describe("openai (codex) model list source", () => {
  it("queries /v1/models with the bearer token and returns the served ids", async () => {
    const source = getModelListSource("codex");
    expect(source).toBeDefined();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const result = await source?.list(
      probe({ OPENAI_API_KEY: "sk-test" }, async (url, headers) => {
        calls.push({ url, headers });
        return { data: [{ id: "gpt-5-codex" }, { id: "gpt-5.1-codex" }] };
      }),
    );
    expect(calls[0]?.url).toBe(OPENAI_MODELS_URL);
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-test");
    expect(result?.ids).toEqual(["gpt-5-codex", "gpt-5.1-codex"]);
    expect(result?.skippedReason).toBeUndefined();
  });

  it("skips (ids undefined) with a reason when no key is present, never fetching", async () => {
    const source = getModelListSource("codex");
    let called = false;
    const result = await source?.list(
      probe({}, async () => {
        called = true;
        return {};
      }),
    );
    expect(called).toBe(false);
    expect(result?.ids).toBeUndefined();
    expect(result?.skippedReason).toContain("OPENAI_API_KEY");
  });

  it("skips (ids undefined) when the fetch rejects (fail-open, transport error)", async () => {
    const source = getModelListSource("codex");
    const result = await source?.list(
      probe({ OPENAI_API_KEY: "sk-test" }, async () => {
        throw new Error("HTTP 401");
      }),
    );
    expect(result?.ids).toBeUndefined();
    expect(result?.skippedReason).toContain("HTTP 401");
  });

  it("skips (ids undefined) when the response shape is unexpected", async () => {
    const source = getModelListSource("codex");
    const result = await source?.list(
      probe({ OPENAI_API_KEY: "sk-test" }, async () => ({ unexpected: true })),
    );
    expect(result?.ids).toBeUndefined();
    expect(result?.skippedReason).toContain("unexpected shape");
  });
});

describe("isCodexFamilyModel", () => {
  it("accepts codex-family ids and rejects the rest of the OpenAI catalog", () => {
    for (const id of ["gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-max", "codex-mini-latest"]) {
      expect(isCodexFamilyModel(id)).toBe(true);
    }
    for (const id of [
      "gpt-4o",
      "gpt-4.1-mini",
      "text-embedding-3-small",
      "whisper-1",
      "tts-1",
      "dall-e-3",
      "o3-mini",
    ]) {
      expect(isCodexFamilyModel(id)).toBe(false);
    }
  });
});

describe("livePickerModels", () => {
  const source = getModelListSource("codex");
  if (source === undefined) throw new Error("codex source must exist");

  const catalog: readonly CatalogModel[] = [
    { id: "gpt-5-codex", description: "Codex-optimized GPT-5; a good default." },
    { id: "gpt-5.1-codex", description: "Newer codex model." },
  ];

  it("offers only codex-family ids from the whole OpenAI list, in served order", () => {
    const models = livePickerModels(
      source,
      { ids: ["gpt-4o", "gpt-5.1-codex", "text-embedding-3-small", "gpt-5-codex", "whisper-1"] },
      catalog,
    );
    expect(models?.map((model) => model.id)).toEqual(["gpt-5.1-codex", "gpt-5-codex"]);
  });

  it("reuses the catalog description for a known id and a generic hint for a new one", () => {
    const models = livePickerModels(source, { ids: ["gpt-5-codex", "gpt-5.2-codex-max"] }, catalog);
    const byId = new Map(models?.map((model) => [model.id, model.description]));
    expect(byId.get("gpt-5-codex")).toBe("Codex-optimized GPT-5; a good default.");
    expect(byId.get("gpt-5.2-codex-max")).toContain("not in fixowl's built-in catalog");
    expect(byId.get("gpt-5.2-codex-max")).toContain("OpenAI /v1/models");
  });

  it("dedupes repeated served ids", () => {
    const models = livePickerModels(
      source,
      { ids: ["gpt-5-codex", "gpt-5-codex", "gpt-5.1-codex"] },
      catalog,
    );
    expect(models?.map((model) => model.id)).toEqual(["gpt-5-codex", "gpt-5.1-codex"]);
  });

  it("returns undefined (fall back to catalog) when the list is unreachable", () => {
    expect(
      livePickerModels(source, { ids: undefined, skippedReason: "offline" }, catalog),
    ).toBeUndefined();
  });

  it("returns undefined when the list contains no codex-family id", () => {
    expect(
      livePickerModels(source, { ids: ["gpt-4o", "text-embedding-3-small"] }, catalog),
    ).toBeUndefined();
  });

  it("keeps the whole list when the source has no family filter", () => {
    const noFilter: ModelListSource = { label: "x", tokenEnv: "X", list: source.list };
    const models = livePickerModels(noFilter, { ids: ["a", "b"] }, catalog);
    expect(models?.map((model) => model.id)).toEqual(["a", "b"]);
  });
});

describe("getModelListSource (agent-aware)", () => {
  it("gives agents with no queryable provider list no source", () => {
    for (const name of ["claude", "script", "unknown-agent"]) {
      expect(getModelListSource(name)).toBeUndefined();
    }
  });
});

describe("liveModelCheck", () => {
  const source = getModelListSource("codex");
  if (source === undefined) throw new Error("codex source must exist");

  it("confirms (info) when every chosen model is in the fetched list", () => {
    const outcome = liveModelCheck(source, { ids: ["gpt-5-codex", "gpt-5.1-codex"] }, [
      "gpt-5-codex",
    ]);
    expect(outcome.errors).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.info).toHaveLength(1);
    expect(outcome.info[0]).toContain("gpt-5-codex");
  });

  it("fails (error) for a model provably absent from the fetched list", () => {
    const outcome = liveModelCheck(source, { ids: ["gpt-5-codex"] }, ["gpt-5-bogus"]);
    expect(outcome.info).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain("OPENAI_API_KEY");
    expect(outcome.errors[0]).toContain("gpt-5-bogus");
  });

  it("reports one error per absent model and none for the present ones", () => {
    const outcome = liveModelCheck(source, { ids: ["gpt-5-codex"] }, [
      "gpt-5-codex",
      "gpt-5-bogus",
      "gpt-5-also-bogus",
    ]);
    expect(outcome.errors).toHaveLength(2);
  });

  it("warns and defers to the catalog when the list is unreachable (ids undefined)", () => {
    const outcome = liveModelCheck(
      source,
      { ids: undefined, skippedReason: "could not reach OpenAI /v1/models (HTTP 503)" },
      ["gpt-5-codex"],
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.info).toEqual([]);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("HTTP 503");
    expect(outcome.warnings[0]).toContain("built-in catalog");
  });

  it("returns nothing when no model was chosen", () => {
    const outcome = liveModelCheck(source, { ids: ["gpt-5-codex"] }, []);
    expect(outcome).toEqual({ errors: [], warnings: [], info: [] });
  });
});
