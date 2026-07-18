// @ts-nocheck
"use client";

/**
 * Admin page for the Digital Downloads plugin (/admin/plugin/downloads).
 * Tabs: Productos (CRUD + sales/download counters), Pedidos (pending badge, mark-paid → auto-email,
 * CSV export), Configuración (currency symbol, manual-payment instructions, notify email,
 * link expiry days, max uses). All calls go through the host api helpers (session cookie).
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/digital-downloads";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnPrimary = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhost = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnSmall = "px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

const EMPTY_FORM = { name: "", slug: "", description: "", price: "0", file_url: "", file_label: "", image_url: "", is_published: true };

const fmtMoney = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;

// "9,99" / "9.99" → integer cents; null when unparseable/negative.
const priceToCents = (str) => {
    const n = Number(String(str ?? "").trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};

export default function DigitalDownloadsAdminPage() {
    const [tab, setTab] = useState("products");
    const [products, setProducts] = useState([]);
    const [orders, setOrders] = useState([]);
    const [config, setConfig] = useState(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    // product form state
    const [form, setForm] = useState(EMPTY_FORM);
    const [editingId, setEditingId] = useState(null);
    const [showForm, setShowForm] = useState(false);

    // orders filter
    const [orderFilter, setOrderFilter] = useState("all");

    const symbol = config?.currencySymbol || "$";
    const pendingCount = useMemo(() => orders.filter((o) => o.payment_status === "pending").length, [orders]);
    const isError = /error|inválid|no encontrado|no se pudo|falló/i.test(message);

    const loadAll = async () => {
        try { setProducts(await api(`${BASE}/products`)); } catch { setProducts([]); }
        try { setOrders(await api(`${BASE}/orders`)); } catch { setOrders([]); }
        try { setConfig(await api(`${BASE}/config`)); } catch { setConfig(null); }
    };
    useEffect(() => { loadAll(); }, []);

    const flash = (msg) => { setMessage(msg); };

    // ---- products ----
    const openCreate = () => { setForm(EMPTY_FORM); setEditingId(null); setShowForm(true); setMessage(""); };
    const openEdit = (p) => {
        setForm({
            name: p.name || "", slug: p.slug || "", description: p.description || "",
            price: ((Number(p.price_cents) || 0) / 100).toFixed(2),
            file_url: p.file_url || "", file_label: p.file_label || "", image_url: p.image_url || "",
            is_published: !!p.is_published,
        });
        setEditingId(p.id); setShowForm(true); setMessage("");
    };

    const saveProduct = async (e) => {
        e.preventDefault();
        const cents = priceToCents(form.price);
        if (cents === null) return flash("Error: precio inválido (usa un número, 0 = gratis).");
        if (!form.file_url.trim()) return flash("Error: la URL del archivo es obligatoria.");
        setBusy(true); setMessage("");
        try {
            const body = {
                name: form.name.trim(), slug: form.slug.trim(), description: form.description,
                price_cents: cents, file_url: form.file_url.trim(), file_label: form.file_label.trim(),
                image_url: form.image_url.trim(), is_published: form.is_published,
            };
            if (editingId) await apiPut(`${BASE}/products/${editingId}`, body);
            else await apiPost(`${BASE}/products`, body);
            setShowForm(false); setForm(EMPTY_FORM); setEditingId(null);
            flash(editingId ? "Producto actualizado." : "Producto creado.");
            loadAll();
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const deleteProduct = async (p) => {
        if (!window.confirm(`¿Eliminar "${p.name}"? Se eliminarán también sus pedidos y enlaces de descarga.`)) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/products/${p.id}`); flash("Producto eliminado."); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const togglePublished = async (p) => {
        setBusy(true);
        try { await apiPut(`${BASE}/products/${p.id}`, { is_published: !p.is_published }); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    // ---- orders ----
    const markPaid = async (o) => {
        setBusy(true); setMessage("");
        try {
            const r = await apiPost(`${BASE}/orders/${o.id}/paid`, {});
            if (r.already) flash("El pedido ya estaba pagado.");
            else flash(r.emailSent ? "Pedido marcado como pagado — enlace enviado por correo." : "Pedido marcado como pagado, pero el correo no se pudo enviar (revisa el proveedor de email). El cliente puede usar su código de pedido.");
            loadAll();
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const deleteOrder = async (o) => {
        if (!window.confirm(`¿Eliminar el pedido #${o.id} de ${o.customer_email}? Su enlace de descarga dejará de funcionar.`)) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/orders/${o.id}`); flash("Pedido eliminado."); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const exportCsv = async () => {
        setBusy(true); setMessage("");
        try {
            // The sandbox can't stream files — the CSV arrives as JSON and we build the Blob here.
            const data = await api(`${BASE}/orders/export`);
            const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = data.filename || "pedidos.csv";
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            flash(`Exportados ${data.count} pedidos.`);
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const copyLink = async (o) => {
        try {
            const path = o.page_path && o.page_path.startsWith("/") ? o.page_path : "/";
            const sep = path.includes("?") ? "&" : "?";
            const link = `${window.location.origin}${path}${sep}dl=${o.token}`;
            await navigator.clipboard.writeText(link);
            flash("Enlace copiado al portapapeles.");
        } catch { flash("Error: no se pudo copiar el enlace."); }
    };

    // ---- config ----
    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const saved = await apiPost(`${BASE}/config`, config);
            setConfig(saved);
            flash("Configuración guardada.");
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const filteredOrders = orderFilter === "all" ? orders : orders.filter((o) => o.payment_status === orderFilter);

    const tabBtn = (id, label, badge) => (
        <button
            key={id}
            type="button"
            onClick={() => { setTab(id); setMessage(""); }}
            className={`px-4 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
            {badge > 0 && <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-amber-400 text-gray-900 text-[10px] font-black flex items-center justify-center">{badge}</span>}
        </button>
    );

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Descargas Digitales</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Productos descargables con enlaces protegidos por token (caducidad + límite de usos)
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("products", "Productos", 0)}
                {tabBtn("orders", "Pedidos", pendingCount)}
                {tabBtn("config", "Configuración", 0)}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${isError ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{message}</div>
            )}

            {/* ============ PRODUCTOS ============ */}
            {tab === "products" && (
                <div className="space-y-6">
                    <div className="flex justify-end">
                        <button type="button" onClick={openCreate} className={btnPrimary}>+ Nuevo producto</button>
                    </div>

                    {showForm && (
                        <form onSubmit={saveProduct} className={`${cardCls} space-y-5`}>
                            <h2 className="font-bold text-gray-800">{editingId ? "Editar producto" : "Nuevo producto"}</h2>
                            <div className="grid sm:grid-cols-2 gap-5">
                                <div>
                                    <label className={labelCls}>Nombre *</label>
                                    <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} required />
                                </div>
                                <div>
                                    <label className={labelCls}>Slug (opcional — se genera del nombre)</label>
                                    <input type="text" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="mi-ebook" className={inputCls} />
                                </div>
                            </div>
                            <div>
                                <label className={labelCls}>Descripción</label>
                                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className={inputCls} />
                            </div>
                            <div className="grid sm:grid-cols-2 gap-5">
                                <div>
                                    <label className={labelCls}>Precio ({symbol}) — 0 = gratis</label>
                                    <input type="text" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="9.99" className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>Etiqueta del archivo</label>
                                    <input type="text" value={form.file_label} onChange={(e) => setForm({ ...form, file_label: e.target.value })} placeholder="PDF — 12 MB" className={inputCls} />
                                </div>
                            </div>
                            <div>
                                <label className={labelCls}>URL del archivo *</label>
                                <input type="text" value={form.file_url} onChange={(e) => setForm({ ...form, file_url: e.target.value })} placeholder="/uploads/2026/07/mi-ebook.pdf" className={inputCls} required />
                                <p className="text-[11px] text-gray-400 mt-2">
                                    Sube el archivo a la <strong>biblioteca de medios</strong> y pega aquí su URL. El enlace nunca se muestra públicamente:
                                    solo se revela a quien tenga un token de descarga válido.
                                </p>
                            </div>
                            <div>
                                <label className={labelCls}>URL de imagen (opcional)</label>
                                <input type="text" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="/uploads/2026/07/portada.jpg" className={inputCls} />
                            </div>
                            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                <input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} />
                                Publicado (visible en el bloque del editor visual)
                            </label>
                            <div className="flex flex-wrap gap-3 justify-end">
                                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className={btnGhost}>Cancelar</button>
                                <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Guardando…" : "Guardar producto"}</button>
                            </div>
                        </form>
                    )}

                    <div className={cardCls}>
                        <h2 className="font-bold text-gray-800 mb-4">Productos ({products.length})</h2>
                        {products.length === 0 ? (
                            <p className="text-sm text-gray-400">Sin productos todavía — crea el primero y agrégalo con el bloque <strong>DigitalDownloads</strong> en el editor visual.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                            <th className="py-2 pr-3">Producto</th>
                                            <th className="py-2 pr-3">Precio</th>
                                            <th className="py-2 pr-3">Ventas</th>
                                            <th className="py-2 pr-3">Descargas</th>
                                            <th className="py-2 pr-3">Estado</th>
                                            <th className="py-2"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {products.map((p) => (
                                            <tr key={p.id} className="border-b border-gray-50">
                                                <td className="py-3 pr-3">
                                                    <div className="flex items-center gap-3">
                                                        {p.image_url ? (
                                                            /* eslint-disable-next-line @next/next/no-img-element */
                                                            <img src={p.image_url} alt={p.name} className="w-10 h-10 rounded-xl object-cover border border-gray-100" />
                                                        ) : (
                                                            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-300 font-black">↓</div>
                                                        )}
                                                        <div>
                                                            <div className="font-bold text-gray-800">{p.name}</div>
                                                            <div className="text-[11px] text-gray-400">{p.file_label || p.slug}</div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="py-3 pr-3 font-bold">{(Number(p.price_cents) || 0) === 0 ? <span className="text-green-600">Gratis</span> : fmtMoney(p.price_cents, symbol)}</td>
                                                <td className="py-3 pr-3">{p.sales_count}</td>
                                                <td className="py-3 pr-3">{p.download_count}</td>
                                                <td className="py-3 pr-3">
                                                    <button type="button" onClick={() => togglePublished(p)} disabled={busy}
                                                        className={`${btnSmall} ${p.is_published ? "bg-green-50 text-green-700 hover:bg-green-100" : "bg-gray-100 text-gray-400 hover:bg-gray-200"}`}>
                                                        {p.is_published ? "Publicado" : "Oculto"}
                                                    </button>
                                                </td>
                                                <td className="py-3 text-right whitespace-nowrap">
                                                    <button type="button" onClick={() => openEdit(p)} className={`${btnSmall} bg-gray-100 text-gray-600 hover:bg-gray-200 mr-2`}>Editar</button>
                                                    <button type="button" onClick={() => deleteProduct(p)} disabled={busy} className={`${btnSmall} bg-red-50 text-red-600 hover:bg-red-100`}>Eliminar</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ============ PEDIDOS ============ */}
            {tab === "orders" && (
                <div className={cardCls}>
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <h2 className="font-bold text-gray-800">Pedidos ({filteredOrders.length})</h2>
                        <div className="flex flex-wrap items-center gap-2">
                            <select value={orderFilter} onChange={(e) => setOrderFilter(e.target.value)} className="px-3 py-2 bg-gray-50 border-2 border-gray-100 rounded-xl text-xs font-bold outline-none">
                                <option value="all">Todos</option>
                                <option value="pending">Pendientes</option>
                                <option value="paid">Pagados</option>
                            </select>
                            <button type="button" onClick={exportCsv} disabled={busy} className={btnGhost}>Exportar CSV</button>
                        </div>
                    </div>
                    {filteredOrders.length === 0 ? (
                        <p className="text-sm text-gray-400">No hay pedidos {orderFilter === "pending" ? "pendientes" : orderFilter === "paid" ? "pagados" : ""} todavía.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-2 pr-3">#</th>
                                        <th className="py-2 pr-3">Producto</th>
                                        <th className="py-2 pr-3">Cliente</th>
                                        <th className="py-2 pr-3">Importe</th>
                                        <th className="py-2 pr-3">Estado</th>
                                        <th className="py-2 pr-3">Usos</th>
                                        <th className="py-2 pr-3">Expira</th>
                                        <th className="py-2"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredOrders.map((o) => (
                                        <tr key={o.id} className="border-b border-gray-50">
                                            <td className="py-3 pr-3 text-gray-400">{o.id}</td>
                                            <td className="py-3 pr-3 font-bold text-gray-800">{o.product_name || "(eliminado)"}</td>
                                            <td className="py-3 pr-3">
                                                <div className="font-medium text-gray-700">{o.customer_name || "—"}</div>
                                                <div className="text-[11px] text-gray-400">{o.customer_email}</div>
                                            </td>
                                            <td className="py-3 pr-3 font-bold">{(Number(o.amount_cents) || 0) === 0 ? <span className="text-green-600">Gratis</span> : fmtMoney(o.amount_cents, symbol)}</td>
                                            <td className="py-3 pr-3">
                                                <span className={`${btnSmall} cursor-default ${o.payment_status === "paid" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                                                    {o.payment_status === "paid" ? "Pagado" : "Pendiente"}
                                                </span>
                                            </td>
                                            <td className="py-3 pr-3 text-gray-500">{o.use_count}/{o.max_uses}</td>
                                            <td className="py-3 pr-3 text-[11px] text-gray-400">{o.expires_at ? new Date(o.expires_at).toLocaleDateString() : "—"}</td>
                                            <td className="py-3 text-right whitespace-nowrap">
                                                {o.payment_status === "pending" && (
                                                    <button type="button" onClick={() => markPaid(o)} disabled={busy} className={`${btnSmall} bg-gray-900 text-white hover:bg-green-600 mr-2`}>Marcar pagado</button>
                                                )}
                                                {o.payment_status === "paid" && (
                                                    <button type="button" onClick={() => copyLink(o)} className={`${btnSmall} bg-gray-100 text-gray-600 hover:bg-gray-200 mr-2`}>Copiar enlace</button>
                                                )}
                                                <button type="button" onClick={() => deleteOrder(o)} disabled={busy} className={`${btnSmall} bg-red-50 text-red-600 hover:bg-red-100`}>Eliminar</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                        Al pulsar <strong>Marcar pagado</strong> se reinicia la caducidad del enlace y se envía automáticamente el correo de descarga al cliente.
                    </p>
                </div>
            )}

            {/* ============ CONFIGURACIÓN ============ */}
            {tab === "config" && (
                config === null ? (
                    <div className={cardCls}><p className="text-sm text-gray-400">Cargando configuración…</p></div>
                ) : (
                    <form onSubmit={saveConfig} className={`${cardCls} space-y-5`}>
                        <div className="grid sm:grid-cols-3 gap-5">
                            <div>
                                <label className={labelCls}>Símbolo de moneda</label>
                                <input type="text" value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} className={inputCls} maxLength={8} />
                            </div>
                            <div>
                                <label className={labelCls}>Días de validez del enlace</label>
                                <input type="number" min={1} max={365} value={config.linkDays} onChange={(e) => setConfig({ ...config, linkDays: e.target.value })} className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>Máx. descargas por enlace</label>
                                <input type="number" min={1} max={100} value={config.maxUses} onChange={(e) => setConfig({ ...config, maxUses: e.target.value })} className={inputCls} />
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>Correo de notificación (nuevos pedidos)</label>
                            <input type="email" value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder="ventas@midominio.com (vacío = correo del administrador)" className={inputCls} />
                        </div>
                        <div>
                            <label className={labelCls}>Instrucciones de pago manual</label>
                            <textarea value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} rows={5}
                                placeholder={"Ej.: Transfiere el importe a la cuenta XX00 0000 0000 e indica tu código de pedido en el concepto. Confirmaremos tu pago en 24h."}
                                className={inputCls} />
                            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                                Se muestran al comprador de productos de pago (y en su correo de "pedido recibido"). El pago con Stripe llegará en una versión futura;
                                en esta versión los pedidos de pago se confirman manualmente desde la pestaña Pedidos.
                            </p>
                        </div>
                        <div className="flex justify-end">
                            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Guardando…" : "Guardar configuración"}</button>
                        </div>
                    </form>
                )
            )}
        </div>
    );
}
