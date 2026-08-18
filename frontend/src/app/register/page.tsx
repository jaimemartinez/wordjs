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
import {
    EMPTY_DRAFT,
    PASSWORD_MAX,
    PASSWORD_MIN,
    REGISTRATION_DISABLED_MESSAGE,
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

        const errors = validateRegisterDraft(draft);
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;

        setLoading(true);
        try {
            const res = await authApi.register(registerPayload(draft));
            setView(registerOutcome(res) === "verify" ? "verify-sent" : "signed-in");
        } catch (err) {
            // Que el sitio tenga el registro apagado no es un error del formulario: es otra pantalla.
            if (isRegistrationDisabledError(err)) setView("disabled");
            else setError(registerErrorMessage(err));
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
                    <p className="text-gray-500 mt-2">Crear una cuenta</p>
                </div>
                {children}
                <div className="mt-6 text-center">
                    <a href="/login" className="text-sm text-gray-500 hover:text-blue-600">
                        &larr; Volver al inicio de sesión
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
                <h2 className="text-lg font-semibold text-gray-800">Registro cerrado</h2>
                <p className="text-sm text-gray-600 leading-relaxed">{REGISTRATION_DISABLED_MESSAGE}</p>
            </div>
        );
    }

    // ---- Alta creada, falta confirmar el correo ---------------------------------------------------
    if (view === "verify-sent") {
        return shell(
            <div className="text-center space-y-4" role="status">
                <i className="fa-solid fa-envelope-circle-check text-blue-500 text-4xl"></i>
                <h2 className="text-lg font-semibold text-gray-800">Revisa tu correo</h2>
                <p className="text-sm text-gray-600 leading-relaxed">
                    Tu cuenta se ha creado, pero todavía no puedes entrar: hemos enviado un enlace de
                    confirmación a tu dirección. Ábrelo para activarla.
                </p>
                <p className="text-xs text-gray-500">El enlace caduca a las 24 horas.</p>
            </div>
        );
    }

    // ---- Alta creada y sesión abierta -------------------------------------------------------------
    if (view === "signed-in") {
        return shell(
            <div className="text-center space-y-4" role="status">
                <i className="fa-solid fa-circle-check text-green-500 text-4xl"></i>
                <h2 className="text-lg font-semibold text-gray-800">¡Cuenta creada!</h2>
                <p className="text-sm text-gray-600 leading-relaxed">
                    Ya tienes la sesión iniciada con tu cuenta nueva.
                </p>
                <button
                    type="button"
                    onClick={() => router.push("/admin")}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg font-medium transition-colors"
                >
                    Ir al panel
                </button>
            </div>
        );
    }

    // ---- Formulario -------------------------------------------------------------------------------
    return shell(
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div>
                <label htmlFor="reg-username" className="block text-sm font-medium text-gray-700 mb-2">
                    Nombre de usuario
                </label>
                <input
                    id="reg-username"
                    type="text"
                    autoComplete="username"
                    value={draft.username}
                    onChange={set("username")}
                    aria-invalid={!!fieldErrors.username}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                    placeholder="Con el que iniciarás sesión"
                />
                {fieldErrors.username && <p className="mt-1.5 text-sm text-red-600">{fieldErrors.username}</p>}
            </div>

            <div>
                <label htmlFor="reg-email" className="block text-sm font-medium text-gray-700 mb-2">
                    Correo electrónico
                </label>
                <input
                    id="reg-email"
                    type="email"
                    autoComplete="email"
                    value={draft.email}
                    onChange={set("email")}
                    aria-invalid={!!fieldErrors.email}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                    placeholder="tu@ejemplo.com"
                />
                {fieldErrors.email && <p className="mt-1.5 text-sm text-red-600">{fieldErrors.email}</p>}
            </div>

            <div>
                <label htmlFor="reg-display" className="block text-sm font-medium text-gray-700 mb-2">
                    Nombre visible <span className="font-normal text-gray-400">(opcional)</span>
                </label>
                <input
                    id="reg-display"
                    type="text"
                    autoComplete="name"
                    value={draft.displayName}
                    onChange={set("displayName")}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                    placeholder="Cómo quieres que te vean"
                />
            </div>

            <div>
                <label htmlFor="reg-password" className="block text-sm font-medium text-gray-700 mb-2">
                    Contraseña
                </label>
                <div className="relative">
                    <input
                        id="reg-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={draft.password}
                        onChange={set("password")}
                        aria-invalid={!!fieldErrors.password}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900 pr-10"
                        placeholder={`Entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres`}
                    />
                    <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "Ocultar la contraseña" : "Mostrar la contraseña"}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
                    >
                        <i className={`fa-solid ${showPassword ? "fa-eye-slash" : "fa-eye"}`}></i>
                    </button>
                </div>
                {fieldErrors.password && <p className="mt-1.5 text-sm text-red-600">{fieldErrors.password}</p>}
            </div>

            <div>
                <label htmlFor="reg-confirm" className="block text-sm font-medium text-gray-700 mb-2">
                    Repite la contraseña
                </label>
                <input
                    id="reg-confirm"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={draft.confirm}
                    onChange={set("confirm")}
                    aria-invalid={!!fieldErrors.confirm}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition text-gray-900"
                    placeholder="La misma contraseña"
                />
                {fieldErrors.confirm && <p className="mt-1.5 text-sm text-red-600">{fieldErrors.confirm}</p>}
            </div>

            {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm">{error}</div>}

            <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white py-3 px-4 rounded-lg font-medium transition-colors"
            >
                {loading ? "Creando la cuenta…" : "Crear cuenta"}
            </button>
        </form>
    );
}

export default function RegisterPage() {
    return <RegisterForm />;
}
