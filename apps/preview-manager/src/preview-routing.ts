const PREVIEW_CONTAINER_NAME_SOURCE = String.raw`orchestra-preview-[0-9a-f]{8}-[1-9][0-9]*-[0-9a-f]{12}`;
export const PREVIEW_CONTAINER_NAME = new RegExp(`^${PREVIEW_CONTAINER_NAME_SOURCE}$`, 'u');
const PREVIEW_ROUTE_NAME_SOURCE = String.raw`${PREVIEW_CONTAINER_NAME_SOURCE}-[0-9a-f]{12}`;
export const PREVIEW_ROUTE_NAME = new RegExp(`^${PREVIEW_ROUTE_NAME_SOURCE}$`, 'u');

export function previewGatewayOrigin(value = process.env.PREVIEW_GATEWAY_PUBLIC_ORIGIN ?? 'http://localhost:3003') {
  const origin = new URL(value);
  if (origin.protocol !== 'http:'
    || origin.hostname !== 'localhost'
    || !origin.port
    || origin.pathname !== '/'
    || origin.username
    || origin.password
    || origin.search
    || origin.hash) {
    throw new Error('PREVIEW_GATEWAY_PUBLIC_ORIGIN must be an http://localhost:<port> origin.');
  }
  return origin;
}

export function previewRouteName(containerName: string, imageDigest: string) {
  if (!PREVIEW_CONTAINER_NAME.test(containerName)) throw new Error('Preview container name is not gateway-routable.');
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) throw new Error('Preview image digest is not gateway-routable.');
  const routeName = `${containerName}-${imageDigest.slice('sha256:'.length, 'sha256:'.length + 12)}`;
  if (!PREVIEW_ROUTE_NAME.test(routeName)) throw new Error('Preview route name is not gateway-routable.');
  return routeName;
}

export function previewPublicUrl(containerName: string, imageDigest: string, configuredOrigin?: string) {
  const url = previewGatewayOrigin(configuredOrigin);
  const routeName = previewRouteName(containerName, imageDigest);
  url.hostname = `${routeName}.localhost`;
  return url.toString();
}

/** Maps only the deterministic localhost subdomains emitted by the manager. */
export function previewContainerFromHost(hostHeader: string | undefined, configuredOrigin?: string) {
  if (!hostHeader) return undefined;
  const expected = previewGatewayOrigin(configuredOrigin);
  const exactHost = new RegExp(`^(${PREVIEW_ROUTE_NAME_SOURCE})\\.localhost:${expected.port}$`, 'u');
  return exactHost.exec(hostHeader)?.[1];
}
