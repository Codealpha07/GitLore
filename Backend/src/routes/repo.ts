import { Hono } from "hono";
import { z } from "zod";
import { getDB } from "../lib/mongo";
import { getUserToken, getCurrentUser } from "../middleware/auth";
import {
  createGithubClient,
  getRepositoryInfo,
  getRepositoryStats,
} from "../lib/github";
import {
  getRepoAnalytics,
  getPatternDistribution,
} from "../lib/mongoAdvanced";
import {
  enrichRepositoryOverview,
  aggregatePatternCounts,
  aggregateRepoPatternInsights,
  listRepoPathsLimited,
  getRepoFileContent,
  listAuthenticatedUserRepos,
  searchRepositoriesRest,
  fetchGithubUserRest,
  listPullRequestsRest,
  getPullRequestDiffRest,
  listPullRequestReviewCommentsRest,
  listPullRequestFilesRest,
  getPullRequestRest,
  fetchRepositoryMetadataRest,
  searchRepoCountRest,
  countCommitsApproxRest,
  GithubRestError,
  githubRestJson,
  githubRestJsonMethod,
} from "../lib/githubRest";
import { getOrScanRepoPatterns } from "../lib/patternScanner";

export const repoRouter = new Hono();

/**
 * GET /api/repo/analytics?repo=owner/name
 * Mongo aggregation: line-analyze cache stats + explanation pattern distribution.
 */
