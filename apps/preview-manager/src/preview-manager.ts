import { DockerPreviewManager } from './docker-preview.js';
import { createPreviewServer } from './server.js';

const token = process.env.PREVIEW_MANAGER_TOKEN ?? 'orchestra-local-preview-change-me';
const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port.');

const manager = new DockerPreviewManager();
await manager.reconcileGateway();
const server = createPreviewServer(manager, token);
server.listen(port, '0.0.0.0');
const cleanupTimer = setInterval(() => void manager.cleanupExpired().catch(() => undefined), 60_000);
cleanupTimer.unref();
const gatewayReconcileTimer = setInterval(() => void manager.reconcileGateway().catch(() => undefined), 5_000);
gatewayReconcileTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(cleanupTimer);
    clearInterval(gatewayReconcileTimer);
    server.close(() => process.exit(0));
  });
}
