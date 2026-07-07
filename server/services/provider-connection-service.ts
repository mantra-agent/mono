import { createLogger } from "../log";

const log = createLogger("ProviderConnectionService");

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.app/graphql/v2";
const GITHUB_API_ENDPOINT = "https://api.github.com";
const CLOUDFLARE_API_ENDPOINT = "https://api.cloudflare.com/client/v4";

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  projects?: Array<{ id: string; name: string }>;
}

/**
 * Test a Railway API token by querying the authenticated user and project list.
 * Railway scopes projects under workspaces, so we first resolve workspaces
 * from `me.workspaces`, then list projects for each.
 */
export async function testRailwayToken(token: string): Promise<ProviderTestResult> {
  try {
    // Step 1: authenticate and get workspaces
    const meRes = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: `{ me { name email workspaces { id name } } }` }),
    });
    if (!meRes.ok) {
      return { ok: false, message: `Railway API returned HTTP ${meRes.status}` };
    }
    const meBody = await meRes.json() as Record<string, unknown>;
    if (meBody.errors) {
      const errors = meBody.errors as Array<{ message: string }>;
      return { ok: false, message: errors.map(e => e.message).join("; ") };
    }
    const data = meBody.data as Record<string, unknown> | undefined;
    if (!data?.me) return { ok: false, message: "No user data in Railway response" };
    const me = data.me as { name?: string; email?: string; workspaces?: Array<{ id: string; name: string }> };
    const workspaces = me.workspaces ?? [];

    // Step 2: list projects across all workspaces
    const allProjects: Array<{ id: string; name: string }> = [];
    for (const ws of workspaces) {
      try {
        const projRes = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            query: `query($wsId: String!) { projects(first: 50, workspaceId: $wsId) { edges { node { id name } } } }`,
            variables: { wsId: ws.id },
          }),
        });
        if (projRes.ok) {
          const projBody = await projRes.json() as Record<string, unknown>;
          const projData = projBody.data as Record<string, unknown> | undefined;
          const edges = (projData?.projects as { edges?: Array<{ node: { id: string; name: string } }> })?.edges ?? [];
          allProjects.push(...edges.map(e => ({ id: e.node.id, name: e.node.name })));
        }
      } catch {
        log.warn(`Failed to list projects for workspace ${ws.id}`);
      }
    }

    const identity = me.name || me.email || "unknown";
    return { ok: true, message: `Authenticated as ${identity}. ${allProjects.length} project(s) accessible.`, projects: allProjects };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Test a GitHub personal access token by querying the authenticated user and recent repos.
 */
