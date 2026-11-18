# github-core-clone-01 — a GitHub-compatible forge in one Node process

A standalone git forge that speaks GitHub's surfaces from its own in-memory store, built for
[the contest](https://make.fun/bounty/github-core-clone-01): git smart HTTP (clone/push over
protocol v0 and v2, including shallow fetch), the REST v3 resources, GraphQL v4, and an MCP
endpoint — Node 22, standard library only, no installs, no `git` binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Kept as the starter ships it.
- `app.ts`: routing and the bearer-token gate shared by every surface.
- `wire.ts`: the seeded scenario's user stream (the token owner's identity is derived, not hardcoded).
- `store.ts`: all forge state — repositories, refs, issues, pull requests, labels — stamped by a
  logical clock instead of the wall clock, so state is a pure function of the requests served.
- `gitobj.ts`: the git object model — SHA-1 objects, packfile read/write with delta resolution,
  ancestry, tree flatten/rebuild.
- `gitproto.ts`: smart HTTP — advertisements, upload-pack (ls-refs, fetch, shallow/deepen),
  receive-pack with report-status and fast-forward enforcement.
- `rest.ts`: REST v3 — repos, contents, refs, branches, commits, labels, issues, comments, pull
  requests, file diffs and merges with file-level conflict detection.
- `graphql.ts`: a small GraphQL parser/executor — the `gh` documents, Relay global ids, cursor
  connections, `__type` introspection, batched operations.
- `mcp.ts`: the MCP endpoint in both eras (`server/discover` and the legacy `initialize`
  handshake) with a static tools list over the same store.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
