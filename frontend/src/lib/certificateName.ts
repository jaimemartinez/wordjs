/**
 * The single-name certificate form (Admin -> Security -> SSL) orders a certificate for ONE name. A list
 * typed there ("example.com, www.example.com") used to reach the CA client and come back as a generic
 * "provisioning failed"; it is caught before anything is sent, and the backend answers the same cases
 * with a `code` (routes/certs.ts) that maps to the same messages here.
 */
export type CertificateNameProblem = "cert_domain_required" | "cert_one_name" | "cert_wildcard_needs_dns" | "cert_invalid_domain";

/** Why `input` cannot go into the single-name form as is, or null to send it (the backend judges the rest). */
export function singleCertificateNameProblem(input: string, method: "http" | "dns"): CertificateNameProblem | null {
    const name = input.trim();
    if (name === "") return "cert_domain_required";
    if (/[\s,;]/.test(name)) return "cert_one_name";
    if (name.startsWith("*.") && method !== "dns") return "cert_wildcard_needs_dns";
    return null;
}

const KNOWN: ReadonlySet<string> = new Set(["cert_domain_required", "cert_one_name", "cert_wildcard_needs_dns", "cert_invalid_domain"]);

/** The problem a refused request names in its `code`, when it is one of these. */
export function certificateNameProblemFromCode(code: unknown): CertificateNameProblem | null {
    return typeof code === "string" && KNOWN.has(code) ? (code as CertificateNameProblem) : null;
}

/** The i18n key of each problem's message. */
export const CERTIFICATE_NAME_MESSAGE_KEY: Record<CertificateNameProblem, string> = {
    cert_domain_required: "ssl.name.required",
    cert_one_name: "ssl.name.oneName",
    cert_wildcard_needs_dns: "ssl.name.wildcardNeedsDns",
    cert_invalid_domain: "ssl.name.invalid",
};
