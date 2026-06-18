import NotFoundState from "@/components/NotFoundState";

/**
 * Not-found boundary for the public site. Rendered (with a real HTTP 404 status) whenever a public
 * page calls notFound() — e.g. an unknown post/page slug — inside the public layout chrome, so
 * crawlers get a 404 instead of a soft-200 empty page.
 */
export default function PublicNotFound() {
    return (
        <NotFoundState
            title="Contenido no encontrado"
            message="El contenido que buscas no existe o ha sido movido."
        />
    );
}
