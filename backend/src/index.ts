import { buildApi } from './api.js';
import { loadConfig } from './config.js';
import { createPool, migrate, waitForDatabase } from './db.js';
import { createLogger } from './logger.js';
import { QueueStore } from './store.js';
import { Worker } from './worker.js';

const mode = process.argv[2];
if (mode !== 'api' && mode !== 'worker') {
  console.error('Usage: queueforge <api|worker>');
  process.exit(2);
}

const config = loadConfig();
const logger = createLogger(config.logLevel, { service: mode });
const pool = createPool(config.databaseUrl, config.databasePoolSize);

await waitForDatabase(pool);
await migrate(pool);
const store = new QueueStore(pool);

if (mode === 'api') {
  const app = await buildApi(store, config, logger);
  const close = async (signal: string) => {
    logger.info('api_stopping', { signal });
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.once('SIGINT', () => void close('SIGINT'));
  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info('api_started', { host: config.apiHost, port: config.apiPort });
} else {
  const worker = new Worker(store, config, logger);
  const close = async (signal: string) => {
    logger.info('shutdown_signal', { signal });
    await worker.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.once('SIGINT', () => void close('SIGINT'));
  await worker.run();
  await pool.end();
}
