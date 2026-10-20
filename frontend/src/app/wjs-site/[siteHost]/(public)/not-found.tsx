import NotFoundState from "@/components/NotFoundState";

/**
 * Multisite: the not-found boundary of another site of the network. A not-found boundary receives no
 * params, so it renders the plain state rather than a theme template (which would have to read the
 * site's settings without knowing which site it is for); the layout around it is the site's own.
 */
export default function SiteNotFound() {
    return (
        <NotFoundState
            title="Contenido no encontrado"
            message="El contenido que buscas no existe o ha sido movido."
        />
    );
}
