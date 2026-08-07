import {
  createOrchestraDataConverter,
  listenCodecHttpServer,
} from '@orchestra/temporal-codec';

const handle = createOrchestraDataConverter();
const externalStorage = handle.dataConverter.externalStorage;
if (!externalStorage) {
  throw new Error('Orchestra data converter is missing externalStorage');
}

const corsOrigins = (process.env.TEMPORAL_CODEC_CORS_ORIGINS ?? 'http://localhost:8080,http://127.0.0.1:8080')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const listening = await listenCodecHttpServer({
  externalStorage,
  corsOrigins,
});

console.log(`Temporal codec server listening on port ${listening.port}`);

async function shutdown() {
  await listening.close();
  await handle.close();
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
