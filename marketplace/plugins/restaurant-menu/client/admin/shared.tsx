// @ts-nocheck
"use client";

/**
 * Shared helpers + look-and-feel for the Restaurant Menu admin page (split across files so the
 * v2 tabs stay readable). Everything money-related is integer cents; inputs show decimals.
 */

import React from "react";

export const BASE = "/plugin/restaurant-menu";
export const SSE_URL = "/api/v1/notifications/stream";

export const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
export const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
export const btnCls = "px-5 py-3 bg-gray-900 hover:bg-orange-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
export const btnGhostCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold text-xs transition-all disabled:opacity-50";
export const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40";
export const chipOnCls = "bg-gray-900 text-white border-gray-900";
export const chipOffCls = "bg-white text-gray-500 border-gray-200 hover:border-gray-400";

export const TAGS = [
    { id: "vegano", emoji: "🌱", label: "Vegano" },
    { id: "picante", emoji: "🌶️", label: "Picante" },
    { id: "sin-gluten", emoji: "🚫🌾", label: "Sin gluten" },
    { id: "nuevo", emoji: "✨", label: "Nuevo" },
    { id: "popular", emoji: "⭐", label: "Popular" },
];

// EU-14 allergens — keys match the backend whitelist.
export const ALLERGENS = [
    { id: "gluten", emoji: "🌾", label: "Gluten" },
    { id: "crustaceos", emoji: "🦐", label: "Crustáceos" },
    { id: "huevo", emoji: "🥚", label: "Huevo" },
    { id: "pescado", emoji: "🐟", label: "Pescado" },
    { id: "cacahuetes", emoji: "🥜", label: "Cacahuetes" },
    { id: "soja", emoji: "🫘", label: "Soja" },
    { id: "lacteos", emoji: "🥛", label: "Lácteos" },
    { id: "frutos-secos", emoji: "🌰", label: "Frutos secos" },
    { id: "apio", emoji: "🥬", label: "Apio" },
    { id: "mostaza", emoji: "🟡", label: "Mostaza" },
    { id: "sesamo", emoji: "⚪", label: "Sésamo" },
    { id: "sulfitos", emoji: "🍷", label: "Sulfitos" },
    { id: "altramuces", emoji: "🫛", label: "Altramuces" },
    { id: "moluscos", emoji: "🐚", label: "Moluscos" },
];

export const STATUS_META = {
    new: { label: "Nuevo", color: "bg-blue-50 text-blue-700 border-blue-200" },
    preparing: { label: "Preparando", color: "bg-amber-50 text-amber-700 border-amber-200" },
    ready: { label: "Listo", color: "bg-green-50 text-green-700 border-green-200" },
    delivered: { label: "Entregado", color: "bg-gray-50 text-gray-500 border-gray-200" },
    cancelled: { label: "Cancelado", color: "bg-red-50 text-red-500 border-red-200" },
};

export const RES_STATUS_META = {
    pending: { label: "Pendiente", color: "bg-amber-50 text-amber-700 border-amber-200" },
    confirmed: { label: "Confirmada", color: "bg-green-50 text-green-700 border-green-200" },
    completed: { label: "Completada", color: "bg-gray-50 text-gray-500 border-gray-200" },
    cancelled: { label: "Cancelada", color: "bg-red-50 text-red-500 border-red-200" },
    no_show: { label: "No llegó", color: "bg-purple-50 text-purple-500 border-purple-200" },
};

export const PAY_META = {
    whatsapp: { label: "WhatsApp", emoji: "💬" },
    cash: { label: "Efectivo", emoji: "💵" },
    stripe: { label: "En línea", emoji: "💳" },
};

// Monday-first display order for the weekly hours editor (keys are Sun=0…Sat=6).
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export function fmtMoney(cents, symbol) {
    const n = Number(cents) || 0;
    return `${n < 0 ? "−" : ""}${symbol || "$"}${(Math.abs(n) / 100).toFixed(2)}`;
}
export function centsToInput(cents) {
    return ((Number(cents) || 0) / 100).toFixed(2);
}
export function inputToCents(str) {
    const n = parseFloat(String(str).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}
/** Cents input that allows negatives (modifier price deltas). */
export function inputToCentsSigned(str) {
    const n = parseFloat(String(str).replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}
export function fmtDate(s) {
    if (!s) return "";
    try {
        const iso = String(s).includes("T") ? String(s) : `${String(s).replace(" ", "T")}Z`;
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(s) : d.toLocaleString();
    } catch {
        return String(s);
    }
}
export function tagsToArray(tags) {
    if (Array.isArray(tags)) return tags;
    return String(tags || "").split(",").map((t) => t.trim()).filter(Boolean);
}
export function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function daysAgoISO(days) {
    const d = new Date(Date.now() - days * 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function elapsedLabel(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}:${String(s % 60).padStart(2, "0")}`;
}
export function downloadText(filename, text) {
    if (typeof window === "undefined") return;
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// ---- module-level modal (NEVER define components inside components — focus loss) -----------------

export function Modal({ title, onClose, children, wide }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={onClose}></div>
            <div className={`relative bg-white rounded-3xl shadow-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto p-6 sm:p-8`}>
                <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-black text-gray-900">{title}</h3>
                    <button type="button" onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold">✕</button>
                </div>
                {children}
            </div>
        </div>
    );
}
