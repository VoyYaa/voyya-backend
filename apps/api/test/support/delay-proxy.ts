import net from 'node:net';

export interface DelayProxy {
  port: number;
  close: () => Promise<void>;
}

function forward(from: net.Socket, to: net.Socket, delayMs: number): void {
  from.on('data', (chunk) => {
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, delayMs);
  });
  from.on('end', () => {
    setTimeout(() => {
      if (!to.destroyed) to.end();
    }, delayMs);
  });
}

export function startDelayProxy(target: { host: string; port: number }, delayMs: number): Promise<DelayProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    forward(client, upstream, delayMs);
    forward(upstream, client, delayMs);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

export function urlThrough(databaseUrl: string, proxyPort: number): string {
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(proxyPort);
  return url.toString();
}

export function targetOf(databaseUrl: string): { host: string; port: number } {
  const url = new URL(databaseUrl);
  return { host: url.hostname, port: Number(url.port || 5432) };
}
