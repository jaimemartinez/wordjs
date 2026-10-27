"use client";

/**
 * Admin → Duplicate records (/admin/database-integrity). Backend: routes/database-integrity.ts over
 * core/unique-integrity.
 *
 * The database enforces four uniqueness rules with unique indexes: logins, email addresses, the address
 * (slug) of each page or post within its type, and category/tag slugs. When stored rows already repeat a
 * value the index cannot be built, and the site works on the application's checks alone. This screen
 * lists each repeated value with its records; the administrator chooses which record keeps it and, after
 * confirming with their password, every other record gets a new unique value. Nothing is deleted, every
 * change is listed here and in the audit log, and the index is built as soon as nothing repeats.
 */

import React, { useEffect, useState } from "react";
import { databaseIntegrityApi, DuplicateChange, DuplicateGroup, UniqueRuleId, UniqueRuleStatus } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState, Button, Input, StatusBadge, Radio, RadioGroup } from "@/components/ui";
import { useMfaStepUp, MfaStepUpFields } from "@/components/MfaStepUp";

registerTranslations({
    es: {
        "dupes.title": "Registros duplicados",
        "dupes.subtitle": "Las reglas de unicidad que garantiza la base de datos",
        "dupes.intro": "Cuando dos registros comparten un valor que debería ser único, la base de datos no puede garantizar la regla. Elige qué registro conserva el valor: los demás reciben uno nuevo. No se borra nada y cada cambio queda en el registro de auditoría.",
        "dupes.rule.users.login": "Nombres de usuario",
        "dupes.rule.users.email": "Correos electrónicos",
        "dupes.rule.posts.slug": "Direcciones de páginas y entradas",
        "dupes.rule.terms.slug": "Slugs de categorías y etiquetas",
        "dupes.effect.users.login": "Las demás cuentas pasan a llamarse «nombre-id». Su nombre anterior se guarda en la cuenta; pueden seguir entrando con su correo.",
        "dupes.effect.users.email": "Las demás cuentas conservan su buzón con una etiqueta: nombre+dupID@dominio. El correo anterior se guarda en la cuenta.",
        "dupes.effect.posts.slug": "Las demás entradas reciben un número al final de su dirección (acerca-de-2).",
        "dupes.effect.terms.slug": "Las demás categorías o etiquetas reciben un número al final de su slug (noticias-2).",
        "dupes.enforced": "Garantizada",
        "dupes.pending": "{count} valor(es) repetido(s)",
        "dupes.missing": "Falta el índice",
        "dupes.missingHelp": "Nada se repite, pero el índice único no existe todavía.",
        "dupes.buildNow": "Crear los índices ahora",
        "dupes.built": "Índices creados",
        "dupes.notBuilt": "Algún índice no se pudo crear; revisa el registro del servidor",
        "dupes.allGood": "Todo en orden",
        "dupes.allGoodHelp": "La base de datos garantiza que los nombres de usuario, los correos y los slugs no se repiten.",
        "dupes.value": "Valor repetido",
        "dupes.keep": "Conservar",
        "dupes.keepThis": "Conserva el valor",
        "dupes.getsNew": "Recibe uno nuevo",
        "dupes.resolve": "Resolver",
        "dupes.resolving": "Resolviendo…",
        "dupes.choose": "Elige qué registro conserva el valor",
        "dupes.password": "Tu contraseña",
        "dupes.passwordHelp": "Resolver cambia nombres de usuario, correos o direcciones: confirma con tu contraseña.",
        "dupes.passwordNeeded": "Escribe tu contraseña para confirmar",
        "dupes.done": "Resuelto: {count} registro(s) cambiado(s)",
        "dupes.failed": "No se pudo resolver",
        "dupes.loadFailed": "No se pudieron cargar los registros",
        "dupes.changes": "Cambios hechos",
        "dupes.changeLine": "#{id} · {field}: «{from}» → «{to}»",
        "dupes.forbiddenTitle": "Acceso restringido",
        "dupes.forbiddenDescription": "Solo los administradores pueden ver y resolver los registros duplicados.",
        "dupes.col.id": "ID",
        "dupes.col.user_login": "Usuario",
        "dupes.col.user_email": "Correo",
        "dupes.col.display_name": "Nombre",
        "dupes.col.user_registered": "Alta",
        "dupes.col.post_title": "Título",
        "dupes.col.post_name": "Slug",
        "dupes.col.post_type": "Tipo",
        "dupes.col.post_status": "Estado",
        "dupes.col.post_date": "Fecha",
        "dupes.col.name": "Nombre",
        "dupes.col.slug": "Slug",
    },
    en: {
        "dupes.title": "Duplicate records",
        "dupes.subtitle": "The uniqueness rules the database enforces",
        "dupes.intro": "When two records share a value that should be unique, the database cannot enforce the rule. Choose which record keeps the value: the others get a new one. Nothing is deleted and every change is written to the audit log.",
        "dupes.rule.users.login": "Logins",
        "dupes.rule.users.email": "Email addresses",
        "dupes.rule.posts.slug": "Page and post addresses",
        "dupes.rule.terms.slug": "Category and tag slugs",
        "dupes.effect.users.login": "The other accounts are renamed «login-id». Their previous login is kept on the account; they can still sign in with their email.",
        "dupes.effect.users.email": "The other accounts keep their mailbox with a tag: name+dupID@domain. The previous address is kept on the account.",
        "dupes.effect.posts.slug": "The other entries get a number at the end of their address (about-2).",
        "dupes.effect.terms.slug": "The other categories or tags get a number at the end of their slug (news-2).",
        "dupes.enforced": "Enforced",
        "dupes.pending": "{count} repeated value(s)",
        "dupes.missing": "Index missing",
        "dupes.missingHelp": "Nothing repeats, but the unique index does not exist yet.",
        "dupes.buildNow": "Build the indexes now",
        "dupes.built": "Indexes built",
        "dupes.notBuilt": "An index could not be built; see the server log",
        "dupes.allGood": "All in order",
        "dupes.allGoodHelp": "The database enforces that logins, email addresses and slugs are unique.",
        "dupes.value": "Repeated value",
        "dupes.keep": "Keep",
        "dupes.keepThis": "Keeps the value",
        "dupes.getsNew": "Gets a new one",
        "dupes.resolve": "Resolve",
        "dupes.resolving": "Resolving…",
        "dupes.choose": "Choose which record keeps the value",
        "dupes.password": "Your password",
        "dupes.passwordHelp": "Resolving changes logins, email addresses or URLs: confirm with your password.",
        "dupes.passwordNeeded": "Enter your password to confirm",
        "dupes.done": "Resolved: {count} record(s) changed",
        "dupes.failed": "Could not resolve",
        "dupes.loadFailed": "Could not load the records",
        "dupes.changes": "Changes made",
        "dupes.changeLine": "#{id} · {field}: «{from}» → «{to}»",
        "dupes.forbiddenTitle": "Restricted",
        "dupes.forbiddenDescription": "Only administrators can see and resolve duplicate records.",
        "dupes.col.id": "ID",
        "dupes.col.user_login": "Login",
        "dupes.col.user_email": "Email",
        "dupes.col.display_name": "Name",
        "dupes.col.user_registered": "Registered",
        "dupes.col.post_title": "Title",
        "dupes.col.post_name": "Slug",
        "dupes.col.post_type": "Type",
        "dupes.col.post_status": "Status",
        "dupes.col.post_date": "Date",
        "dupes.col.name": "Name",
        "dupes.col.slug": "Slug",
    },
    pt: {
        "dupes.title": "Registros duplicados",
        "dupes.subtitle": "As regras de unicidade que o banco de dados garante",
        "dupes.intro": "Quando dois registros compartilham um valor que deveria ser único, o banco de dados não consegue garantir a regra. Escolha qual registro fica com o valor: os outros recebem um novo. Nada é apagado e cada alteração vai para o registro de auditoria.",
        "dupes.rule.users.login": "Logins",
        "dupes.rule.users.email": "Endereços de e-mail",
        "dupes.rule.posts.slug": "Endereços de páginas e posts",
        "dupes.rule.terms.slug": "Slugs de categorias e tags",
        "dupes.effect.users.login": "As outras contas passam a se chamar «login-id». O login anterior fica guardado na conta; elas ainda entram com o e-mail.",
        "dupes.effect.users.email": "As outras contas mantêm a caixa de correio com uma etiqueta: nome+dupID@domínio. O endereço anterior fica guardado na conta.",
        "dupes.effect.posts.slug": "As outras entradas recebem um número no fim do endereço (sobre-2).",
        "dupes.effect.terms.slug": "As outras categorias ou tags recebem um número no fim do slug (noticias-2).",
        "dupes.enforced": "Garantida",
        "dupes.pending": "{count} valor(es) repetido(s)",
        "dupes.missing": "Índice ausente",
        "dupes.missingHelp": "Nada se repete, mas o índice único ainda não existe.",
        "dupes.buildNow": "Criar os índices agora",
        "dupes.built": "Índices criados",
        "dupes.notBuilt": "Algum índice não pôde ser criado; veja o log do servidor",
        "dupes.allGood": "Tudo em ordem",
        "dupes.allGoodHelp": "O banco de dados garante que logins, e-mails e slugs não se repetem.",
        "dupes.value": "Valor repetido",
        "dupes.keep": "Manter",
        "dupes.keepThis": "Fica com o valor",
        "dupes.getsNew": "Recebe um novo",
        "dupes.resolve": "Resolver",
        "dupes.resolving": "Resolvendo…",
        "dupes.choose": "Escolha qual registro fica com o valor",
        "dupes.password": "Sua senha",
        "dupes.passwordHelp": "Resolver altera logins, e-mails ou endereços: confirme com sua senha.",
        "dupes.passwordNeeded": "Digite sua senha para confirmar",
        "dupes.done": "Resolvido: {count} registro(s) alterado(s)",
        "dupes.failed": "Não foi possível resolver",
        "dupes.loadFailed": "Não foi possível carregar os registros",
        "dupes.changes": "Alterações feitas",
        "dupes.changeLine": "#{id} · {field}: «{from}» → «{to}»",
        "dupes.forbiddenTitle": "Acesso restrito",
        "dupes.forbiddenDescription": "Só administradores podem ver e resolver registros duplicados.",
        "dupes.col.id": "ID",
        "dupes.col.user_login": "Login",
        "dupes.col.user_email": "E-mail",
        "dupes.col.display_name": "Nome",
        "dupes.col.user_registered": "Cadastro",
        "dupes.col.post_title": "Título",
        "dupes.col.post_name": "Slug",
        "dupes.col.post_type": "Tipo",
        "dupes.col.post_status": "Status",
        "dupes.col.post_date": "Data",
        "dupes.col.name": "Nome",
        "dupes.col.slug": "Slug",
    },
});

