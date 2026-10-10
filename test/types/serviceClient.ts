import { ServiceClient } from '../../service/out/client';
import type { ServiceCommands, ServiceInfo } from '../../service/out/protocol';

declare const client: ServiceClient;

// Valid calls preserve inferred results, cancellation and optional parameters.
const info: Promise<ServiceInfo> = client.call('service.info');
client.call('service.info', undefined, { timeoutMs: 1000 });
client.call('status.snapshot');
client.call('status.snapshot', { providers: ['codex'] });
client.call('usage.live', { provider: 'claude' }, { signal: new AbortController().signal });
client.call('config.patch', { values: { 'codex.enabled': true }, baseRevision: 1 });
declare const bridgeMethod: 'bridge.ensure' | 'bridge.connection';
client.call(bridgeMethod);

// @ts-expect-error A provider is required; omission must fail during compilation.
client.call('usage.live');
// @ts-expect-error Explicit undefined cannot bypass required arguments.
client.call('profiles.list', undefined);
// @ts-expect-error Mutations must include their required payload.
client.call('config.patch');
// @ts-expect-error Unknown RPC names are rejected.
client.call('profiles.typo', {});
// @ts-expect-error Provider identifiers must belong to the wire contract.
client.call('usage.live', { provider: 'other' });
// @ts-expect-error The expected result type follows the method, not the caller.
const wrongResult: Promise<string> = client.call('service.info');

type ConnectedClient = { id: number; client: string; version?: string };
declare const status: ServiceCommands['service.status']['result'];
const clients: ConnectedClient[] = status.clients;
// @ts-expect-error service.status returns connection records, not a count.
const count: number = status.clients;
// A normal wire object must satisfy the status type without an impossible intersection.
declare const serviceInfo: ServiceInfo;
const wireStatus: ServiceCommands['service.status']['result'] = { ...serviceInfo, clients: [] };
