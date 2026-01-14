import Link from "next/link";
import { FC } from "react";

interface NotFoundStateProps {
    title?: string;
    message?: string;
    backLink?: string;
    backLabel?: string;
}

const NotFoundState: FC<NotFoundStateProps> = ({
    title = "Página no encontrada",
    message = "Lo sentimos, la página que buscas no existe o ha sido movida a otro lugar.",
    backLink = "/",
    backLabel = "VOLVER AL INICIO"
}) => {
    return (
        <div className="min-h-[60vh] w-full flex flex-col items-center justify-center bg-gray-50 text-gray-900 relative overflow-hidden py-20">
            {/* Background Decorations */}
            <div className="absolute top-0 left-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
            <div className="absolute bottom-0 right-0 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />

            <div className="z-10 text-center px-4 animate-in fade-in zoom-in duration-500">
                <h1 className="text-[8rem] md:text-[12rem] font-bold leading-none text-transparent bg-clip-text bg-gradient-to-br from-blue-600 to-cyan-500 opacity-80 select-none">
                    404
                </h1>

                <h2 className="text-2xl md:text-3xl font-bold mb-4 -mt-4 md:-mt-8 text-gray-800">
                    {title}
                </h2>

                <p className="text-base md:text-lg text-gray-600 max-w-lg mx-auto mb-8 leading-relaxed">
                    {message}
                </p>

                <Link
                    href={backLink}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-cyan-600 text-white font-medium rounded-full shadow-lg shadow-blue-600/20 hover:shadow-cyan-500/30 transform hover:-translate-y-1 transition-all duration-300"
                >
                    <span className="tracking-wide uppercase text-sm">{backLabel}</span>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                </Link>
            </div>
        </div>
    );
}

export default NotFoundState;
