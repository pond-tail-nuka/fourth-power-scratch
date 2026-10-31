#### child issue: status.mjs --json 出力本体
spec §2.1 spec §4.3 spec §5
accept: A21-A
```acceptBlock
{"accept":[{"id":"A21-A","kind":"test","cmd":"node --test ci/accept/a21-a.test.mjs"}],"scope":["scripts/status.mjs"],"refs":["spec §2.1","spec §4.3","spec §5"]}
```

#### child issue: status.mjs --json stale banner
spec §2.6 spec §6
accept: A21-B
```acceptBlock
{"accept":[{"id":"A21-B","kind":"test","cmd":"node --test ci/accept/a21-b.test.mjs"}],"scope":["scripts/status.mjs"],"refs":["spec §2.6","spec §6"]}
```
