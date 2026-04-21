import { runLifecycle } from './_lifecycle.js';

export default async function stop(argv) {
  await runLifecycle('stop', argv);
}
