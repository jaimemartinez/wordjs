// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The conference portal (conference-manager 2.30.0: the plugin's portal page, frontend.portalPage — it used to
 * be a page of the core, frontend/src/app/portal/conference). One URL per audience, under /portal/conference:
 *
 *   /portal/conference              the coordinators' portal (a location's access code): registrations, fee
 *                                   payments, lodging, badges (CoordinatorPortal)
 *   /portal/conference/yo#c=<code>  «Mi inscripción», a registrant's own page behind their badge's QR
 *                                   (yo/MyRegistration; installable, with its bus notices by Web Push — sw.js)
 *   /portal/conference/badge#t=<t>  a shared badge link (badge/BadgePage), which leads to «Mi inscripción»
 *   /portal/conference/autorizacion#t=<t>  a registrant's data processing consent, signed with an e-mailed code
 *                                   (consent/ConsentPage, 2.33.0)
 *
 * The core serves, beside it, /portal/conference/file?d= (a badge PDF ticket → its bytes), /sw.js and the web
 * app manifest of «Mi inscripción»; the <head> of each sub-page comes from the manifest's portalPage.pages.
 */
import React from "react";
import CoordinatorPortal from "./CoordinatorPortal";
import MyRegistrationPage from "./yo/MyRegistration";
import BadgeLinkPage from "./badge/BadgePage";
import ConsentPage from "./consent/ConsentPage";
import PortalFrame from "./PortalFrame";

type Props = { slug: string; path: string[] };

function NotFound() {
    return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
            <div className="max-w-md text-center">
                <p className="text-lg font-semibold text-gray-900">Esta página no existe.</p>
                <a href="/portal/conference" className="mt-3 inline-block text-sm font-semibold text-blue-700 underline">Ir al portal de coordinadores</a>
            </div>
        </div>
    );
}

function pageOf(path: string[]) {
    if (!path.length) return <CoordinatorPortal />;
    if (path.length === 1 && path[0] === "yo") return <MyRegistrationPage />;
    if (path.length === 1 && path[0] === "badge") return <BadgeLinkPage />;
    if (path.length === 1 && path[0] === "autorizacion") return <ConsentPage />;
    return <NotFound />;
}

export default function ConferencePortal({ path }: Props) {
    return <PortalFrame>{pageOf(Array.isArray(path) ? path : [])}</PortalFrame>;
}
