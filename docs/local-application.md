# Run the integrated application locally

The customer setup UI lives in `AgentWorkforce/relay-app`. Its workspace-scoped
routes are served by `AgentWorkforce/relaycontrol` using the existing device login,
HttpOnly session cookie, role checks and CSRF protection. `relay-chief` supplies the
setup service and coordinator runtime.

The local provider is an explicit development composition, excluded from the npm
package. It runs isolated HTTP Jev/Relay/evidence adapters and a separate execution
worker that fixes a deliberately broken addition function in its own state
directory. The worker runs real tests; the verifier independently reruns them.
It never edits a customer repository or makes a cloud/model call.

## Services

Install dependencies in all three repos with `npm ci --ignore-scripts`. Use Node
24+. Create a private, durable state parent directory before starting the backend.
From the `relaycontrol` checkout, set:

```sh
PORT=8787
DEV_PGLITE_DIR=/absolute/private/state/control-db
DEV_CHIEF_MODULE=/absolute/path/to/relay-chief/scripts/local-bridge.ts
DEV_CHIEF_DATA_DIR=/absolute/private/state/runtime
SELFHOST_PUBLIC_URL=https://your-authenticated-preview-origin
SELFHOST_DASHBOARD_URL=http://127.0.0.1:5173/dashboard/
```

Start `node --import tsx scripts/dev-server.ts` with those variables. In a Replicas
workspace, use `replicas service start` as required by the workspace instructions.
The script uses its existing development tenant and normal browser device login;
there is no auto-login or authentication bypass. Logs contain tenant identifiers,
not bootstrap credentials.

From `relay-app`, start `npm run dev` with
`DASHBOARD_API_ORIGIN=http://127.0.0.1:8787`. For a preview, set
`DASHBOARD_PREVIEW_HOST` to that preview's exact host. The Vite configuration proxies
only the existing `/cloud/api` and `/login` route prefixes. It is not a generic
upstream proxy. Browser requests remain same-origin.

Ports:

| Port | Service |
| --- | --- |
| 5173 | Dashboard and fixed API/login forwarding |
| 8787 | Real relaycontrol application with persistent PGlite |
| 8811 | Loopback-only integration provider and isolated worker communication |

Port 3737 remains reserved for the Replicas engine and is never used by this stack.

## Browser acceptance

1. Open `/dashboard/#/chief` and complete the existing device approval login for
   the synthetic development owner.
2. Choose **Set up a chief**, select one or more GitHub repositories, set
   operating policy/budget/capacity, and review before creating. The project name
   is derived from the selection. Search preserves selections outside its filter.
   This local provider uses an explicitly labeled GitHub App fixture.
3. Observe persisted setup progress and local readiness. The page explicitly
   labels the local validation environment and does not claim EC2 was created.
4. Choose **Scan sessions**. Two fixture sessions describe the same objective.
   The ledger records one assignment and one duplicate decision.
5. Observe the separate worker's Relay reports and independently verified result.
   Reserved budget and measured provider spend are displayed separately; absent
   billing data is not displayed as a measured zero.
6. Scan again and restart relaycontrol. The same chief, task, completion and
   cursors remain; there is no second execution or dispatch.

The setup registry is currently a single-process, local SQLite adapter. Hosted
deployment must supply an approved managed provisioning provider and a shared
control-plane registry. Without a local runtime factory, setup remains
`awaiting_approval` and cannot dispatch. See [rollout readiness](readiness.md).


## GitHub App repository selection

`GET /cloud/api/v1/workspaces/:workspaceId/chiefs/repositories` returns only
`{connected, repositories: [{id, fullName, private}]}` through the same workspace
session and membership checks as the other chief routes. Setup accepts
`repositoryIds` (1–100) rather than browser-supplied names, tenant identity or
connection identifiers. It reloads the catalog before admitting a new request.
Every repository is claimed in one transaction, by immutable GitHub ID and by
canonical name; a conflicting selection cannot leave partial claims. Previously
saved single-repository projects remain readable after the migration.

The dashboard starts authorization via the existing workspace
`integrations/connect-session` contract with `allowedIntegrations: ["github"]`.
It opens the server-issued `connectLink`, retains selections while searching,
and refreshes on browser focus or an explicit refresh. Empty grants, disconnected
connections, changed access and provider errors block an empty/inaccessible scope.
No GitHub tokens or Nango API keys enter the browser chief setup request.

For hosted wiring, instantiate `NangoGithubRepositories` with the existing
server-owned Nango client's `get` method and a `binding(context)` lookup of the
workspace's **GitHub App installation connection**. The lookup must verify the
organization/workspace relationship and return only its connectionId and
providerConfigKey; never accept either from the setup body. Inject this as
`repositories` into `ProjectCoordinators`. It enumerates
`/installation/repositories` through Nango, paginates, omits archived/disabled
repositories and strips all upstream fields except ID, name and visibility.
See [Nango proxy](https://nango.dev/docs/reference/backend/backend-sdk/node) and
[GitHub installation repositories](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).

The included local bridge injects a fake Nango client and App binding. It does
not connect the self-host OAuth store to Nango or create a live GitHub App
installation. Hosted startup must provide its existing trusted integration
lookup and Nango client; live connect, callback and revoked-grant behavior remain
a rollout qualification gate. Missing repository discovery fails closed.
