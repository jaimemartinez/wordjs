import { describe, it, expect } from "vitest";
import { singleCertificateNameProblem, certificateNameProblemFromCode, CERTIFICATE_NAME_MESSAGE_KEY } from "../certificateName";
import { translations } from "../i18n";

describe("the single-name certificate form (production v2.8.0: a list failed as a generic error)", () => {
    it("catches a list before anything is sent, and says where several names go", () => {
        for (const input of ["example.com, www.example.com", "example.com www.example.com", "a.example.com;b.example.com"]) {
            expect(singleCertificateNameProblem(input, "http"), input).toBe("cert_one_name");
        }
        expect(translations.en[CERTIFICATE_NAME_MESSAGE_KEY.cert_one_name as keyof typeof translations.en]).toMatch(/Automatic renewal/);
    });

    it("lets one name through, a wildcard only over DNS, and asks for a name when empty", () => {
        expect(singleCertificateNameProblem(" example.com ", "http")).toBeNull();
        expect(singleCertificateNameProblem("*.example.com", "http")).toBe("cert_wildcard_needs_dns");
        expect(singleCertificateNameProblem("*.example.com", "dns")).toBeNull();
        expect(singleCertificateNameProblem("  ", "http")).toBe("cert_domain_required");
    });

    it("maps the backend's codes, and every message exists in es, en and pt", () => {
        expect(certificateNameProblemFromCode("cert_invalid_domain")).toBe("cert_invalid_domain");
        expect(certificateNameProblemFromCode("rest_forbidden")).toBeNull();
        expect(certificateNameProblemFromCode(undefined)).toBeNull();
        for (const key of [...Object.values(CERTIFICATE_NAME_MESSAGE_KEY), "ssl.name.title", "ssl.name.goAutoRenewal"]) {
            for (const lang of ["es", "en", "pt"] as const) {
                expect(typeof (translations[lang] as Record<string, string>)[key], `${lang} ${key}`).toBe("string");
            }
        }
    });
});