/** The columns each rule shows, in order — the backend sends exactly these (core/unique-integrity RULES). */
const COLUMNS: Record<UniqueRuleId, string[]> = {
    "users.login": ["id", "user_login", "user_email", "display_name", "user_registered"],
    "users.email": ["id", "user_email", "user_login", "display_name", "user_registered"],
    "posts.slug": ["id", "post_title", "post_name", "post_type", "post_status", "post_date"],
    "terms.slug": ["id", "name", "slug"],
};

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export default function DatabaseIntegrityPage() {
    const { t } = useI18n();
    const { user } = useAuth();
    const { addToast } = useToast();
    const stepUp = useMfaStepUp();
    const forbidden = !!user && user.role !== "administrator";

    const [rules, setRules] = useState<UniqueRuleStatus[] | null>(null);
    const [groups, setGroups] = useState<Partial<Record<UniqueRuleId, DuplicateGroup[]>>>({});
    const [keep, setKeep] = useState<Record<string, number>>({});
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [changes, setChanges] = useState<DuplicateChange[]>([]);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setError(null);
        try {
            const s = await databaseIntegrityApi.status();
            setRules(s.rules);
            const next: Partial<Record<UniqueRuleId, DuplicateGroup[]>> = {};
            for (const r of s.rules) {
                if (!r.enforced && r.duplicateGroups > 0) next[r.id] = (await databaseIntegrityApi.duplicates(r.id)).groups;
            }
            setGroups(next);
        } catch (e: any) {
            setError(e?.message || t("dupes.loadFailed"));
        }
    };

    useEffect(() => {
        if (forbidden || !user) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [forbidden, user]);

    const resolve = async (rule: UniqueRuleId, g: DuplicateGroup) => {
        const groupKey = `${rule}|${g.key}`;
        const keepId = keep[groupKey];
        if (!keepId) { addToast(t("dupes.choose"), "error"); return; }
        if (!password) { addToast(t("dupes.passwordNeeded"), "error"); return; }
        setBusy(groupKey);
        try {
            const r = await databaseIntegrityApi.resolve({ rule, key: g.key, keepId, currentPassword: password, ...stepUp.payload() });
            setChanges((c) => [...r.changes, ...c]);
            addToast(fill(t("dupes.done"), { count: r.changes.length }), "success");
            stepUp.reset();
            await load();
        } catch (e: any) {
            if (e?.code === "rest_bad_current_password") setPassword("");
            if (!stepUp.absorb(e)) addToast(e?.message || t("dupes.failed"), "error");
        } finally {
            setBusy(null);
        }
    };

    const buildNow = async () => {
        setBusy("enforce");
        try {
            const r = await databaseIntegrityApi.enforce();
            setRules(r.rules);
            addToast(r.missing.length ? t("dupes.notBuilt") : t("dupes.built"), r.missing.length ? "error" : "success");
        } catch (e: any) {
            addToast(e?.message || t("dupes.failed"), "error");
        } finally {
            setBusy(null);
        }
    };

    const shell = (children: React.ReactNode) => (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("dupes.title")} subtitle={t("dupes.subtitle")} icon="fa-clone" />
            {children}
        </div>
    );

    if (forbidden) {
        return shell(
            <Card variant="default" padding="none">
                <EmptyState icon="fa-lock" title={t("dupes.forbiddenTitle")} description={t("dupes.forbiddenDescription")} />
            </Card>
        );
    }

    const open = (rules || []).filter((r) => !r.enforced);
    const needsGroups = open.some((r) => r.duplicateGroups > 0);
    const onlyMissing = open.length > 0 && !needsGroups;

    return shell(
        <div className="space-y-6 max-w-5xl">
            <p className="text-sm text-gray-600 leading-relaxed">{t("dupes.intro")}</p>

            {error && (
                <Card variant="default">
                    <p className="text-sm text-red-600" role="alert">{error}</p>
                </Card>
            )}

            {rules && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="dupes-rules">
                    {rules.map((r) => (
                        <div key={r.id} className="bg-white rounded-2xl border border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
                            <span className="text-sm font-semibold text-gray-800">{t(`dupes.rule.${r.id}`)}</span>
                            {r.enforced
                                ? <StatusBadge status="completed" label={t("dupes.enforced")} />
                                : r.duplicateGroups > 0
                                    ? <StatusBadge status="pending" label={fill(t("dupes.pending"), { count: r.duplicateGroups })} />
                                    : <StatusBadge status="pending" label={t("dupes.missing")} />}
                        </div>
                    ))}
                </div>
            )}

            {rules && open.length === 0 && (
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-circle-check" title={t("dupes.allGood")} description={t("dupes.allGoodHelp")} />
                </Card>
            )}

            {onlyMissing && (
                <Card variant="default">
                    <p className="text-sm text-gray-600 mb-4">{t("dupes.missingHelp")}</p>
                    <Button onClick={buildNow} pending={busy === "enforce"} icon="fa-hammer">{t("dupes.buildNow")}</Button>
                </Card>
            )}

            {needsGroups && (
                <Card variant="default">
                    <div className="max-w-sm space-y-3">
                        <Input
                            label={t("dupes.password")}
                            icon="fa-lock"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            help={t("dupes.passwordHelp")}
                        />
                        <MfaStepUpFields stepUp={stepUp} />
                    </div>
                </Card>
            )}

            {open.filter((r) => (groups[r.id] || []).length > 0).map((r) => (
                <section key={r.id} className="space-y-3" aria-labelledby={`dupes-${r.id}`}>
                    <h2 id={`dupes-${r.id}`} className="text-base font-bold text-gray-900">{t(`dupes.rule.${r.id}`)}</h2>
                    <p className="text-xs text-gray-500">{t(`dupes.effect.${r.id}`)}</p>
                    {(groups[r.id] || []).map((g) => {
                        const groupKey = `${r.id}|${g.key}`;
                        const chosen = keep[groupKey];
                        return (
                            <Card key={groupKey} variant="default" padding="none">
                                <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-sm">
                                        <span className="text-xs font-bold uppercase tracking-wider text-gray-500 mr-2">{t("dupes.value")}</span>
                                        <code className="break-all">{g.key}</code>
                                    </span>
                                    <Button size="sm" onClick={() => resolve(r.id, g)} pending={busy === groupKey} pendingLabel={t("dupes.resolving")} disabled={!chosen || !!busy} icon="fa-wand-magic-sparkles">
                                        {t("dupes.resolve")}
                                    </Button>
                                </div>
                                <div className="px-4 py-3">
                                    <RadioGroup
                                        label={t("dupes.keep")}
                                        name={`keep-${groupKey}`}
                                        value={chosen ? String(chosen) : undefined}
                                        onChange={(v) => setKeep((k) => ({ ...k, [groupKey]: Number(v) }))}
                                    >
                                        {g.rows.map((row) => {
                                            const [first, ...rest] = COLUMNS[r.id].filter((c) => c !== "id");
                                            const verdict = chosen ? (chosen === row.id ? t("dupes.keepThis") : t("dupes.getsNew")) : "";
                                            return (
                                                <Radio
                                                    key={row.id}
                                                    value={String(row.id)}
                                                    label={<span className="break-all">#{row.id} · {String(row[first] ?? "—")}{verdict ? <span className={`ml-2 text-xs ${chosen === row.id ? "text-green-700" : "text-amber-700"}`}>{verdict}</span> : null}</span>}
                                                    description={<span className="break-all">{rest.map((c) => `${t(`dupes.col.${c}`)}: ${row[c] === null || row[c] === undefined || row[c] === "" ? "—" : String(row[c])}`).join(" · ")}</span>}
                                                />
                                            );
                                        })}
                                    </RadioGroup>
                                </div>
                            </Card>
                        );
                    })}
                </section>
            ))}

            {changes.length > 0 && (
                <Card variant="default">
                    <h2 className="text-sm font-bold text-gray-900 mb-2">{t("dupes.changes")}</h2>
                    <ul className="text-sm text-gray-700 space-y-1" data-testid="dupes-changes">
                        {changes.map((c, i) => <li key={`${c.id}-${c.field}-${i}`} className="break-all">{fill(t("dupes.changeLine"), { id: c.id, field: c.field, from: c.from, to: c.to })}</li>)}
                    </ul>
                </Card>
            )}
        </div>
    );
}
