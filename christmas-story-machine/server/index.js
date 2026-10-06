import { config } from './config.js';
import { createApp } from './app.js';
import { resumeAll } from './queue.js';
import { builtInMusic } from './music.js';
import { flush } from './store.js';

builtInMusic(); // synthesize the default soundtrack once
const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`🎄 Christmas Eve Story Machine on http://localhost:${config.port}`);
  console.log(`   Claude captions & planning: ${config.aiEnabled ? `on (${config.anthropicModel})` : 'off — set ANTHROPIC_API_KEY to enable (templates are used meanwhile)'}`);
  console.log(`   Data directory: ${config.dataDir}`);
  resumeAll();
});
server.requestTimeout = 10 * 60_000; // slow uploads over busy home Wi-Fi

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await flush();
    process.exit(0);
  });
}
