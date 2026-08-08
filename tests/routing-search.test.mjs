// Stage-one routing: does counting words pick the right context?
//
// The interesting assertions here are not "the function returns a number" but
// the properties the design leans on — a rare identifier beats a common word,
// a hand-written alias beats an incidental filename, and a question phrased in
// the user's words still finds a context described in someone else's.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIELD_WEIGHTS,
  buildIndex,
  rank,
  tokenize
} from "../plugins/claude-code/neatcontext/src/core/routing-search.mjs";

// A small corpus shaped like a real one: several contexts about the same
// project, one incident, one unrelated domain.
const CORPUS = [
  {
    id: "incident",
    fields: {
      name: "INC-1001 checkout-api pool exhaustion",
      description: "checkout-api 5xx caused by billing-postgres pgbouncer pool exhaustion",
      entities: "INC-1001 checkout-api billing-postgres pgbouncer dep-9001",
      questions: "why was checkout throwing 5xx last week? did we fix the database timeout?",
      aliases: "the checkout outage",
      files: "runbook.md timeline.md"
    }
  },
  {
    id: "codex-plugin",
    fields: {
      name: "codex-neatcontext-design",
      description: "NeatContext Codex CLI plugin design, marketplace packaging, MCP bridge",
      entities: "codex marketplace mcp-bridge",
      questions: "how do I package the codex plugin?",
      files: "design.md"
    }
  },
  {
    id: "kimi-plugin",
    fields: {
      name: "kimi-neatcontext-plugin",
      description: "NeatContext support for Kimi Code: manifests, skills, commands, MCP bridge",
      entities: "kimi mcp-bridge",
      questions: "how do I install the kimi plugin?",
      files: "design.md"
    }
  },
  {
    id: "refunds",
    fields: {
      name: "workspace scoped",
      description: "refunds and chargebacks",
      aliases: "the billing thing",
      files: "policy.md"
    }
  }
];

const index = buildIndex(CORPUS);
const best = (query) => rank(index, query)[0];

describe("tokenize", () => {
  it("keeps a compound identifier whole and also splits it", () => {
    // Both are needed: the whole run is what makes the token rare, the parts
    // are what let someone who typed it with a space still match.
    const tokens = tokenize("INC-1001");
    assert.deepEqual(tokens, ["inc-1001", "inc", "1001"]);
  });

  it("leaves a plain word alone", () => {
    assert.deepEqual(tokenize("pgbouncer"), ["pgbouncer"]);
  });

  it("splits on every separator a name might use", () => {
    assert.ok(tokenize("default_pool_size").includes("pool"));
    assert.ok(tokenize("mcp-bridge.mjs").includes("bridge"));
    assert.ok(tokenize("src/core/routing.mjs").includes("routing"));
  });

  it("drops stopwords and single letters", () => {
    assert.deepEqual(tokenize("why is it a problem"), ["problem"]);
  });

  it("lowercases so the query need not match the writing", () => {
    assert.deepEqual(tokenize("PgBouncer"), tokenize("pgbouncer"));
  });

  it("splits CJK into characters and adjacent pairs", () => {
    // No spaces to split on, so pairs stand in for words.
    assert.deepEqual(tokenize("结算"), ["结", "结算", "算"]);
  });

  it("handles a single CJK character, which is a whole word", () => {
    assert.deepEqual(tokenize("账"), ["账"]);
  });

  it("returns nothing for empty or non-string input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(undefined), []);
    assert.deepEqual(tokenize(null), []);
  });
});