export async function testGitHubToken(token: string): Promise<ProviderTestResult> {
  try {
    const res = await fetch(`${GITHUB_API_ENDPOINT}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { ok: false, message: `GitHub API returned HTTP ${res.status}` };
    }
    const user = await res.json() as Record<string, unknown>;
    const login = user.login as string;

    const reposRes = await fetch(`${GITHUB_API_ENDPOINT}/user/repos?per_page=10&sort=updated`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    let repos: Array<{ id: string; name: string }> = [];
    if (reposRes.ok) {
      const repoData = await reposRes.json() as Array<{ id: number; full_name: string }>;
      repos = repoData.map(r => ({ id: String(r.id), name: r.full_name }));
    }

    return { ok: true, message: `Authenticated as ${login}. ${repos.length} recent repo(s).`, projects: repos };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Test a Cloudflare API token by verifying it and listing accounts + Pages projects.
 * Uses /user/tokens/verify then /accounts, then /accounts/:id/pages/projects.
 */
// ---------------------------------------------------------------------------
// Cloudflare Pages deployment status
// ---------------------------------------------------------------------------

export interface CloudflareDeployment {
  id: string;
  status: string;
  environment: string;
  commitHash: string | null;
  commitMessage: string | null;
  branch: string | null;
  url: string | null;
  createdAt: string | null;
}

/**
 * Fetch the latest production deployment for a Cloudflare Pages project.
 * Uses GET /accounts/{accountId}/pages/projects/{projectName}/deployments?per_page=1&env=production
 */
export async function getCloudflareLatestDeployment(
  token: string,
  accountId: string,
  projectName: string,
  environment: string = "production",
): Promise<CloudflareDeployment | null> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const url = `${CLOUDFLARE_API_ENDPOINT}/accounts/${accountId}/pages/projects/${projectName}/deployments?per_page=1&env=${environment}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Cloudflare Pages API returned HTTP ${res.status}`);
  }

  const body = await res.json() as {
    success?: boolean;
    errors?: Array<{ message: string }>;
    result?: Array<{
      id: string;
      environment: string;
      url: string;
      created_on: string;
      latest_stage?: { name: string; status: string };
      deployment_trigger?: { metadata?: { commit_hash: string; commit_message: string; branch: string } };
    }>;
  };

  if (!body.success) {
    const msgs = (body.errors ?? []).map(e => e.message).join("; ");
    throw new Error(msgs || "Cloudflare Pages deployment query failed");
  }

  const deployment = body.result?.[0];
  if (!deployment) return null;

  const stage = deployment.latest_stage;
  const trigger = deployment.deployment_trigger?.metadata;

  return {
    id: deployment.id,
    status: stage ? `${stage.name}:${stage.status}` : "unknown",
    environment: deployment.environment || environment,
    commitHash: trigger?.commit_hash ?? null,
    commitMessage: trigger?.commit_message ?? null,
    branch: trigger?.branch ?? null,
    url: deployment.url || null,
    createdAt: deployment.created_on || null,
  };
}

export async function testCloudflareToken(token: string): Promise<ProviderTestResult> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // Step 1: verify token
    const verifyRes = await fetch(`${CLOUDFLARE_API_ENDPOINT}/user/tokens/verify`, { headers });
    if (!verifyRes.ok) {
      return { ok: false, message: `Cloudflare API returned HTTP ${verifyRes.status}` };
    }
    const verifyBody = await verifyRes.json() as { success?: boolean; errors?: Array<{ message: string }>; result?: { status: string } };
    if (!verifyBody.success) {
      const msgs = (verifyBody.errors ?? []).map(e => e.message).join("; ");
      return { ok: false, message: msgs || "Token verification failed" };
    }
    if (verifyBody.result?.status !== "active") {
      return { ok: false, message: `Token status: ${verifyBody.result?.status ?? "unknown"}` };
    }

    // Step 2: list accounts
    const accountsRes = await fetch(`${CLOUDFLARE_API_ENDPOINT}/accounts?per_page=20`, { headers });
    let accounts: Array<{ id: string; name: string }> = [];
    if (accountsRes.ok) {
      const accountsBody = await accountsRes.json() as { result?: Array<{ id: string; name: string }> };
      accounts = accountsBody.result ?? [];
    }

    // Step 3: list Pages projects across accounts
    const allProjects: Array<{ id: string; name: string }> = [];
    for (const account of accounts) {
      try {
        const pagesRes = await fetch(`${CLOUDFLARE_API_ENDPOINT}/accounts/${account.id}/pages/projects?per_page=25`, { headers });
        if (pagesRes.ok) {
          const pagesBody = await pagesRes.json() as { result?: Array<{ name: string; subdomain: string }> };
          for (const project of pagesBody.result ?? []) {
            allProjects.push({ id: project.name, name: `${project.name} (${project.subdomain}.pages.dev)` });
          }
        }
      } catch {
        log.warn(`Failed to list Pages projects for Cloudflare account ${account.id}`);
      }
    }

    const accountNames = accounts.map(a => a.name).join(", ") || "unknown";
    return {
      ok: true,
      message: `Verified. ${accounts.length} account(s): ${accountNames}. ${allProjects.length} Pages project(s).`,
      projects: allProjects,
    };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
