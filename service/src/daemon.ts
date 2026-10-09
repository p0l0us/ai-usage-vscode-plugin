/**
 * The account service's host: kept as the module the command line and the extension import. Both the background
 * daemon and the VS Code-hosted service run through `startServiceHost` in engineHost.ts, behind one ownership lease.
 */
export { EngineOwnedError, HOST_CAPABILITIES, probeEngine, runDaemon, startServiceHost } from './engineHost';
export type { DaemonOptions, EngineOwnedReason, EngineTestOptions, EngineProbe, HostMode, HostOptions, ServiceHost, StopInfo } from './engineHost';
