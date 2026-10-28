/**
 * Who may answer this node's calls to the gateway's internal mTLS port.
 *
 * Ordinary hostname verification stays the first check. It is not enough on its own here: every
 * certificate the cluster CA issues — the backend's and the frontend's too — carries `localhost` and
 * `127.0.0.1` in its SANs, so a process holding ANY cluster certificate that answered on the gateway's
 * internal port (a co-resident process that took the port, anything on the path between two machines)
 * passed it. The certificate must therefore also name the gateway: `gateway-internal` (the control
 * plane's identity) or `gateway` — the same pair the backend checks on its own gateway legs
 * (`backend/src/core/cert-manager.ts` → `checkGatewayIdentity`).
 *
 * No Node import at module scope: `instrumentation.ts` is loaded in every Next runtime, and `tls` is
 * only reached when a handshake actually runs (always in the Node.js runtime).
 */
export const GATEWAY_CNS: readonly string[] = ['gateway-internal', 'gateway'];

export function checkGatewayIdentity(host: string, peer: any): Error | undefined {
    const err = require('tls').checkServerIdentity(host, peer);
    if (err) return err;
    const cn = peer && peer.subject && peer.subject.CN;
    if (typeof cn === 'string' && GATEWAY_CNS.includes(cn)) return undefined;
    return new Error(`The gateway's internal port answered with the certificate of '${cn}', not the gateway's.`);
}
