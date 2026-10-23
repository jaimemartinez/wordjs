"use client";

/**
 * /register — el alta pública de cuentas.
 *
 * QUÉ ARREGLA. `users_can_register` ya se podía encender desde Ajustes y POST /auth/register ya
 * estaba completo (validación, política de contraseña, `default_role`, negativa a auto-asignarse un
 * buzón corporativo, rama de verificación por correo, 403 `rest_cannot_register` cuando está
 * apagado)… pero no había ni un formulario en toda la aplicación, así que encender el interruptor
 * no cambiaba nada de lo que un visitante puede ver. Esta pantalla es esa mitad que faltaba.
 *
 * TRES COSAS QUE NO SON OBVIAS:
 *
 * 1. EL INTERRUPTOR SE CONSULTA, PERO NO SE OBEDECE A CIEGAS. `users_can_register` es PÚBLICO
 *    (PUBLIC_SETTINGS en routes/settings.ts), así que se puede leer sin sesión y evitar enseñar un
 *    formulario que va a fallar. Si la consulta se cae NO se esconde el formulario: la autoridad es
 *    el POST, y su 403 se convierte en el mismo estado de «registro desactivado». Fallar al revés
 *    escondería el alta entera por un fallo pasajero de red.
 *
 * 2. HAY DOS FINALES, no uno. Con verificación de correo apagada el backend deja la cookie de
 *    sesión puesta y la cuenta está lista; con `require_email_verification` encendido devuelve
 *    `verificationRequired: true` y NO hay cookie — llevar a esa persona al panel la estrellaría
 *    contra una redirección a login. `registerOutcome` es quien distingue.
 *
 * 3. NINGÚN TEXTO DEL SERVIDOR SE PINTA. Los errores se traducen por código estable en
 *    `registerErrorMessage`; lo que se ve siempre es una cadena escrita en este repositorio.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, settingsApi } from "@/lib/api";
import { currentReturnPath } from "@/lib/safeReturnPath";
import { useI18n } from "@/contexts/I18nContext";
import { Button, IconButton, Input } from "@/components/ui";
import {
    EMPTY_DRAFT,
    PASSWORD_MAX,
    PASSWORD_MIN,
    REGISTRATION_DISABLED_KEY,
    isRegistrationDisabledError,
    registerErrorMessage,
    registerOutcome,
    registerPayload,
    registrationEnabled,
    validateRegisterDraft,
    type RegisterDraft,
    type RegisterErrors,
} from "./registerForm";

type View = "form" | "disabled" | "verify-sent" | "signed-in";

function RegisterForm() {
    const router = useRouter();
    const { t } = useI18n();
    const [draft, setDraft] = useState<RegisterDraft>(EMPTY_DRAFT);
    const [fieldErrors, setFieldErrors] = useState<RegisterErrors>({});
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [view, setView] = useState<View>("form");

    // Sonda del ajuste público. Un fallo aquí deja el formulario a la vista a propósito (ver nota 1).
    useEffect(() => {
        let active = true;
        settingsApi
            .get()
            .then((s) => {
                if (active && !registrationEnabled(s)) setView("disabled");
            })
            .catch(() => {
                /* sonda caída — el POST decide */
            });
        return () => {
            active = false;
        };
    }, []);

    const set = (key: keyof RegisterDraft) => (e: React.ChangeEvent<HTMLInputElement>) => {
        setDraft((d) => ({ ...d, [key]: e.target.value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        const errors = validateRegisterDraft(draft, t);
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;

        setLoading(true);
        try {
            const res = await authApi.register(registerPayload(draft));
            setView(registerOutcome(res) === "verify" ? "verify-sent" : "signed-in");
        } catch (err) {
            // Que el sitio tenga el registro apagado no es un error del formulario: es otra pantalla.
            if (isRegistrationDisabledError(err)) setView("disabled");
            else setError(registerErrorMessage(err, t));
        } finally {
            setLoading(false);
        }
    };

    const shell = (children: React.ReactNode) => (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-3">
                        <i className="fa-solid fa-rocket text-blue-600"></i>
                        WordJS
                    </h1>
                    <p className="text-gray-500 mt-2">{t("register.subtitle")}</p>
                </div>
                {children}
                <div className="mt-6 text-center">
                    <a href="/login" className="text-sm text-gray-500 hover:text-blue-600">
                        &larr; {t("auth.backToLogin")}
                    </a>
                </div>
            </div>
        </div>
    );

    // ---- El sitio no acepta altas -----------------------------------------------------------------
    if (view === "disabled") {
        return shell(
            <div className="text-center space-y-4" role="status">
                <i className="fa-solid fa-user-slash text-amber-500 text-4xl"></i>
                <h2 className="text-lg font-semibold text-gray-800">{t("register.disabledTitle")}</h2>
                <p className="text-sm text-gray-600 leading-relaxed">{t(REGISTRATION_DISABLED_KEY)}</p>
            </div>
        );
    }

    // ---- Alta creada, falta confirmar el correo ---------------------------------------------------
    if (view === "verify-sent") {
        return shell(
            <div className="text-center space-y-4" role="status">
                <i className="fa-solid fa-envelope-circle-check text-blue-500 text-4xl"></i>
                <h2 className="text-lg font-semibold text-gray-800">{t("register.verifyTitle")}</h2>
                <p className="text-sm text-gray-600 leading-relaxed">{t("register.verifyBody")}</p>
                <p className="text-xs text-gray-500">{t("register.verifyExpiry")}</p>
            </div>
        );
    }

    // ---- Alta creada y sesión abierta -------------------------------------------------------------
    if (view === "signed-in") {
        return shell(
            <div className="text-center space-y-4" role="status">
                <i className="fa-solid fa-circle-check text-green-500 text-4xl"></i>
                <h2 className="text-lg font-semibold text-gray-800">{t("register.createdTitle")}</h2>
                <p className="text-sm text-gray-600 leading-relaxed">{t("register.createdBody")}</p>
                {/* Rendered only after a submit (client state), so reading the URL here cannot mismatch the server HTML. */}
                <Button size="md" className="w-full" onClick={() => router.push(currentReturnPath() || "/admin")}>
                    {currentReturnPath() ? t("register.continue") : t("register.goToDashboard")}
                </Button>
            </div>
        );
    }

    // ---- Formulario -------------------------------------------------------------------------------
    return shell(
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <Input
                id="reg-username"
                size="md"
                label={t("register.username")}
                autoComplete="username"
                value={draft.username}
                onChange={set("username")}
                error={fieldErrors.username}
                placeholder={t("register.usernamePlaceholder")}
            />
            <Input
                id="reg-email"
                size="md"
                type="email"
                label={t("register.email")}
                autoComplete="email"
                value={draft.email}
                onChange={set("email")}
                error={fieldErrors.email}
                placeholder={t("register.emailPlaceholder")}
            />
            <Input
                id="reg-display"
                size="md"
                label={<>{t("register.displayName")} <span className="font-normal normal-case tracking-normal text-gray-500">{t("register.optional")}</span></>}
                autoComplete="name"
                value={draft.displayName}
                onChange={set("displayName")}
                placeholder={t("register.displayNamePlaceholder")}
            />
            <Input
                id="reg-password"
                size="md"
                type={showPassword ? "text" : "password"}
                label={t("register.password")}
                autoComplete="new-password"
                value={draft.password}
                onChange={set("password")}
                error={fieldErrors.password}
                placeholder={t("register.passwordPlaceholder").replace("{min}", String(PASSWORD_MIN)).replace("{max}", String(PASSWORD_MAX))}
                // One eye shows / hides both passwords, so the two can be compared.
                trailing={
                    <IconButton
                        size="sm"
                        icon={showPassword ? "fa-eye-slash" : "fa-eye"}
                        label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                    />
                }
            />
            <Input
                id="reg-confirm"
                size="md"
                type={showPassword ? "text" : "password"}
                label={t("register.confirm")}
                autoComplete="new-password"
                value={draft.confirm}
                onChange={set("confirm")}
                error={fieldErrors.confirm}
                placeholder={t("register.confirmPlaceholder")}
            />

            {error && <div role="alert" className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}

            <Button type="submit" size="md" className="w-full" pending={loading} pendingLabel={t("register.submitting")}>
                {t("register.submit")}
            </Button>
        </form>
    );
}

export default function RegisterPage() {
    return <RegisterForm />;
}
