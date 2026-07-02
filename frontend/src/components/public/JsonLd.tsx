/**
 * Renders a JSON-LD structured-data <script> tag (Server Component — keep out of client trees).
 * Serialization escapes `<` so a malicious title/description can't `</script>`-break out.
 */
import { jsonLdString } from "@/lib/server-api";

export default function JsonLd({ data }: { data: unknown }) {
    return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}
