export default [
  { name: "full", props: { state: "full" } },
  { name: "full, a row open, a row's presses, the older fold", props: { state: "full", peek: { job: "cosmic", verbs: "task:k1", folds: true } } },
  { name: "sofar", props: { state: "sofar" } },
  { name: "back", props: { state: "back", peek: { folds: true } } },
  { name: "clear", props: { state: "clear" } },
  { name: "off", props: { state: "off" } },
  { name: "lifeos", props: { state: "lifeos" } },
  { name: "LifeOS did not answer the box", props: { state: "lifeos-silent" } },
  { name: "Not signed in to LifeOS on the box", props: { state: "lifeos-signed-out" } },
  { name: "Neither computer can read LifeOS", props: { state: "lifeos-two" } },
  { name: "failed", props: { state: "failed" } },
  { name: "loading", props: { state: "loading" } },
];
