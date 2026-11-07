import { z } from "zod";
import type { WorkspaceContext } from "./hosted.js";

export interface GithubRepository {
  id: string;
  fullName: string;
  private: boolean;
}
export interface RepositoryCatalog {
  connected: boolean;
  repositories: GithubRepository[];
}
export interface RepositorySource {
  list(context: WorkspaceContext): Promise<RepositoryCatalog>;
}

/** Supply Cloud's existing Nango client and a trusted workspace integration lookup.
 * Never take connection IDs, installation IDs or provider keys from browser input. */
export class NangoGithubRepositories implements RepositorySource {
  private readonly options: {
    binding(context: WorkspaceContext): Promise<{
      connectionId: string;
      providerConfigKey: string;
    } | null>;
    nango: {
      get(input: {
        endpoint: string;
        connectionId: string;
        providerConfigKey: string;
        params: Record<string, string>;
      }): Promise<{ data: unknown }>;
    };
  };
  constructor(options: NangoGithubRepositories["options"]) {
    this.options = options;
  }

  async list(context: WorkspaceContext): Promise<RepositoryCatalog> {
    const binding = await this.options.binding(context);
    if (!binding) return { connected: false, repositories: [] };
    const repositories = new Map<string, GithubRepository>();
    for (let page = 1; page <= 100; page++) {
      // This endpoint enumerates only the repositories granted to the GitHub App.
      const response = await this.options.nango.get({
        ...binding,
        endpoint: "/installation/repositories",
        params: { per_page: "100", page: String(page) },
      });
      const data = z
        .object({
          total_count: z.number().int().nonnegative(),
          repositories: z.array(
            z.object({
              id: z.number().int().positive().safe(),
              full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
              private: z.boolean(),
              archived: z.boolean().optional(),
              disabled: z.boolean().optional(),
            }),
          ),
        })
        .parse(response.data);
      if (!data.repositories.length && data.total_count > (page - 1) * 100)
        throw new Error("github_catalog_incomplete");
      for (const repo of data.repositories) {
        if (!repo.archived && !repo.disabled)
          repositories.set(String(repo.id), {
            id: String(repo.id),
            fullName: repo.full_name,
            private: repo.private,
          });
      }
      if (page * 100 >= data.total_count)
        return {
          connected: true,
          repositories: [...repositories.values()].sort((a, b) =>
            a.fullName.localeCompare(b.fullName),
          ),
        };
    }
    // Never authorize from an incomplete catalog.
    throw new Error("github_catalog_limit");
  }
}
