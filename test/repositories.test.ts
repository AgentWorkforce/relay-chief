import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NangoGithubRepositories } from "../src/repositories.js";

const context = { organizationId: "org-1", workspaceId: "workspace-1" };
test("Nango GitHub discovery uses trusted workspace binding, paginates and strips provider fields", async () => {
  const calls: unknown[] = [];
  const source = new NangoGithubRepositories({
    binding: async (scope) =>
      scope.organizationId === context.organizationId &&
      scope.workspaceId === context.workspaceId
        ? { connectionId: "workspace-app", providerConfigKey: "github-relay" }
        : null,
    nango: {
      get: async (input) => {
        calls.push(input);
        return {
          data: {
            total_count: 101,
            repositories:
              input.params.page === "1"
                ? Array.from({ length: 100 }, (_, i) => ({
                    id: i + 1,
                    full_name: `acme/repo-${i}`,
                    private: true,
                    archived: i === 0,
                    disabled: i === 1,
                    temp_clone_token: "must-never-be-returned",
                  }))
                : [{ id: 101, full_name: "acme/final-repo", private: false }],
          },
        };
      },
    },
  });
  const result = await source.list(context);
  assert.equal(result.repositories.length, 99);
  assert.ok(result.repositories.some((repo) => repo.id === "101"));
  assert.ok(!JSON.stringify(result).includes("must-never-be-returned"));
  assert.deepEqual(calls[0], {
    connectionId: "workspace-app",
    providerConfigKey: "github-relay",
    endpoint: "/installation/repositories",
    params: { per_page: "100", page: "1" },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(await source.list({ ...context, workspaceId: "other" }), {
    connected: false,
    repositories: [],
  });
  assert.equal(calls.length, 2);
});

test("empty App grants are distinct from disconnection; provider failures never authorize a partial catalog", async () => {
  let fail = false;
  const source = new NangoGithubRepositories({
    binding: async () => ({
      connectionId: "app",
      providerConfigKey: "github-relay",
    }),
    nango: {
      get: async () => {
        if (fail) throw new Error("provider-unavailable");
        return { data: { total_count: 0, repositories: [] } };
      },
    },
  });
  assert.deepEqual(await source.list(context), {
    connected: true,
    repositories: [],
  });
  fail = true;
  await assert.rejects(source.list(context));
});
