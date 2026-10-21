/**
 * Admin → Security → Gateway: the switch said one thing, the gateway served another, and nothing on the
 * screen told them apart (QA X1-03). The gateway now reports what its workers actually serve
 * (`serving`: 'https' | 'http' | 'mixed' | null, from GET /system/certs/config), and this decides which
 * warning, if any, sits above the form. Pure, so it is tested without a DOM.
 */
export interface GatewayConfigView {
    source?: string;
    sslEnabled?: boolean;
    serving?: 'https' | 'http' | 'mixed' | null;
    certInfo?: { type?: string } | null;
}

export type GatewayServingNotice =
    | 'security.gateway.servingMismatchOn'
    | 'security.gateway.servingMismatchOff'
    | 'security.gateway.noCertificateOn'
    | null;

/** Is there a certificate stored for the public listener? (`type: 'none'` = the switch is on without one.) */
export function gatewayHasCertificate(cfg: GatewayConfigView | null | undefined): boolean {
    return !!(cfg && cfg.certInfo && cfg.certInfo.type && cfg.certInfo.type !== 'none');
}

export function gatewayServingNotice(cfg: GatewayConfigView | null | undefined): GatewayServingNotice {
    if (!cfg || cfg.source === 'monolith') return null;
    if (cfg.sslEnabled === true) {
        if (cfg.serving === 'https') return null;
        if (cfg.serving === 'http') return 'security.gateway.servingMismatchOn';
        // An older gateway reports no `serving`: fall back to what the certificate says.
        if (cfg.serving == null && !gatewayHasCertificate(cfg)) return 'security.gateway.noCertificateOn';
        return null;
    }
    if (cfg.sslEnabled === false && cfg.serving === 'https') return 'security.gateway.servingMismatchOff';
    return null;
}

/** Offer "Generate a self-signed certificate"? Only when HTTPS is on, nothing is stored and HTTPS is not served. */
export function gatewayNeedsCertificate(cfg: GatewayConfigView | null | undefined): boolean {
    return !!cfg && cfg.source !== 'monolith' && cfg.sslEnabled === true && !gatewayHasCertificate(cfg) && cfg.serving !== 'https';
}