repoRouter.get("/repo/analytics", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const repo = c.req.query("repo")?.trim();
    if (!repo) {
      return c.json({ error: "repo query param required" }, 400);
    }

    const [analytics, patterns] = await Promise.all([
      getRepoAnalytics(repo),
      getPatternDistribution(repo),
    ]);

    return c.json({ analytics, patterns });
  } catch (error) {
    console.error("repo/analytics error:", error);
    return c.json(
      {
        error: "Failed to load repo analytics",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/user/github-profile — followers, repos, etc. for the signed-in user.
 */
repoRouter.get("/user/github-profile", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const profile = await fetchGithubUserRest(user.access_token);
    return c.json({
      login: profile.login,
      name: profile.name,
      avatar_url: profile.avatar_url,
      public_repos: profile.public_repos,
      followers: profile.followers,
      following: profile.following,
      total_private_repos: profile.total_private_repos,
    });
  } catch (error) {
    console.error("github-profile error:", error);
    return c.json(
      {
        error: "Failed to load GitHub profile",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/user/github-rate-limit — REST + GraphQL remaining quota for the signed-in OAuth token.
 * Use this to confirm GitHub throttling (vs Gemini, Mongo, or invalid GraphQL).
 *
 * Security: Covered by `app.use("/api/*", authMiddleware)` — no session ⇒ 401 before this runs.
 * The GitHub access token is only used server-side in the upstream request; never returned in JSON.
 */
repoRouter.get("/user/github-rate-limit", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${user.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return c.json(
        {
          error: "Invalid JSON from GitHub rate_limit",
          status: res.status,
          ...(process.env.NODE_ENV === "development" ? { raw: text.slice(0, 200) } : {}),
        },
        502
      );
    }
    if (!res.ok) {
      return c.json(
        {
          error: "GitHub rate_limit request failed",
          status: res.status,
          ...(process.env.NODE_ENV === "development" ? { body } : {}),
        },
        502
      );
    }
    const resources = body.resources as Record<string, { limit: number; remaining: number; reset: number; used?: number }> | undefined;
    const summary = resources
      ? Object.fromEntries(
          Object.entries(resources).map(([k, v]) => [
            k,
            {
              limit: v.limit,
              remaining: v.remaining,
              reset: v.reset,
              resetISO: new Date(v.reset * 1000).toISOString(),
            },
          ])
        )
      : {};
    return c.json({
      ok: true,
      resources: summary,
      hint: "If graphql or core remaining is 0, wait until resetISO. New GitHub OAuth apps do not raise this limit.",
    });
  } catch (error) {
    console.error("github-rate-limit error:", error);
    return c.json(
      {
        error: "Failed to load GitHub rate limits",
        message: process.env.NODE_ENV === "development" && error instanceof Error ? error.message : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repos/me?limit=30 — repos for the signed-in user (updated desc).
 */
repoRouter.get("/repos/me", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const limit = Math.min(parseInt(c.req.query("limit") || "30", 10) || 30, 100);
    const repositories = await listAuthenticatedUserRepos(user.access_token, limit);
    return c.json({ repositories });
  } catch (error) {
    console.error("repos/me error:", error);
    return c.json(
      {
        error: "Failed to list repositories",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repos/search?q=&per_page=20 — GitHub repository search.
 */
repoRouter.get("/repos/search", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const q = (c.req.query("q") || "").trim();
    if (!q) {
      return c.json({ repositories: [] });
    }
    const perPage = Math.min(parseInt(c.req.query("per_page") || "20", 10) || 20, 30);
    const repositories = await searchRepositoriesRest(user.access_token, q, perPage);
    return c.json({ repositories });
  } catch (error) {
    console.error("repos/search error:", error);
    return c.json(
      {
        error: "Repository search failed",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

// Schema for repo request
const repoRequestSchema = z.object({
  owner: z.string().describe("Repository owner"),
  name: z.string().describe("Repository name"),
});

type RepoRequest = z.infer<typeof repoRequestSchema>;

/**
 * GET /api/repo/:owner/:name/index?ref=&limit=400
 */
repoRouter.get("/repo/:owner/:name/index", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const ref = c.req.query("ref") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "400", 10) || 400, 2000);

    if (!owner || !name) {
      return c.json({ error: "Missing owner or repository name" }, 400);
    }

    const { paths, truncated, defaultBranch } = await listRepoPathsLimited(
      user.access_token,
      owner,
      name,
      ref,
      limit
    );

    return c.json({
      owner,
      name,
      defaultBranch,
      refUsed: ref || defaultBranch,
      paths,
      truncated,
    });
  } catch (error) {
    console.error("Repo index error:", error);
    return c.json(
      {
        error: "Failed to list repository files",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name/raw?path=&ref=
 */
repoRouter.get("/repo/:owner/:name/raw", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const path = c.req.query("path");
    const ref = c.req.query("ref") || "";

    if (!owner || !name || !path) {
      return c.json({ error: "Missing owner, repository name, or path" }, 400);
    }

    const result = await getRepoFileContent(
      user.access_token,
      owner,
      name,
      path,
      ref
    );

    if (result.isBinary || result.text === null) {
      return c.json({
        path,
        isBinary: true,
        text: null,
        message: "Binary or non-text file — open on GitHub to view.",
        size: result.size,
      });
    }

    return c.json({
      path,
      isBinary: false,
      text: result.text,
      size: result.size,
    });
  } catch (error) {
    console.error("Repo raw error:", error);
    return c.json(
      {
        error: "Failed to fetch file",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name/pulls?limit=20
 */
repoRouter.get("/repo/:owner/:name/pulls", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10) || 20, 30);
    if (!owner || !name) {
      return c.json({ error: "Missing owner or repository name" }, 400);
    }
    const raw = await listPullRequestsRest(user.access_token, owner, name, limit);
    const pulls = raw.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      updatedAt: p.updated_at,
      htmlUrl: p.html_url,
      authorLogin: p.user?.login || null,
    }));
    return c.json({ pulls });
  } catch (error) {
    console.error("repo pulls list error:", error);
    return c.json(
      {
        error: "Failed to list pull requests",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name/pulls/:number/diff-review
 */
repoRouter.get("/repo/:owner/:name/pulls/:number/diff-review", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const numStr = c.req.param("number");
    const pullNumber = parseInt(numStr, 10);
    if (!owner || !name || !Number.isFinite(pullNumber)) {
      return c.json({ error: "Invalid parameters" }, 400);
    }

    const [detail, diff, comments, files] = await Promise.all([
      getPullRequestRest(user.access_token, owner, name, pullNumber),
      getPullRequestDiffRest(user.access_token, owner, name, pullNumber),
      listPullRequestReviewCommentsRest(user.access_token, owner, name, pullNumber),
      listPullRequestFilesRest(user.access_token, owner, name, pullNumber),
    ]);

    return c.json({
      number: detail.number,
      title: detail.title,
      state: detail.state,
      authorLogin: detail.user?.login || null,
      updatedAt: detail.updated_at,
      htmlUrl: detail.html_url,
      head: { ref: detail.head.ref, sha: detail.head.sha },
      base: { ref: detail.base.ref, sha: detail.base.sha },
      files: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      diff,
      comments: comments.map((x) => {
        const raw = x as {
          line?: number | null;
          original_line?: number | null;
          start_line?: number | null;
        };
        const line =
          raw.line ??
          raw.start_line ??
          raw.original_line ??
          null;
        return {
          id: x.id,
          path: x.path,
          line,
          body: x.body,
          author: x.user?.login || "unknown",
          diff_hunk: x.diff_hunk,
        };
      }),
    });
  } catch (error) {
    console.error("diff-review error:", error);
    return c.json(
      {
        error: "Failed to load pull request diff",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name/scan-patterns?branch=&refresh=1
 * Regex scan of up to 50 text files; cached in Mongo ~1h unless refresh=1.
 */
repoRouter.get("/repo/:owner/:name/scan-patterns", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!owner || !name) {
      return c.json({ error: "Missing owner or repository name" }, 400);
    }

    const branchHint = c.req.query("branch") || "";
    const refreshRaw = (c.req.query("refresh") || "").toLowerCase();
    const forceRefresh = refreshRaw === "1" || refreshRaw === "true" || refreshRaw === "yes";

    const db = getDB();
    const data = await getOrScanRepoPatterns(db, user.access_token, owner, name, branchHint, forceRefresh);
    return c.json(data);
  } catch (error) {
    console.error("scan-patterns error:", error);
    return c.json(
      {
        error: "Failed to scan repository patterns",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * POST /api/repo/:owner/:name/setup-webhook
 * Register GitHub pull_request webhook for automatic PR intelligence (CodeRabbit-style).
 */
repoRouter.post("/repo/:owner/:name/setup-webhook", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!owner || !name) {
      return c.json({ error: "Missing owner or repository name" }, 400);
    }

    const publicBase = process.env.BACKEND_PUBLIC_URL?.trim().replace(/\/+$/, "");
    if (!publicBase) {
      return c.json({ error: "BACKEND_PUBLIC_URL not configured" }, 400);
    }

    const webhookUrl = `${publicBase}/webhooks/github`;
    const repoKey = `${owner}/${name}`.toLowerCase();
    const db = getDB();
    const coll = db.collection("webhook_registrations");
    const token = user.access_token;
    const hooksPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;

    const existing = await coll.findOne({ repo: repoKey });
    if (existing?.webhookId != null) {
      try {
        const hooks = await githubRestJson<
          Array<{ id: number; active: boolean }>
        >(token, hooksPath);
        const stillThere = hooks.some((h) => h.id === existing.webhookId && h.active);
        if (stillThere) {
          return c.json({ status: "already_registered", url: webhookUrl });
        }
      } catch {
        /* fall through to create / upsert */
      }
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim() || "";
    const hookBody = {
      name: "web",
      config: {
        url: webhookUrl,
        content_type: "json",
        secret,
        insecure_ssl: "0" as const,
      },
      events: ["pull_request"],
      active: true,
    };

    let webhookId: number | undefined;
    try {
      const created = await githubRestJsonMethod<{ id: number }>(
        token,
        "POST",
        hooksPath,
        hookBody
      );
      webhookId = created.id;
    } catch (e) {
      if (e instanceof GithubRestError && e.status === 404) {
        return c.json(
          { error: "Admin access required to register webhooks on this repository" },
          403
        );
      }
      if (e instanceof GithubRestError && e.status === 422) {
        try {
          const hooks = await githubRestJson<
            Array<{ id: number; config?: { url?: string } }>
          >(token, hooksPath);
          const match = hooks.find((h) => h.config?.url === webhookUrl);
          if (match) webhookId = match.id;
        } catch {
          /* ignore */
        }
        if (webhookId == null) {
          return c.json({ error: "Could not create webhook (validation)." }, 422);
        }
      } else {
        throw e;
      }
    }

    if (webhookId == null) {
      return c.json({ error: "Failed to create webhook" }, 500);
    }

    await coll.updateOne(
      { repo: repoKey },
      {
        $set: {
          repo: repoKey,
          owner,
          name,
          webhookId,
          webhookUrl,
          registeredBy: user._id,
          githubToken: user.access_token,
          username: user.username,
          createdAt: new Date(),
          updated_at: new Date(),
        },
        $setOnInsert: {
          created_at: new Date(),
        },
      },
      { upsert: true }
    );

    return c.json({ status: "webhook_registered", url: webhookUrl });
  } catch (error) {
    console.error("setup-webhook error:", error);
    return c.json(
      {
        error: "Failed to register webhook",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name/pattern-insights
 * Mongo-backed themes: knowledge graph types/topics, explain labels, line-analyze cache.
 */
repoRouter.get("/repo/:owner/:name/pattern-insights", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!owner || !name) {
      return c.json({ error: "Missing owner or repository name" }, 400);
    }

    const db = getDB();
    const data = await aggregateRepoPatternInsights(db, owner, name);
    return c.json(data);
  } catch (error) {
    console.error("pattern-insights error:", error);
    return c.json(
      {
        error: "Failed to load pattern insights",
        message:
          process.env.NODE_ENV === "development" && error instanceof Error
            ? error.message
            : undefined,
      },
      500
    );
  }
});

/**
 * GET /api/repo/:owner/:name
 * Get repository overview information
 */
repoRouter.get("/repo/:owner/:name", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const branchHint = c.req.query("branch") || undefined;

    if (!owner || !name) {
      return c.json(
        { error: "Missing owner or repository name" },
        400
      );
    }

    const db = getDB();
    const repoFull = `${owner}/${name}`;
    const cacheKey = `repo:${owner.toLowerCase()}:${name.toLowerCase()}:${branchHint || "__def__"}`;
    const cached = await db.collection("repo_cache").findOne({ _id: cacheKey } as any);

    if (cached && new Date() < cached.expires_at) {
      return c.json(cached.data);
    }

    const githubClient = createGithubClient(user.access_token);

    let repoInfo = await getRepositoryInfo(githubClient as any, owner, name);
    let stats = await getRepositoryStats(githubClient as any, owner, name);

    if (!repoInfo) {
      try {
        const meta = await fetchRepositoryMetadataRest(user.access_token, owner, name);
        repoInfo = {
          name: meta.name,
          description: meta.description,
          url: meta.html_url,
          isPrivate: meta.private,
          stargazerCount: meta.stargazers_count,
          forkCount: meta.forks_count,
          primaryLanguage: meta.language ? { name: meta.language } : null,
          owner: { login: meta.owner.login, type: meta.owner.type || "User" },
        };
        const [prCount, issueCount, totalCommits] = await Promise.all([
          searchRepoCountRest(user.access_token, owner, name, "pr"),
          searchRepoCountRest(user.access_token, owner, name, "issue"),
          countCommitsApproxRest(user.access_token, owner, name, meta.default_branch),
        ]);
        stats = {
          refs: {
            nodes: [
              {
                name: meta.default_branch,
                target: { history: { totalCount: totalCommits } },
              },
            ],
          },
          pullRequests: { totalCount: prCount },
          issues: { totalCount: issueCount },
        };
      } catch (restErr) {
        console.error("Overview: GraphQL missed; REST fallback failed:", restErr);
        if (restErr instanceof GithubRestError && restErr.status === 404) {
          return c.json(
            {
              error: "Repository not found",
              message: `Could not find repository ${owner}/${name}`,
            },
            404
          );
        }
        return c.json(
          {
            error: "Failed to fetch repository information",
            message:
              process.env.NODE_ENV === "development" && restErr instanceof Error
                ? restErr.message
                : undefined,
          },
          500
        );
      }
    }

    const refs = stats?.refs?.nodes || [];
    const mainRef = refs.find((r: any) => r.name === "main") || refs[0];
    const totalCommits = mainRef?.target?.history?.totalCount || 0;
    const prCount = stats?.pullRequests?.totalCount || 0;
    const issueCount = stats?.issues?.totalCount || 0;

    let enrich;
    try {
      enrich = await enrichRepositoryOverview(
        user.access_token,
        owner,
        name,
        branchHint
      );
    } catch (e) {
      console.error("enrichRepositoryOverview:", e);
      enrich = {
        defaultBranch: "main",
        fileCount: 0,
        contributorCount: 0,
        mostChangedFiles: [],
        knowledgeGraph: { nodes: [], edges: [] },
      };
    }

    const patternRows = await aggregatePatternCounts(db, owner, name);
    const topAntiPatterns = patternRows.map((p, i) => ({
      text: p.text,
      count: p.count,
      dot:
        i % 3 === 0
          ? "bg-gitlore-error"
          : i % 3 === 1
            ? "bg-gitlore-warning"
            : "bg-gitlore-success",
    }));

    const response = {
      id: repoFull,
      name: repoInfo.name,
      description: repoInfo.description,
      url: repoInfo.url,
      isPrivate: repoInfo.isPrivate,
      language: repoInfo.primaryLanguage?.name,
      defaultBranch: enrich.defaultBranch,
      owner: {
        login: repoInfo.owner.login,
        type: repoInfo.owner.type,
      },
      stats: {
        stars: repoInfo.stargazerCount,
        forks: repoInfo.forkCount,
        commits: totalCommits,
        pullRequests: prCount,
        issues: issueCount,
        files: enrich.fileCount,
        contributors: enrich.contributorCount,
      },
      healthScore: calculateHealthScore({
        stars: repoInfo.stargazerCount,
        commits: totalCommits,
        pullRequests: prCount,
        isPrivate: repoInfo.isPrivate,
      }),
      topAntiPatterns,
      mostChangedFiles: enrich.mostChangedFiles.map((f) => ({
        name: f.name,
        changes: f.changes,
        touches: f.touches,
      })),
      knowledgeGraph: enrich.knowledgeGraph,
    };

    await db.collection("repo_cache").updateOne(
      { _id: cacheKey } as any,
      {
        $set: {
          data: response,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      },
      { upsert: true }
    );

    return c.json(response);
  } catch (error) {
    console.error("Repo error:", error);

    return c.json(
      {
        error: "Failed to fetch repository information",
        message:
          process.env.NODE_ENV === "development"
            ? error instanceof Error
              ? error.message
              : "Unknown error"
            : undefined,
      },
      500
    );
  }
});

/**
 * POST /api/repo/search
 * Search for repositories (simplified)
 */
const repoSearchSchema = z.object({
  owner: z.string().describe("Repository owner"),
  name: z.string().describe("Repository name"),
});

repoRouter.post("/repo/search", async (c) => {
  try {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json();
    const { owner, name } = repoSearchSchema.parse(body);

    const githubClient = createGithubClient(user.access_token);
    let repoInfo = await getRepositoryInfo(githubClient as any, owner, name);
    let repoUrl: string;

    if (repoInfo) {
      repoUrl = repoInfo.url;
    } else {
      try {
        const meta = await fetchRepositoryMetadataRest(user.access_token, owner, name);
        repoUrl = meta.html_url;
      } catch (e) {
        if (e instanceof GithubRestError && e.status === 404) {
          return c.json({ error: "Repository not found" }, 404);
        }
        throw e;
      }
    }

    return c.json({
      found: true,
      repository: {
        owner,
        name,
        url: repoUrl,
      },
    });
  } catch (error) {
    console.error("Repo search error:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Validation error",
          details: error.errors,
        },
        400
      );
    }

    return c.json(
      {
        error: "Repository search failed",
      },
      500
    );
  }
});

/**
 * Helper: Calculate health score (simplified)
 */
function calculateHealthScore(metrics: {
  stars: number;
  commits: number;
  pullRequests: number;
  isPrivate: boolean;
}): number {
  let score = 5; // Base score

  if (metrics.stars > 1000) score += 2;
  else if (metrics.stars > 100) score += 1;

  if (metrics.commits > 500) score += 1.5;
  else if (metrics.commits > 100) score += 0.5;

  if (metrics.pullRequests > 50) score += 1;

  if (!metrics.isPrivate) score += 0.5;

  return Math.min(score, 10);
}
