import { runLifecycle } from './_lifecycle.js';

export default async function restart(argv) {
  await runLifecycle('restart', argv);
}
