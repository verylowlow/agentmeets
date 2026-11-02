import { buildApp } from './app.js';
import { DB_PATH } from './db.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = await buildApp();

await app.listen({ port: PORT, host: HOST });
app.log.info(`AgentMeets listening on http://${HOST}:${PORT}`);
app.log.info(`db: ${DB_PATH}`);
