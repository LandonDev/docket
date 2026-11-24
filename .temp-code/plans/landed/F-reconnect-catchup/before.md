# Remote transcript catch-up before the fix

Linux box with Xvfb, Electron production build and a separate Node host.
Both runs used the clean `out/bundle-map.json` stamp from master
`c6109794ba6f7b33f68e37c7394c47fce104fa2d`. The host used the same product
server code through the soak. It seeded 20,880 rows and 5,958,670 bytes of
event JSON per thread. The window opened six panes through its usual load
path and restored them from the same user data on reload.

From the reproduction worktree:

```sh
export PATH=/srv/agents/home/.bun/bin:$PATH
/srv/agents/work/temp-code/.temp-code/bin/heavy ./node_modules/.bin/electron-vite build
/srv/agents/work/temp-code/.temp-code/bin/heavy bun scripts/measure-renderer-soak.ts --scene reconnect --label reconnect-before-1 --port 19471
reconnect_done=$(mktemp /tmp/tc-reconnect-master-build-XXXXXX.done)
TEMP_CODE_SOAK_BUILD_DONE="$reconnect_done" /srv/agents/work/temp-code/.temp-code/bin/heavy bun scripts/measure-renderer-soak.ts --scene reconnect --gate --label reconnect-before-2 --port 19471
```

The second run used `--gate` with the soak's build-done marker pointed at
the same completed master build. Report mode collects the same measures
and exits successfully when a limit fails. The gate mode exits 1.

## Summary lines

```json
{"scene":"reconnect","label":"reconnect-before-1","build":{"sha":"c6109794ba6f7b33f68e37c7394c47fce104fa2d","clean":true},"loadedRows":[576,575,502,464,464,464],"cut":{"phase":"cut","elapsedMs":27559,"connectMs":7559,"connections":1,"refusedUpgrades":2,"remote":true,"bytes":{"events":2152280,"pushes":1189627,"other":14434},"socketBytes":108273,"maxUnsentBytes":2089262,"answers":{"events":6,"queue":6,"resets":2,"gaps":4,"tails":0},"longTasks":{"count":164,"maxMs":132,"sumMs":11628,"over100":18},"rows":{"expected":481,"observed":481,"exact":true},"loaded":6,"streaming":true},"relaunch":{"phase":"relaunch","elapsedMs":20000,"connectMs":455,"connections":1,"refusedUpgrades":0,"remote":true,"bytes":{"events":5895099,"pushes":1191217,"other":15431},"socketBytes":208967,"maxUnsentBytes":3908325,"answers":{"events":12,"queue":12,"resets":0,"gaps":6,"tails":6},"longTasks":{"count":161,"maxMs":189,"sumMs":13101,"over100":29},"rows":{"expected":36,"observed":36,"exact":true},"loaded":6,"streaming":true},"ok":false}
{"scene":"reconnect","label":"reconnect-before-2","build":{"sha":"c6109794ba6f7b33f68e37c7394c47fce104fa2d","clean":true},"loadedRows":[578,578,505,464,464,464],"cut":{"phase":"cut","elapsedMs":27186,"connectMs":7186,"connections":1,"refusedUpgrades":2,"remote":true,"bytes":{"events":2156721,"pushes":1195395,"other":14434},"socketBytes":108581,"maxUnsentBytes":2096182,"answers":{"events":6,"queue":6,"resets":2,"gaps":4,"tails":0},"longTasks":{"count":162,"maxMs":166,"sumMs":12171,"over100":27},"rows":{"expected":475,"observed":475,"exact":true},"loaded":6,"streaming":true},"relaunch":{"phase":"relaunch","elapsedMs":20000,"connectMs":329,"connections":1,"refusedUpgrades":0,"remote":true,"bytes":{"events":5876207,"pushes":1184900,"other":15386},"socketBytes":207941,"maxUnsentBytes":3765049,"answers":{"events":12,"queue":12,"resets":0,"gaps":6,"tails":6},"longTasks":{"count":102,"maxMs":123,"sumMs":6755,"over100":4},"rows":{"expected":27,"observed":27,"exact":true},"loaded":6,"streaming":true},"ok":false}
```

## What the runs showed

| Run | Window | Longest task | Tasks over 100 ms | Peak unsent bytes | Exact rows |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Cut | 132 ms | 18 | 2,089,262 | 481 of 481 |
| 1 | Relaunch | 189 ms | 29 | 3,908,325 | 36 of 36 |
| 2 | Cut | 166 ms | 27 | 2,096,182 | 475 of 475 |
| 2 | Relaunch | 123 ms | 4 | 3,765,049 | 27 of 27 |

Each cut produced six `session.events` and six `queue.list` answers.
The two fast streams each added about 200 rows during the cut and got a
reset tail. The slow stream added 73 and got its gap. Each relaunch
produced six cold tails and six later event answers. Both windows accepted
one new remote socket per run. All six panes loaded and the focused turn
kept folding new assistant blocks.

The cut crossed 100 ms in the first two seconds after reconnect in both
runs. The full windows include the cost of continued streaming, and most
long tasks landed after those first two seconds. Relaunch crossed the
2 MiB buffer limit in both runs. The Linux scene peaked at 189 ms and
3.73 MiB unsent, below the roughly two-second stalls and 8 MiB queue
reported from the Mac.

The full task timings and thread cursors are in
`/tmp/tc-soak/reconnect-before-1.json` and
`/tmp/tc-soak/reconnect-before-2.json` on the box.
