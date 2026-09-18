# Contract compatibility baseline

These canonical bundles are the explicit Phase 1 compatibility baseline from
`master` commit `e8dd84c4f96468de6e15e7452c6c1de8b3528966` (the merge of issue #8).

| Surface | SHA-256 |
| --- | --- |
| `public-v1.json` | `623116c76c4df5fa9d42c76da5bcee19a172be6adbac607b200b03334dcccf19` |
| `owner-v1.json` | `a95c6beb36f6ad69d83ada9bd78fc6b147e8cb7432fa3a422247edbd4167b759` |

`npm run contract:compatibility` compares the current canonical bundles with
these snapshots. Updating a snapshot is a reviewed compatibility decision, not
part of routine generation. Breaking request, response, security, or status
semantics require a new major route.
