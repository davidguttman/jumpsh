import { runLifecycle } from './_lifecycle.js';

export default async function start(argv) {
  await runLifecycle('start', argv);
}