describe("rank", () => {
  it("finds the incident from words the description never uses", () => {
    // The card says "pool exhaustion"; the user says "throwing 5xx". This is
    // the recall failure the stored questions exist to fix.
    assert.equal(best("why was checkout throwing 5xx last week?").id, "incident");
  });

  it("routes on a bare ticket id", () => {
    assert.equal(best("INC-1001").id, "incident");
  });

  it("routes on a ticket id typed with a space instead of a dash", () => {
    assert.equal(best("what happened with INC 1001").id, "incident");
  });

  it("separates two contexts about the same project", () => {
    // Both mention MCP bridges and NeatContext plugins; only the rare product
    // name tells them apart.
    assert.equal(best("how do I package the codex plugin").id, "codex-plugin");
    assert.equal(best("installing the kimi plugin").id, "kimi-plugin");
  });

  it("matches an alias the user wrote by hand", () => {
    assert.equal(best("the billing thing").id, "refunds");
  });

  it("prefers a rare word over a common one", () => {
    // "plugin" is in two contexts, "pgbouncer" in one. The rare word decides.
    const results = rank(index, "pgbouncer plugin");
    assert.equal(results[0].id, "incident");
  });

  it("reports which query terms matched, so a route can be explained", () => {
    const [top] = rank(index, "pgbouncer exhaustion");
    assert.deepEqual([...top.matched].sort(), ["exhaustion", "pgbouncer"]);
  });

  it("scores a context that matches in two fields above one that matches in one", () => {
    const results = rank(index, "mcp-bridge design");
    assert.ok(results[0].score > results[1].score);
  });

  it("returns nothing when no context shares a word with the question", () => {
    assert.deepEqual(rank(index, "quarterly revenue forecast"), []);
  });

  it("returns nothing for a question that is entirely stopwords", () => {
    assert.deepEqual(rank(index, "why is it that they were"), []);
  });

  it("honours the limit", () => {
    // "mcp-bridge" and "design" reach both plugin contexts.
    assert.equal(rank(index, "plugin design bridge", { limit: 1 }).length, 1);
    assert.ok(rank(index, "plugin design bridge").length > 1);
  });

  it("orders by score, breaking ties by id so results are stable", () => {
    // Two contexts holding the same word in the same field: nothing but the id
    // can separate them, and the order must not fall out of corpus order.
    const tied = buildIndex([
      { id: "zulu", fields: { name: "settlement" } },
      { id: "alpha", fields: { name: "settlement" } }
    ]);
    const results = rank(tied, "settlement");
    assert.deepEqual(
      results.map((result) => result.id),
      ["alpha", "zulu"]
    );
    assert.equal(results[0].score, results[1].score);
  });

  it("gives every candidate a finite positive score", () => {
    for (const result of rank(index, "checkout plugin refunds")) {
      assert.ok(Number.isFinite(result.score));
      assert.ok(result.score > 0);
    }
  });
});

describe("field weights", () => {
  it("weighs a hand-written alias above an incidental filename", () => {
    assert.ok(FIELD_WEIGHTS.aliases > FIELD_WEIGHTS.files);
  });

  it("scores the same word higher in an alias than in a filename", () => {
    const weighted = buildIndex([
      { id: "by-alias", fields: { aliases: "settlement" } },
      { id: "by-filename", fields: { files: "settlement" } }
    ]);
    const results = rank(weighted, "settlement");
    assert.equal(results[0].id, "by-alias");
    assert.ok(results[0].score > results[1].score);
  });

  it("scores an unrecognised field rather than ignoring it", () => {
    // A caller that adds a field should get a working search, not a silent zero.
    const extended = buildIndex([{ id: "only", fields: { notes: "pgbouncer" } }]);
    assert.equal(rank(extended, "pgbouncer")[0].id, "only");
  });
});

describe("buildIndex", () => {
  it("handles an empty corpus", () => {
    const empty = buildIndex([]);
    assert.equal(empty.size, 0);
    assert.deepEqual(rank(empty, "anything"), []);
  });

  it("handles an entry with no fields at all", () => {
    // A context with no routing material is unroutable, not a crash.
    const sparse = buildIndex([{ id: "bare" }, { id: "described", fields: { name: "payments" } }]);
    assert.equal(sparse.size, 2);
    assert.deepEqual(
      rank(sparse, "payments").map((result) => result.id),
      ["described"]
    );
  });

  it("does not let a long field drown out a short one", () => {
    // Length normalisation: one mention in a short field should beat one
    // mention buried in a long one.
    const lengths = buildIndex([
      { id: "short", fields: { description: "pgbouncer" } },
      {
        id: "long",
        fields: {
          description: `pgbouncer ${"unrelated words about other systems ".repeat(20)}`
        }
      }
    ]);
    const results = rank(lengths, "pgbouncer");
    assert.equal(results[0].id, "short");
  });
});
