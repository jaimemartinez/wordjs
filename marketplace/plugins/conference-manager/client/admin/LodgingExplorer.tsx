// @ts-nocheck
"use client";

/**
 * Lodging explorer (2.13.0) — who sleeps where, as three levels: «Hoteles › <Hotel> › Habitación <n>».
 *
 *  1. Hoteles     one big card per hotel (beds occupied / total, full / with free beds / empty rooms,
 *                 the locations its rooms are allotted to) and a summary strip on top.
 *  2. Hotel       the hotel's rooms as readable cards — full occupant names, one per line — filtered by
 *                 search / occupancy / location / room gender. Rooms are drop targets.
 *  3. Habitación  one full card per occupant (every form field) with move / remove actions, one
 *                 «Cama libre» slot per free bed with an «Asignar participante» picker, prev/next.
 *
 * It replaces the 2.5.0 accommodation board inside AssignmentPage and keeps everything it could do:
 * drag & drop between rooms and back to «Sin asignar» (grouped by location, searchable, capped at
 * BOARD_CHIP_CAP chips), the room-picker modal (keyboard / touch path), the location filter, the
 * «N sin asignar» counter, the run summary chip and the frozen / cancelled protections.
 *
 * Contract with the page: `onMove(inscriptionId, roomId | null)` is AssignmentPage.moveAttendee
 * (optimistic update + POST /inscriptions/:id/assign + silent reload; resolves true when the move
 * stuck, false when the server refused it — the page already toasted the server's message). Every
 * client-side refusal here mirrors the server (lib/lodgingView.ts), which re-checks all of them.
 *
 * Navigation never touches the browser history (the admin runs inside the Next.js app router, which
 * hard-reloads on foreign history states): the place is React state, remembered per conference in
 * sessionStorage, and `focus` (from «Hoteles y habitaciones») opens a given hotel / room once.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { fmtMoney } from "../lib/conference";
import {
    BOARD_CHIP_CAP, BOARD_DRAG_TYPE, DEFAULT_ROOM_FILTERS, POOL_FILTER,
    assignCandidates, candidateExclusions, dropBlock, dragBlock, fieldVal, fillVars, filterRooms, filtersActive,
    frozenLocationIds, genderMismatch, groupUnassigned, hotelStats, indexOccupants, lodgingStatusMeta, moveBlock,
    nameFields, navStorageKey, neighbors, occupantsOf, overallStats, parseNav, personDisplayName,
    normalizeText, personLocationId, rawLocationId, reconcileNav, roomGender, roomLock, roomMatches, roomStats, sortRooms,
    stateCounts, unassignBlock, unassignedCount, withName,
} from "../lib/lodgingView";

// ---------------------------------------------------------------------------------------------
// Small pure helpers (module level: nothing here is a component defined inside another one)
// ---------------------------------------------------------------------------------------------

/**
 * t() with a real fallback: the host's t() answers the KEY itself when a key is missing, so
 * `t(k) || fallback` would print the key. `vars` fills literal {placeholders}.
 */
const makeTx = (t: (k: string) => string) => (key: string, fallback: string, vars?: Record<string, string | number>) => {
    const s = t(key);
    const base = s && s !== key ? s : fallback;
    return vars ? fillVars(base, vars) : base;
};

/**
 * Count strings: `key` holds the plural («{n} habitaciones») and `${key}.one` the singular («{n}
 * habitación»). Spanish, English and Portuguese all use the singular for exactly 1 and only for 1.
 */
const makeTxn = (tx: ReturnType<typeof makeTx>) =>
    (key: string, other: string, one: string, n: number, vars: Record<string, string | number> = {}) =>
        (Number(n) === 1 ? tx(`${key}.one`, one, { n, ...vars }) : tx(key, other, { n, ...vars }));

/** «5 habitaciones · 1 llena · 4 con camas libres (2 vacías)» — the hotel card / header line, as text. */
const roomsSummaryParts = (tx, txn, stats) => ({
    rooms: txn('explorer.hotel.rooms', '{n} habitaciones', '{n} habitación', stats.rooms),
    full: txn('explorer.hotel.full', '{n} llenas', '{n} llena', stats.full),
    withFree: tx('explorer.hotel.with.free', '{n} con camas libres', { n: stats.withFree }),
    empty: txn('explorer.hotel.empty', '({n} vacías)', '({n} vacía)', stats.empty),
});

/**
 * Autofocus a picker's search box only with a fine pointer (mouse / trackpad): on a phone it would
 * open the on-screen keyboard over the list the user came to pick from.
 */
const prefersAutoFocus = () => {
    try { return window.matchMedia('(pointer: fine)').matches; } catch { return true; }
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusablesIn = (el: HTMLElement | null): HTMLElement[] =>
    el ? (Array.from(el.querySelectorAll(FOCUSABLE)) as HTMLElement[]).filter(n => n.getClientRects().length > 0) : [];

const BLOCK_FALLBACK: Record<string, string> = {
    'board.cancelled': 'Participante cancelado: no ocupa habitación',
    'board.frozen': 'Hospedaje en validación/validado — reábrelo en Localidades',
    'board.moving': 'Movimiento en curso — espera a que termine',
    'board.room.foreign': 'Habitación de otra localidad',
    'board.room.full': 'Habitación llena',
};
const blockText = (tx, key: string | null) => (key ? tx(key, BLOCK_FALLBACK[key] || key) : '');

const genderDot = (g: unknown) => {
    const v = String(g || '').toUpperCase().charAt(0);
    return v === 'F' ? 'bg-pink-500' : v === 'M' ? 'bg-blue-500' : 'bg-gray-300';
};
const genderLabel = (tx, g: unknown) => {
    const v = String(g || '').toUpperCase().charAt(0);
    return v === 'F' ? tx('female', 'Femenino') : v === 'M' ? tx('male', 'Masculino') : String(g || '');
};
const roomGenderLabel = (tx, g: 'M' | 'F' | 'Mixed') =>
    g === 'M' ? tx('explorer.room.gender.M', 'Hombres') : g === 'F' ? tx('explorer.room.gender.F', 'Mujeres') : tx('explorer.room.gender.Mixed', 'Mixta');

const STATUS_META: Record<string, { key: string; fallback: string; cls: string }> = {
    pending: { key: 'explorer.status.pending', fallback: 'Pendiente', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    active: { key: 'explorer.status.active', fallback: 'Activa', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    cancelled: { key: 'explorer.status.cancelled', fallback: 'Cancelada', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const PAY_META: Record<string, { key: string; fallback: string; cls: string }> = {
    paid: { key: 'paid', fallback: 'Pagado', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    partial: { key: 'partial', fallback: 'Parcial', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    unpaid: { key: 'unpaid', fallback: 'Sin pagar', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const money = (n: unknown) => '$' + fmtMoney(Number(n) || 0);

const isEditableTarget = (el: any) => {
    if (!el || typeof el !== 'object') return false;
    const tag = String(el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
};

/** The nearest scrolling ancestor (the admin content pane), to tell whether the explorer's top is visible. */
const scrollParentOf = (el: HTMLElement | null): HTMLElement | null => {
    let n = el ? el.parentElement : null;
    while (n && n !== document.body) {
        const s = getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
        n = n.parentElement;
    }
    return null;
};

/** Is a meaningful slice of `el` inside the visible part of its scroll pane (or of the window)? */
const isOnScreen = (el: HTMLElement | null): boolean => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const sp = scrollParentOf(el);
    const top = sp ? sp.getBoundingClientRect().top : 0;
    const bottom = sp ? sp.getBoundingClientRect().bottom : window.innerHeight;
    return r.bottom > top + 48 && r.top < bottom - 48;
};

const ROOM_FREE_SLOTS_CAP = 12;   // «Cama libre» slots drawn in the room view
const CARD_FREE_LINES_CAP = 4;    // «Cama libre» placeholders drawn in a room card
const PICKER_CAP = 200;           // candidates drawn in the assign picker before "use the search box"

const btnGhost = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-gray-100 bg-white text-gray-600 hover:border-indigo-300 hover:text-indigo-700 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200';
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm placeholder:text-gray-300';

// ---------------------------------------------------------------------------------------------
// The explorer
// ---------------------------------------------------------------------------------------------

export default function LodgingExplorer({
    conferenceId, inscriptions, hotels, locations, fields, onMove, pending, loading, runSummary, boardRef,
    focus, onFocusConsumed, suspendKeys, loadFailed, onRetry,
}: {
    conferenceId: number;
    inscriptions: any[];
    hotels: any[];
    locations: any[];
    fields: any[];
    onMove: (inscriptionId: number, roomId: number | null) => Promise<boolean>;
    pending: Set<number>;
    loading: boolean;
    runSummary: { assigned: number; remaining: number } | null;
    boardRef: React.RefObject<HTMLDivElement>;
    /** Open this hotel (and room) once — set by «Hoteles y habitaciones»; cleared through onFocusConsumed. */
    focus?: { hotelId: number; roomId?: number | null } | null;
    onFocusConsumed?: () => void;
    /** The page has a modal of its own open: the explorer's Esc / ← → shortcuts stand down. */
    suspendKeys?: boolean;
    /**
     * The page's latest load failed: the lists may be empty because nothing arrived, not because nothing
     * exists — the remembered place is then left alone (not fitted to empty data) and a retry is offered.
     */
    loadFailed?: boolean;
    onRetry?: () => void;
}) {
    const { t } = useI18n();
    const tx = makeTx(t);
    const txn = makeTxn(tx);
    const { addToast } = useToast();
    const { confirm } = useModal();
    const people = inscriptions || [];
    const hotelList = hotels || [];
    const locs = locations || [];

    // --- Where the user is (remembered per conference; never in the browser history) -------------
    const storageKey = navStorageKey(conferenceId);
    const [nav, setNav] = useState(() => {
        try { return parseNav(window.sessionStorage.getItem(storageKey)); } catch { return parseNav(null); }
    });
    useEffect(() => {
        try { window.sessionStorage.setItem(storageKey, JSON.stringify(nav)); } catch { /* private mode / blocked storage */ }
    }, [storageKey, nav]);
    // Fit the remembered place to the data once it is in (a hotel / room / location may be gone). Never
    // against the empty lists a FAILED load leaves behind: that would erase the place for good.
    useEffect(() => {
        if (loading || loadFailed) return;
        setNav(n => reconcileNav(n, hotelList, locs));
    }, [loading, loadFailed, hotelList, locs]);

    const headingRef = useRef<HTMLElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    // A navigation the user asked for: what to scroll / focus once the new level has rendered.
    // scroll: true = bring the explorer's top back when it is above the visible area; 'always' = scroll
    // to it in any case (arriving from «Hoteles y habitaciones», where the page header sits above it).
    const navigatedRef = useRef<{ scroll: boolean | 'always'; heading: boolean; selector: string | null } | null>(null);

    const go = (hotelId: number | null, roomId: number | null, opts: { scroll?: boolean | 'always'; heading?: boolean; selector?: string | null } = {}) => {
        if (nav.hotelId === hotelId && nav.roomId === roomId) return;
        navigatedRef.current = { scroll: opts.scroll ?? true, heading: opts.heading ?? true, selector: opts.selector ?? null };
        setNav(n => ({ ...n, hotelId, roomId }));
    };
    const contentReady = !(loading && hotelList.length === 0);
    const shownLevel = !contentReady ? 0 : (nav.hotelId == null ? 1 : nav.roomId == null ? 2 : 3);
    useEffect(() => {
        const req = navigatedRef.current;
        if (!req || !contentReady) return;   // wait for the data: the requested level is not drawn yet
        navigatedRef.current = null;
        const root = boardRef?.current;
        if (req.scroll && root) {
            const sp = scrollParentOf(root);
            const limit = sp ? sp.getBoundingClientRect().top : 0;
            if (req.scroll === 'always' || root.getBoundingClientRect().top < limit) root.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
        const target = (req.selector && root ? root.querySelector(req.selector) : null) as HTMLElement | null;
        if (target) target.focus();                                   // back: reveal the card we came from
        else if ((req.heading || req.selector) && headingRef.current) headingRef.current.focus({ preventScroll: !!req.scroll });
    }, [nav.hotelId, nav.roomId, shownLevel]);

    // «Ver ocupación» from «Hoteles y habitaciones»: open that hotel / room once, with clean filters.
    useEffect(() => {
        if (!focus || focus.hotelId == null) return;
        navigatedRef.current = { scroll: 'always', heading: true, selector: null };
        setNav(n => ({ ...n, hotelId: Number(focus.hotelId), roomId: focus.roomId != null ? Number(focus.roomId) : null, filters: { ...DEFAULT_ROOM_FILTERS } }));
        if (onFocusConsumed) onFocusConsumed();
    }, [focus]);

    // A fresh engine run touches every hotel: show the overview so its result is what is on screen.
    const lastRun = useRef(runSummary);
    useEffect(() => {
        if (runSummary && runSummary !== lastRun.current) {
            navigatedRef.current = null;
            setNav(n => (n.hotelId == null ? n : { ...n, hotelId: null, roomId: null }));
        }
        lastRun.current = runSummary;
    }, [runSummary]);

    const setFilters = (patch: Partial<typeof nav.filters>) => setNav(n => ({ ...n, filters: { ...n.filters, ...patch } }));
    const clearFilters = () => setNav(n => ({ ...n, filters: { ...DEFAULT_ROOM_FILTERS } }));
    const setUnassignedOpen = (open: boolean) => setNav(n => (n.unassignedOpen === open ? n : { ...n, unassignedOpen: open }));

    // --- Derived data ---------------------------------------------------------------------------
    const idx = useMemo(() => indexOccupants(people), [people]);
    const ctx = useMemo(() => ({ frozen: frozenLocationIds(locs), pending }), [locs, pending]);
    const locById = useMemo(() => {
        const m = new Map<number, any>();
        for (const l of locs) m.set(Number(l.id), l);
        return m;
    }, [locs]);
    const nameOf = useCallback((p: any) => personDisplayName(p, fields), [fields]);
    const locationIdOf = useCallback((p: any) => personLocationId(p, locs), [locs]);
    const deps = useMemo(() => ({ idx, nameOf, locationIdOf }), [idx, nameOf, locationIdOf]);
    const roomIndex = useMemo(() => {
        const m = new Map<number, { room: any; hotel: any }>();
        for (const h of hotelList) for (const r of (h.rooms || [])) m.set(Number(r.id), { room: r, hotel: h });
        return m;
    }, [hotelList]);
    const roomLabel = (roomId: number | null | undefined) => {
        const e = roomId == null ? null : roomIndex.get(Number(roomId));
        return e ? `${e.hotel.name} · ${e.room.room_number}` : (roomId == null ? '' : `#${roomId}`);
    };
    const locNameOf = (p: any) => {
        const id = locationIdOf(p);
        return (id != null && locById.get(Number(id))?.name) || p?.location || '';
    };
    const roomLocName = (room: any) =>
        room?.location_id == null ? '' : (room.location_name || locById.get(Number(room.location_id))?.name || `#${room.location_id}`);

    const hotel = nav.hotelId == null ? null : hotelList.find(h => Number(h.id) === Number(nav.hotelId)) || null;
    const room = hotel && nav.roomId != null ? (hotel.rooms || []).find(r => Number(r.id) === Number(nav.roomId)) || null : null;
    const level = hotel ? (room ? 3 : 2) : 1;
    const filteredRooms = useMemo(() => (hotel ? filterRooms(hotel.rooms, nav.filters, deps) : []), [hotel, nav.filters, deps]);
    // Prev/next respect the filters; when the open room itself is filtered out, walk every room instead.
    const walkFiltered = room ? neighbors(filteredRooms, room.id) : null;
    const walkAll = room && walkFiltered && walkFiltered.index < 0 ? neighbors(sortRooms(hotel.rooms), room.id) : null;
    const walk = walkAll || walkFiltered;

    const openHotel = (id: number) => go(Number(id), null);
    const openRoom = (id: number, opts?: any) => {
        const owner = roomIndex.get(Number(id))?.hotel;
        go(owner ? Number(owner.id) : nav.hotelId, Number(id), opts);
    };
    const goHotels = () => go(null, null, { scroll: false, heading: false, selector: nav.hotelId != null ? `[data-hotel-card="${nav.hotelId}"]` : null });
    const goHotel = () => go(nav.hotelId, null, { scroll: false, heading: false, selector: nav.roomId != null ? `[data-room-card="${nav.roomId}"]` : null });
    const goUp = () => { if (level === 3) goHotel(); else if (level === 2) goHotels(); };

    // --- «Sin asignar» ----------------------------------------------------------------------------
    const [search, setSearch] = useState('');
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
    const unassigned = useMemo(
        () => groupUnassigned(people, locs, { q: search, location: nav.filters.location, nameOf }),
        [people, locs, search, nav.filters.location, nameOf],
    );
    const unassignedTotal = useMemo(() => unassignedCount(people), [people]);
    const toggleGroup = (key: string) => setCollapsedGroups(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const openUnassigned = () => {
        setUnassignedOpen(true);
        // After the commit that shows the (narrow-screen) section: bring it into view and focus its search.
        requestAnimationFrame(() => {
            if (panelRef.current) panelRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            if (searchRef.current) searchRef.current.focus({ preventScroll: true });
        });
    };

    // --- Modals: room picker (move) and attendee picker (assign a free bed) -----------------------
    const [moveTargetId, setMoveTargetId] = useState<number | null>(null);
    // The room picker can open narrowed to one hotel (a chip dropped on that hotel's card).
    const [moveScopeHotelId, setMoveScopeHotelId] = useState<number | null>(null);
    const [assignRoomId, setAssignRoomId] = useState<number | null>(null);
    const moveTarget = moveTargetId == null ? null : people.find(p => p.id === moveTargetId) || null;
    const assignEntry = assignRoomId == null ? null : roomIndex.get(Number(assignRoomId)) || null;
    const openMove = (p: any, scopeHotelId: number | null = null) => {
        setMoveScopeHotelId(scopeHotelId);
        setMoveTargetId(p.id);
    };
    // A target that vanished in a reload (deleted attendee / room) closes its modal.
    useEffect(() => {
        if (loading) return;
        if (moveTargetId != null && !moveTarget) setMoveTargetId(null);
        if (assignRoomId != null && !assignEntry) setAssignRoomId(null);
    }, [loading, moveTargetId, moveTarget, assignRoomId, assignEntry]);
    // Where focus goes when a modal closes and the control that opened it is gone (the occupant card of
    // someone just moved, the «Cama libre» slot just filled): the level's heading, else the explorer.
    const focusFallback = () => headingRef.current || boardRef?.current || null;

    const unassign = async (p: any) => {
        const why = unassignBlock(p, ctx);
        if (why) { addToast(blockText(tx, why), 'error'); return; }
        const opener = document.activeElement as HTMLElement | null;
        const ok = await confirm(
            tx('explorer.unassign.confirm', '¿Quitar a {name} de {room}? Quedará sin habitación.', { name: nameOf(p), room: roomLabel(p.room_id) }),
            tx('explorer.unassign', 'Quitar de la habitación'),
            true,
        );
        if (!ok) {
            // The host's confirm does not hand focus back: return it to the «Quitar» button.
            if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
            return;
        }
        const moved = await onMove(p.id, null);
        // The occupant card that held the focused «Quitar» button is gone: continue on the bed it freed
        // (its «Asignar participante»), else the room heading — never drop the keyboard user on <body>.
        if (moved) requestAnimationFrame(() => {
            const root = boardRef?.current;
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) return; // focus is somewhere real: leave it
            const next = (root && root.querySelector('[data-assign-bed]:not([disabled])')) as HTMLElement | null;
            const target = next || focusFallback();
            if (target) target.focus({ preventScroll: false });
        });
    };

    // --- Drag & drop (same contract as the 2.5.0 board) -------------------------------------------
    // A chip carries its inscription id under BOARD_DRAG_TYPE (and in `dragging`, for browsers that
    // hide the payload during dragover). dropEffect stays 'move' even over a refused target: a
    // dragover that ends in 'none' cancels the drop and the explanatory toast would never show.
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const draggedPerson = dragging == null ? null : people.find(p => p.id === dragging) || null;
    const hasOurType = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes(BOARD_DRAG_TYPE);
    const isOurDrag = (e: React.DragEvent) => dragging != null || hasOurType(e);
    const readDragId = (e: React.DragEvent) => {
        if (!hasOurType(e)) return dragging;
        const n = Number(e.dataTransfer.getData(BOARD_DRAG_TYPE));
        return Number.isInteger(n) && n > 0 ? n : dragging;
    };
    const dnd = {
        dragging,
        over,
        draggedPerson,
        start: (p: any) => (e: React.DragEvent) => {
            e.stopPropagation();
            e.dataTransfer.setData(BOARD_DRAG_TYPE, String(p.id));
            e.dataTransfer.setData('text/plain', nameOf(p));
            e.dataTransfer.effectAllowed = 'move';
            setDragging(p.id);
        },
        end: () => { setDragging(null); setOver(null); },
        roomOver: (r: any) => (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== `room:${r.id}`) setOver(`room:${r.id}`);
        },
        roomDrop: (r: any) => async (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            setOver(null);
            const id = readDragId(e);
            setDragging(null);
            if (id == null) return;
            const p = people.find(x => x.id === id);
            if (!p || Number(p.room_id) === Number(r.id)) return;
            const why = moveBlock(p, r, ctx, idx);
            if (why) { addToast(blockText(tx, why), 'error'); return; }
            await onMove(id, r.id);
        },
        unassignedOver: (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== 'unassigned') setOver('unassigned');
        },
        unassignedDrop: async (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            setOver(null);
            const id = readDragId(e);
            setDragging(null);
            if (id == null) return;
            const p = people.find(x => x.id === id);
            if (!p || p.room_id == null) return;
            const why = unassignBlock(p, ctx);
            if (why) { addToast(blockText(tx, why), 'error'); return; }
            await onMove(id, null);
        },
        // A hotel card (level 1) or the «otro hotel» strip (level 2): dropping opens the room picker for
        // the dragged attendee — narrowed to that hotel for a card — so a move between rooms of
        // DIFFERENT hotels stays one drag plus one click, as on the old all-hotels board.
        pickOver: (key: string) => (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== key) setOver(key);
        },
        pickDrop: (scopeHotelId: number | null) => (e: React.DragEvent) => {
            if (!isOurDrag(e)) return;
            e.preventDefault();
            setOver(null);
            const id = readDragId(e);
            setDragging(null);
            if (id == null) return;
            const p = people.find(x => x.id === id);
            if (!p) return;
            const why = dragBlock(p, ctx);
            if (why) { addToast(blockText(tx, why), 'error'); return; }
            openMove(p, scopeHotelId);
        },
        // Children fire dragleave too; only clear when the pointer really left the target.
        leave: (key: string) => (e: React.DragEvent) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            if (over === key) setOver(null);
        },
    };

    // --- Keyboard: Esc = one level up, ← / → = previous / next room ---------------------------------
    // Where the user's attention is when focus sits on <body> (a click on plain text, a removed control):
    // the last pointer press / focus landed inside the explorer (true), outside it (false), or nowhere
    // yet (null). A press on the rules below the explorer must not let Esc move it off-screen.
    const attentionRef = useRef<boolean | null>(null);
    useEffect(() => {
        const track = (e: Event) => {
            const root = boardRef?.current;
            const target = e.target as Node | null;
            if (root && target && target !== document.body && target !== document.documentElement) attentionRef.current = root.contains(target);
        };
        document.addEventListener('pointerdown', track, true);
        document.addEventListener('focusin', track, true);
        return () => {
            document.removeEventListener('pointerdown', track, true);
            document.removeEventListener('focusin', track, true);
        };
    }, []);
    // One listener for the component's life; it calls the latest handler through a ref (no stale state).
    const keyHandler = useRef<(e: KeyboardEvent) => void>(() => { });
    useEffect(() => {
        keyHandler.current = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e as any).isComposing) return;
            if (e.key !== 'Escape' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            if (suspendKeys || moveTargetId != null || assignRoomId != null) return;
            if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
            if (document.querySelector('[aria-modal="true"]')) return;          // host confirm or any dialog
            const root = boardRef?.current;
            const active = document.activeElement;
            if (root && active && active !== document.body && !root.contains(active)) return; // focus is elsewhere
            if (root && (!active || active === document.body)) {
                // Nothing focused: act only when the user was last working in the explorer, or (before any
                // interaction) when it is actually on screen — never change a place nobody is looking at.
                if (attentionRef.current === false) return;
                if (attentionRef.current == null && !isOnScreen(root)) return;
            }
            if (e.key === 'Escape') {
                if (level > 1) { e.preventDefault(); goUp(); }
                return;
            }
            if (level !== 3 || !walk) return;
            const target = e.key === 'ArrowLeft' ? walk.prev : walk.next;
            if (target) { e.preventDefault(); openRoom(target.id, { scroll: false, heading: false }); }
        };
    });
    useEffect(() => {
        const h = (e: KeyboardEvent) => keyHandler.current(e);
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, []);

    // --- Render -----------------------------------------------------------------------------------
    const env = { tx, txn, ctx, idx, nameOf, locNameOf, locationIdOf, roomLocName, roomLabel, fields, dnd, locById, filters: nav.filters };
    const overall = overallStats(hotelList, people, idx);
    const locationOnly = { ...DEFAULT_ROOM_FILTERS, location: nav.filters.location };

    const spinner = (
        <div className="p-12 text-center">
            <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{tx('loading', 'Cargando...')}</p>
        </div>
    );

    let main: React.ReactNode;
    if (!contentReady) {
        main = spinner;
    } else if (loadFailed && hotelList.length === 0) {
        // Nothing arrived: say so (not «no hay hoteles»), keep the remembered place, offer a retry.
        main = (
            <div className="text-center py-16 px-6 bg-rose-50/40 rounded-3xl border-2 border-dashed border-rose-200" role="alert">
                <h4 ref={headingRef} tabIndex={-1} className="sr-only">{tx('explorer.crumb.hotels', 'Hoteles')}</h4>
                <i className="fa-solid fa-triangle-exclamation text-3xl mb-3 text-rose-400"></i>
                <p className="text-sm font-bold text-rose-700">{tx('explorer.load.failed', 'No se pudieron cargar los hoteles y los participantes.')}</p>
                {onRetry && (
                    <button type="button" onClick={onRetry} className={`${btnGhost} mt-4`}>
                        <i className="fa-solid fa-rotate-right text-[9px]"></i> {tx('explorer.load.retry', 'Reintentar')}
                    </button>
                )}
            </div>
        );
    } else if (level === 1) {
        main = (
            <div className="space-y-6">
                <SummaryStrip stats={overall} tx={tx} txn={txn} onOpenUnassigned={openUnassigned} headingRef={headingRef} />
                {hotelList.length === 0 ? (
                    <div className="text-center py-16 px-6 text-gray-400 bg-gray-50/50 rounded-3xl border-2 border-dashed border-gray-200">
                        <i className="fa-solid fa-hotel text-3xl mb-3 opacity-40"></i>
                        <p className="text-sm font-bold text-gray-500">{tx('no.hotels', 'No hay hoteles configurados.')}</p>
                        <p className="text-xs text-gray-400 mt-1">{tx('explorer.no.hotels.hint', 'Crea los hoteles y sus habitaciones en la pestaña Alojamiento.')}</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
                        {hotelList.map(h => (
                            <HotelCard
                                key={h.id}
                                hotel={h}
                                stats={hotelStats(h, idx, locs)}
                                matching={nav.filters.location ? (h.rooms || []).filter(r => roomMatches(r, locationOnly, deps)).length : null}
                                matchingPool={nav.filters.location === POOL_FILTER}
                                onOpen={() => openHotel(h.id)}
                                env={env}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    } else if (level === 2) {
        main = (
            <HotelLevel
                hotel={hotel}
                stats={hotelStats(hotel, idx, locs)}
                rooms={filteredRooms}
                counts={stateCounts(hotel.rooms, nav.filters, deps)}
                total={(hotel.rooms || []).length}
                setFilters={setFilters}
                clearFilters={clearFilters}
                onOpenRoom={(id: number) => openRoom(id)}
                headingRef={headingRef}
                env={env}
            />
        );
    } else {
        main = (
            <RoomLevel
                hotel={hotel}
                room={room}
                walk={walk}
                walkingAll={!!walkAll}
                onOpenRoom={(id: number) => openRoom(id, { scroll: false, heading: false })}
                onMove={(p: any) => openMove(p)}
                onUnassign={unassign}
                onAssign={() => setAssignRoomId(room.id)}
                headingRef={headingRef}
                env={env}
            />
        );
    }

    const otherHotelDrop = hotelList.length > 1 && dragging != null && !!draggedPerson;
    const otherHotelWhy = otherHotelDrop && over === 'other-hotel' ? dragBlock(draggedPerson, ctx) : null;

    const runChip = runSummary && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 text-[10px] font-black uppercase tracking-widest">
            <i className="fa-solid fa-wand-magic-sparkles text-[9px]"></i>
            {tx('board.run.summary', 'Asignados: {n} · Pendientes: {m}', { n: runSummary.assigned, m: runSummary.remaining })}
        </div>
    );

    return (
        <div ref={boardRef} tabIndex={-1} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 outline-none focus-visible:ring-4 focus-visible:ring-indigo-100">
            {/* Header: title, last run, location filter, unassigned counter (the old board's header). */}
            <div className="bg-gray-50/50 border-b border-gray-100 rounded-t-3xl px-4 sm:px-8 py-5 sm:py-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-4 min-w-0">
                    <div className="flex items-center gap-4 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200 shrink-0">
                            <i className="fa-solid fa-bed"></i>
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-xl font-black text-gray-900 italic tracking-tighter leading-none">{tx('board.title', 'Acomodación')}</h3>
                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-2">{tx('explorer.subtitle', 'Entra en un hotel y en una habitación para ver quién duerme ahí')}</p>
                        </div>
                    </div>
                    {runChip}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="sr-only" htmlFor={`cm-explorer-loc-${conferenceId}`}>{tx('explorer.filter.location.label', 'Localidad')}</label>
                    <select
                        id={`cm-explorer-loc-${conferenceId}`}
                        value={nav.filters.location}
                        onChange={e => setFilters({ location: e.target.value })}
                        className="min-h-[44px] border-2 border-gray-100 rounded-xl px-3 py-2 bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-xs max-w-full"
                    >
                        <option value="">{tx('board.all.locations', 'Todas las localidades')}</option>
                        <option value={POOL_FILTER}>{tx('explorer.location.pool', 'Pool (sin localidad)')}</option>
                        {locs.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                    </select>
                    {!loading && (
                        <button
                            type="button"
                            onClick={openUnassigned}
                            className="min-h-[44px] flex items-center gap-2 px-3 py-1.5 bg-white rounded-xl border border-gray-100 text-[10px] font-black uppercase tracking-widest text-amber-600 hover:border-amber-300 transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-100"
                        >
                            <i className="fa-solid fa-user-clock text-[9px]"></i>
                            {tx('board.unassigned.count', '{n} sin asignar', { n: unassignedTotal })}
                        </button>
                    )}
                </div>
            </div>

            {/* Breadcrumb — always visible (sticky in the admin's scroll pane) and clickable. Below `sm`
                it is ONE line (icon-only «Volver» and «Hoteles», the hotel name truncated, the room by its
                number) so the pinned bar does not eat the phone's small scroll pane. */}
            <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-100 px-3 sm:px-8 py-2 sm:py-3 flex flex-nowrap sm:flex-wrap items-center gap-2 sm:gap-3">
                {level > 1 && (
                    <button type="button" onClick={goUp} aria-label={tx('explorer.back', 'Volver')} className="shrink-0 inline-flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 min-h-[44px] min-w-[44px] rounded-xl bg-gray-900 text-white hover:bg-indigo-600 font-black text-[11px] uppercase tracking-widest transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200">
                        <i className="fa-solid fa-arrow-left text-[10px]" aria-hidden="true"></i><span className="hidden sm:inline">{tx('explorer.back', 'Volver')}</span>
                    </button>
                )}
                <nav aria-label={tx('explorer.breadcrumb', 'Ruta de navegación')} className="min-w-0 flex-1">
                    <ol className="flex flex-nowrap sm:flex-wrap items-center gap-x-1 sm:gap-x-1.5 gap-y-1 text-sm min-w-0">
                        <li className="flex items-center shrink-0">
                            {level === 1 ? (
                                <span aria-current="page" className="px-2 py-1 font-black text-gray-900"><i className="fa-solid fa-hotel mr-1.5 text-indigo-500" aria-hidden="true"></i>{tx('explorer.crumb.hotels', 'Hoteles')}</span>
                            ) : (
                                <button type="button" onClick={goHotels} title={tx('explorer.crumb.hotels', 'Hoteles')} className="px-2 py-1 min-h-[36px] rounded-lg font-bold text-indigo-600 hover:bg-indigo-50 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                                    <i className="fa-solid fa-hotel sm:mr-1.5" aria-hidden="true"></i><span className="sr-only sm:not-sr-only">{tx('explorer.crumb.hotels', 'Hoteles')}</span>
                                </button>
                            )}
                        </li>
                        {hotel && (
                            <li className="flex items-center min-w-0">
                                <i className="fa-solid fa-chevron-right text-[9px] text-gray-300 mx-1 shrink-0" aria-hidden="true"></i>
                                {level === 2 ? (
                                    <span aria-current="page" title={hotel.name} className="px-2 py-1 font-black text-gray-900 min-w-0 truncate sm:whitespace-normal sm:break-words">{hotel.name}</span>
                                ) : (
                                    <button type="button" onClick={goHotel} title={hotel.name} className="px-2 py-1 min-h-[36px] min-w-0 rounded-lg font-bold text-indigo-600 hover:bg-indigo-50 hover:underline text-left truncate sm:whitespace-normal sm:break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">{hotel.name}</button>
                                )}
                            </li>
                        )}
                        {room && (
                            <li className="flex items-center shrink-0">
                                <i className="fa-solid fa-chevron-right text-[9px] text-gray-300 mx-1" aria-hidden="true"></i>
                                <span aria-current="page" className="px-2 py-1 font-black text-gray-900 whitespace-nowrap">
                                    <i className="fa-solid fa-door-closed mr-1 text-gray-400 sm:hidden" aria-hidden="true"></i>
                                    <span className="sr-only sm:not-sr-only">{tx('explorer.room.word', 'Habitación')} </span>{room.room_number}
                                </span>
                            </li>
                        )}
                    </ol>
                </nav>
                {level > 1 && otherHotelDrop ? (
                    // While a chip / occupant is dragged inside one hotel: a target to send it to a room of
                    // ANOTHER hotel (the room picker opens for that person). It lives in the pinned bar, so it
                    // is always in view and nothing in the grid shifts when a drag starts.
                    <div
                        onDragOver={dnd.pickOver('other-hotel')}
                        onDragLeave={dnd.leave('other-hotel')}
                        onDrop={dnd.pickDrop(null)}
                        className={`hidden sm:flex items-center gap-2 ml-auto px-4 min-h-[44px] rounded-xl border-2 border-dashed text-[11px] font-black transition-all ${dnd.over === 'other-hotel' ? (otherHotelWhy ? 'text-rose-600 border-rose-300 bg-rose-50' : 'text-indigo-700 border-indigo-400 bg-indigo-50') : 'text-gray-500 border-gray-300 bg-white'}`}
                    >
                        <i className="fa-solid fa-hotel" aria-hidden="true"></i>
                        {otherHotelWhy ? blockText(tx, otherHotelWhy) : tx('explorer.drop.other.hotel', 'Soltar en otro hotel')}
                    </div>
                ) : level > 1 && (
                    <span className="hidden md:inline text-[10px] text-gray-400 font-bold">
                        {level === 3 ? tx('explorer.keys.room', '← → cambian de habitación · Esc vuelve atrás') : tx('explorer.keys.hotel', 'Esc vuelve a los hoteles')}
                    </span>
                )}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(260px,320px)_1fr]">
                <UnassignedPanel
                    panelRef={panelRef}
                    searchRef={searchRef}
                    groups={unassigned}
                    total={unassignedTotal}
                    loading={loading}
                    spinner={spinner}
                    search={search}
                    setSearch={setSearch}
                    collapsedGroups={collapsedGroups}
                    toggleGroup={toggleGroup}
                    open={nav.unassignedOpen}
                    setOpen={setUnassignedOpen}
                    onOptions={(p: any) => openMove(p)}
                    env={env}
                />
                <div className="p-4 sm:p-6 min-w-0">{main}</div>
            </div>

            {moveTarget && (
                <RoomPickerModal
                    person={moveTarget}
                    hotels={hotelList}
                    scopeHotelId={moveScopeHotelId}
                    onClose={() => { setMoveTargetId(null); setMoveScopeHotelId(null); }}
                    onMove={onMove}
                    restoreFocus={focusFallback}
                    env={env}
                />
            )}
            {assignEntry && (
                <AssignPickerModal
                    room={assignEntry.room}
                    hotel={assignEntry.hotel}
                    people={people}
                    onClose={() => setAssignRoomId(null)}
                    onMove={onMove}
                    restoreFocus={focusFallback}
                    env={env}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

function CapacityBar({ pct, full, label, valueText }: { pct: number; full: boolean; label?: string; valueText?: string }) {
    // A progressbar needs a name (axe aria-progressbar-name); without one it is pure decoration.
    const a11y = label
        ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': label, 'aria-valuetext': valueText }
        : { 'aria-hidden': true };
    return (
        <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden" {...a11y}>
            <div className={`h-full rounded-full transition-all duration-500 ${full ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }}></div>
        </div>
    );
}

/** The capacity bar's accessible name and value: «Camas ocupadas» / «3 de 10 camas ocupadas». */
const bedsBar = (tx, occupied: number, beds: number) => ({
    label: tx('explorer.beds.label', 'Camas ocupadas'),
    valueText: tx('explorer.beds.of', '{occ} de {cap} camas ocupadas', { occ: occupied, cap: beds }),
});

function SummaryStrip({ stats, tx, txn, onOpenUnassigned, headingRef }: any) {
    const tile = 'rounded-2xl border border-gray-100 bg-white p-4 shadow-sm';
    const rooms = txn('explorer.hotel.rooms', '{n} habitaciones', '{n} habitación', stats.rooms);
    const hotels = txn('explorer.count.hotels', '{n} hoteles', '{n} hotel', stats.hotels);
    return (
        <div>
            <h4 ref={headingRef} tabIndex={-1} className="sr-only">{tx('explorer.crumb.hotels', 'Hoteles')}</h4>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className={tile}>
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.summary.beds', 'Camas')}</div>
                    <div className="text-2xl font-black text-gray-900 italic tracking-tighter mt-1">{stats.beds}</div>
                    <div className="text-[10px] text-gray-400 font-bold mt-0.5">{tx('explorer.summary.rooms', '{rooms} en {hotels}', { rooms, hotels })}</div>
                </div>
                <div className={tile}>
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.summary.occupied', 'Ocupadas')}</div>
                    <div className="text-2xl font-black text-indigo-600 italic tracking-tighter mt-1">{stats.occupied}</div>
                    <div className="mt-2"><CapacityBar pct={stats.beds > 0 ? Math.min(100, Math.round((stats.occupied / stats.beds) * 100)) : 0} full={stats.beds > 0 && stats.free === 0} {...bedsBar(tx, stats.occupied, stats.beds)} /></div>
                </div>
                <div className={tile}>
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.summary.free', 'Libres')}</div>
                    <div className="text-2xl font-black text-emerald-600 italic tracking-tighter mt-1">{stats.free}</div>
                </div>
                <button
                    type="button"
                    onClick={onOpenUnassigned}
                    className={`${tile} text-left hover:border-amber-300 hover:shadow-md transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-100`}
                >
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.summary.unassigned', 'Sin habitación')}</div>
                    <div className={`text-2xl font-black italic tracking-tighter mt-1 ${stats.unassigned > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{stats.unassigned}</div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-amber-600 mt-0.5">
                        {tx('explorer.summary.unassigned.open', 'Ver la lista')} <i className="fa-solid fa-arrow-right text-[8px]" aria-hidden="true"></i>
                    </div>
                </button>
            </div>
        </div>
    );
}

function HotelCard({ hotel, stats, matching, matchingPool, onOpen, env }: any) {
    const { tx, txn, dnd } = env;
    const full = stats.beds > 0 && stats.free === 0;
    const chips = stats.locations.slice(0, 6);
    const parts = roomsSummaryParts(tx, txn, stats);
    const matchingText = matching == null ? '' : matchingPool
        ? txn('explorer.hotel.matching.pool', '{n} habitaciones del pool', '{n} habitación del pool', matching)
        : txn('explorer.hotel.matching', '{n} habitaciones para la localidad elegida (incluye el pool)', '{n} habitación para la localidad elegida (incluye el pool)', matching);
    // The card is one button: its name carries the occupancy too (its children are presentational).
    const label = [
        tx('explorer.hotel.open.aria', 'Entrar en el hotel {name}', { name: hotel.name }),
        tx('explorer.beds.of', '{occ} de {cap} camas ocupadas', { occ: stats.occupied, cap: stats.beds }),
        stats.rooms === 0
            ? tx('explorer.hotel.no.rooms', 'Este hotel aún no tiene habitaciones. Añádelas en Alojamiento.')
            : `${parts.rooms}, ${parts.full}, ${parts.withFree} ${parts.empty}`,
        matchingText,
    ].filter(Boolean).join('. ');
    // A chip dropped on the card opens the room picker narrowed to this hotel.
    const overKey = `hotel:${hotel.id}`;
    const isOver = dnd.over === overKey && !!dnd.draggedPerson;
    const why = isOver ? dragBlock(dnd.draggedPerson, env.ctx) : null;
    return (
        <button
            type="button"
            data-hotel-card={hotel.id}
            onClick={onOpen}
            onDragOver={dnd.pickOver(overKey)}
            onDragLeave={dnd.leave(overKey)}
            onDrop={dnd.pickDrop(hotel.id)}
            aria-label={label}
            className={`group text-left w-full bg-white rounded-3xl border-2 p-5 sm:p-6 shadow-sm hover:border-indigo-400 hover:shadow-xl transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200 ${isOver ? (why ? 'ring-4 ring-rose-200 border-rose-400' : 'ring-4 ring-indigo-200 border-indigo-400 bg-indigo-50/40') : matching === 0 ? 'border-gray-50 opacity-60' : 'border-gray-100'}`}
        >
            <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-indigo-600 text-2xl shrink-0 group-hover:scale-105 transition-transform">
                    <i className="fa-solid fa-hotel"></i>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-2xl font-black text-gray-900 italic tracking-tighter leading-tight break-words">{hotel.name}</div>
                    {hotel.address && (
                        <div className="text-xs text-gray-500 font-medium mt-1 break-words"><i className="fa-solid fa-location-dot mr-1.5 text-gray-300"></i>{hotel.address}</div>
                    )}
                </div>
            </div>

            <div className="mt-5 space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.beds.label', 'Camas ocupadas')}</span>
                    <span className={`text-sm font-black ${full ? 'text-rose-600' : 'text-gray-900'}`}>{stats.occupied} / {stats.beds}</span>
                </div>
                <CapacityBar pct={stats.pct} full={full} {...bedsBar(tx, stats.occupied, stats.beds)} />
            </div>

            {stats.rooms === 0 ? (
                <p className="mt-4 text-xs text-gray-400 italic">{tx('explorer.hotel.no.rooms', 'Este hotel aún no tiene habitaciones. Añádelas en Alojamiento.')}</p>
            ) : (
                <p className="mt-4 text-xs text-gray-600 font-bold">
                    {parts.rooms}
                    <span className="text-gray-300"> · </span>
                    <span className="text-rose-600">{parts.full}</span>
                    <span className="text-gray-300"> · </span>
                    <span className="text-emerald-600">{parts.withFree}</span>
                    <span className="text-gray-400"> {parts.empty}</span>
                </p>
            )}
            {matching != null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">{matchingText}</p>
            )}

            {(chips.length > 0 || stats.poolRooms > 0) && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                    {chips.map(l => (
                        <span key={l.id} className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-[10px] font-black uppercase tracking-widest max-w-full truncate">
                            <i className="fa-solid fa-map-pin mr-1"></i>{l.name}
                        </span>
                    ))}
                    {stats.locations.length > chips.length && (
                        <span className="px-2 py-1 rounded-lg bg-gray-50 text-gray-500 text-[10px] font-black">+{stats.locations.length - chips.length}</span>
                    )}
                    {stats.poolRooms > 0 && (
                        <span className="px-2 py-1 rounded-lg bg-gray-50 text-gray-500 text-[10px] font-black uppercase tracking-widest">
                            {tx('explorer.hotel.pool.rooms', '{n} en el pool', { n: stats.poolRooms })}
                        </span>
                    )}
                </div>
            )}

            {isOver ? (
                <p className={`mt-5 text-xs font-black text-center py-2 rounded-xl border-2 border-dashed ${why ? 'text-rose-600 border-rose-200' : 'text-indigo-600 border-indigo-200'}`}>
                    {why ? blockText(tx, why) : tx('explorer.hotel.drop', 'Suelta para elegir una habitación de este hotel')}
                </p>
            ) : (
                <div className="mt-5 flex justify-end">
                    <span className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white group-hover:bg-indigo-600 font-black text-[10px] uppercase tracking-widest transition-all">
                        {tx('explorer.hotel.enter', 'Entrar')} <i className="fa-solid fa-arrow-right text-[9px]"></i>
                    </span>
                </div>
            )}
        </button>
    );
}

function RoomBadges({ room, env, large }: any) {
    const { tx, ctx, roomLocName } = env;
    const g = roomGender(room);
    const loc = roomLocName(room);
    const locked = roomLock(room, ctx);
    const size = large ? 'text-[10px] px-2 py-1' : 'text-[9px] px-1.5 py-0.5';
    return (
        <div className="flex flex-wrap items-center gap-1">
            {loc && (
                <span className={`${size} rounded-md bg-indigo-50 text-indigo-700 font-black uppercase tracking-widest max-w-full truncate`} title={loc}>
                    <i className="fa-solid fa-map-pin mr-1"></i>{loc}
                </span>
            )}
            {g !== 'Mixed' && (
                <span className={`${size} rounded-md font-black uppercase tracking-widest ${g === 'F' ? 'bg-pink-50 text-pink-700' : 'bg-blue-50 text-blue-700'}`}>
                    {roomGenderLabel(tx, g)}
                </span>
            )}
            {!!Number(room.is_family) && (
                <span className={`${size} rounded-md bg-amber-50 text-amber-700 font-black uppercase tracking-widest max-w-full truncate`} title={room.family_name || ''}>
                    <i className="fa-solid fa-people-roof mr-1"></i>{tx('explorer.room.family', 'Familiar')}{room.family_name ? ` · ${room.family_name}` : ''}
                </span>
            )}
            {locked && (
                <span className={`${size} rounded-md bg-amber-50 text-amber-700 font-black uppercase tracking-widest`} title={blockText(tx, locked)}>
                    <i className="fa-solid fa-lock mr-1"></i>{tx('explorer.room.locked.badge', 'Bloqueada')}
                </span>
            )}
        </div>
    );
}

function HotelLevel({ hotel, stats, rooms, counts, total, setFilters, clearFilters, onOpenRoom, headingRef, env }: any) {
    const { tx, txn, filters } = env;
    const full = stats.beds > 0 && stats.free === 0;
    const parts = roomsSummaryParts(tx, txn, stats);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const pills = [
        { v: 'all', label: tx('explorer.filter.state.all', 'Todas'), n: counts.all },
        { v: 'free', label: tx('explorer.filter.state.free', 'Con camas libres'), n: counts.free },
        { v: 'full', label: tx('explorer.filter.state.full', 'Llenas'), n: counts.full },
        { v: 'empty', label: tx('explorer.filter.state.empty', 'Vacías'), n: counts.empty },
    ];
    const active = filtersActive(filters);
    // The ✕ and «Limpiar filtros» unmount themselves when clicked: hand focus to the search box so the
    // keyboard user stays in the filter row instead of starting over from the top of the page.
    const focusSearch = () => requestAnimationFrame(() => { if (searchRef.current) searchRef.current.focus(); });
    const clearAll = () => { clearFilters(); focusSearch(); };
    const specificLocation = !!filters.location && filters.location !== POOL_FILTER;
    return (
        <div className="space-y-5">
            {/* Hotel header */}
            <div className="rounded-3xl border border-gray-100 bg-gray-50/40 p-5 sm:p-6">
                <div className="flex flex-col md:flex-row md:items-start gap-4 md:gap-6">
                    <div className="min-w-0 flex-1">
                        <h4 ref={headingRef} tabIndex={-1} className="text-3xl font-black text-gray-900 italic tracking-tighter leading-tight break-words outline-none focus-visible:ring-4 focus-visible:ring-indigo-100 rounded-lg">{hotel.name}</h4>
                        {hotel.address && <p className="text-sm text-gray-500 font-medium mt-1 break-words"><i className="fa-solid fa-location-dot mr-1.5 text-gray-300"></i>{hotel.address}</p>}
                        {stats.locations.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                                {stats.locations.map(l => (
                                    <span key={l.id} className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-[10px] font-black uppercase tracking-widest max-w-full truncate"><i className="fa-solid fa-map-pin mr-1"></i>{l.name}</span>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="md:w-72 shrink-0 space-y-2">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.beds.label', 'Camas ocupadas')}</span>
                            <span className={`text-lg font-black ${full ? 'text-rose-600' : 'text-gray-900'}`}>{stats.occupied} / {stats.beds}</span>
                        </div>
                        <CapacityBar pct={stats.pct} full={full} {...bedsBar(tx, stats.occupied, stats.beds)} />
                        <p className="text-xs text-gray-600 font-bold">
                            {parts.rooms}
                            <span className="text-gray-300"> · </span><span className="text-rose-600">{parts.full}</span>
                            <span className="text-gray-300"> · </span><span className="text-emerald-600">{parts.withFree}</span>
                            <span className="text-gray-400"> {parts.empty}</span>
                        </p>
                    </div>
                </div>
            </div>

            {/* Filters */}
            {total > 0 && (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col sm:flex-row gap-3">
                        <div className="relative flex-1 min-w-0">
                            <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                            <input
                                ref={searchRef}
                                value={filters.q}
                                onChange={e => setFilters({ q: e.target.value })}
                                placeholder={tx('explorer.filter.search', 'Buscar por participante o número de habitación…')}
                                aria-label={tx('explorer.filter.search', 'Buscar por participante o número de habitación…')}
                                className={`${inputCls} pl-9 pr-10 min-h-[44px]`}
                            />
                            {filters.q && (
                                <button type="button" onClick={() => { setFilters({ q: '' }); focusSearch(); }} aria-label={tx('explorer.filter.clear.search', 'Borrar búsqueda')} className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                                    <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                                </button>
                            )}
                        </div>
                        <select
                            value={filters.gender}
                            onChange={e => setFilters({ gender: e.target.value })}
                            aria-label={tx('explorer.filter.gender.label', 'Tipo de habitación')}
                            className="min-h-[44px] border-2 border-gray-100 rounded-xl px-3 py-2 bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                        >
                            <option value="">{tx('explorer.filter.gender.all', 'Hombres, mujeres y mixtas')}</option>
                            <option value="M">{roomGenderLabel(tx, 'M')}</option>
                            <option value="F">{roomGenderLabel(tx, 'F')}</option>
                            <option value="Mixed">{roomGenderLabel(tx, 'Mixed')}</option>
                        </select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tx('explorer.filter.state.label', 'Ocupación')}>
                        {pills.map(p => (
                            <button
                                key={p.v}
                                type="button"
                                aria-pressed={filters.state === p.v}
                                onClick={() => setFilters({ state: p.v })}
                                className={`min-h-[40px] px-3.5 py-2 rounded-xl border-2 text-xs font-black transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200 ${filters.state === p.v ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-100 bg-white text-gray-500 hover:border-indigo-200'}`}
                            >
                                {p.label} <span className="ml-1 text-[10px] opacity-70">{p.n}</span>
                            </button>
                        ))}
                        {active && (
                            <button type="button" onClick={clearAll} className="min-h-[40px] px-3 py-2 rounded-xl text-xs font-bold text-gray-500 hover:text-indigo-700 hover:bg-indigo-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200">
                                <i className="fa-solid fa-filter-circle-xmark mr-1" aria-hidden="true"></i>{tx('explorer.filter.clear', 'Limpiar filtros')}
                            </button>
                        )}
                        <span className="ml-auto text-[11px] font-bold text-gray-400">
                            {txn('explorer.filter.showing', 'Mostrando {shown} de {n} habitaciones', 'Mostrando {shown} de {n} habitación', total, { shown: rooms.length })}
                        </span>
                    </div>
                    {specificLocation && (
                        <p className="text-[11px] text-gray-500 font-medium">
                            <i className="fa-solid fa-circle-info mr-1.5 text-gray-300" aria-hidden="true"></i>
                            {tx('explorer.filter.location.hint', 'Con una localidad elegida se ven sus habitaciones y las del pool, que también puede ocupar; los ocupantes de otras localidades aparecen atenuados.')}
                        </p>
                    )}
                </div>
            )}

            {/* Rooms */}
            {total === 0 ? (
                <div className="text-center py-14 px-6 text-gray-400 bg-gray-50/50 rounded-3xl border-2 border-dashed border-gray-200">
                    <i className="fa-solid fa-door-closed text-3xl mb-3 opacity-40"></i>
                    <p className="text-sm font-bold text-gray-500">{tx('explorer.hotel.no.rooms', 'Este hotel aún no tiene habitaciones. Añádelas en Alojamiento.')}</p>
                </div>
            ) : rooms.length === 0 ? (
                <div className="text-center py-14 px-6 text-gray-400 bg-gray-50/50 rounded-3xl border-2 border-dashed border-gray-200">
                    <i className="fa-solid fa-filter text-2xl mb-3 opacity-40"></i>
                    <p className="text-sm font-bold text-gray-500">{tx('explorer.filter.none', 'Ninguna habitación coincide con los filtros.')}</p>
                    <button type="button" onClick={clearAll} className={`${btnGhost} mt-4`}>{tx('explorer.filter.clear', 'Limpiar filtros')}</button>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-4">
                    {rooms.map(r => <RoomCard key={r.id} room={r} onOpen={() => onOpenRoom(r.id)} env={env} />)}
                </div>
            )}
        </div>
    );
}

function RoomCard({ room, onOpen, env }: any) {
    const { tx, txn, ctx, idx, nameOf, dnd, filters, locNameOf, locationIdOf } = env;
    const s = roomStats(room, idx);
    const occupants = [...occupantsOf(room, idx)].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es', { sensitivity: 'base' }));
    const isOver = dnd.over === `room:${room.id}`;
    const why = isOver && dnd.draggedPerson ? moveBlock(dnd.draggedPerson, room, ctx, idx) : null;
    // The card is one button: its accessible name carries the occupants' names too.
    const label = tx('explorer.room.open.aria', 'Abrir la habitación {n}: {occ} de {cap} camas ocupadas', { n: room.room_number, occ: s.occupied, cap: s.capacity })
        + (occupants.length ? ` — ${occupants.map(nameOf).join(', ')}` : '');
    const ring = isOver && dnd.draggedPerson
        ? (why ? 'ring-4 ring-rose-200 border-rose-400 bg-rose-50/40' : 'ring-4 ring-indigo-200 border-indigo-400 bg-indigo-50/40')
        : s.state === 'full' ? 'border-rose-100 hover:border-rose-300' : 'border-gray-100 hover:border-indigo-300';
    const freeLines = Math.min(s.free, CARD_FREE_LINES_CAP);
    // With a location filter, occupants of other locations stay visible (full information) but muted.
    const locFilter = filters.location && filters.location !== POOL_FILTER ? filters.location : '';
    const onKey = (e: React.KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
    };
    return (
        <div
            role="button"
            tabIndex={0}
            data-room-card={room.id}
            onClick={onOpen}
            onKeyDown={onKey}
            onDragOver={dnd.roomOver(room)}
            onDragLeave={dnd.leave(`room:${room.id}`)}
            onDrop={dnd.roomDrop(room)}
            aria-label={label}
            className={`cursor-pointer rounded-3xl border-2 bg-white p-4 sm:p-5 flex flex-col gap-3 shadow-sm hover:shadow-lg transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200 ${ring}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.room.word', 'Habitación')}</div>
                    <div className="font-black text-2xl text-gray-900 italic tracking-tighter leading-none break-words">{room.room_number}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {room.notes && <i className="fa-solid fa-circle-info text-blue-300" title={room.notes} aria-label={tx('explorer.room.notes', 'Notas')}></i>}
                    <div className={`text-sm font-black whitespace-nowrap ${s.state === 'full' ? 'text-rose-600' : 'text-gray-900'}`}>
                        {s.occupied}<span className="text-gray-300">/</span>{s.capacity}
                    </div>
                </div>
            </div>
            <RoomBadges room={room} env={env} />
            <CapacityBar pct={s.pct} full={s.state === 'full'} {...bedsBar(tx, s.occupied, s.capacity)} />
            <ul className="space-y-1.5 flex-1">
                {occupants.map(p => {
                    const block = dragBlock(p, ctx);
                    const foreign = !!locFilter && String(locationIdOf(p) ?? '') !== locFilter;
                    return (
                        <li
                            key={p.id}
                            draggable={!block}
                            onDragStart={block ? undefined : dnd.start(p)}
                            onDragEnd={dnd.end}
                            title={p.status === 'cancelled'
                                // A cancelled row listed INSIDE a room still holds that bed (board.cancelled says
                                // the opposite: it is the refusal for a cancelled attendee WITHOUT a room).
                                ? tx('explorer.occupant.cancelled', 'Inscripción cancelada: aún ocupa esta cama. Quítala de la habitación para liberarla.')
                                : block ? blockText(tx, block) : tx('explorer.occupant.drag', 'Arrastra para mover')}
                            className={`flex items-start gap-2 text-sm leading-snug rounded-lg px-1.5 py-1 -mx-1.5 ${block ? '' : 'cursor-grab active:cursor-grabbing hover:bg-indigo-50'} ${dnd.dragging === p.id ? 'opacity-40' : ''} ${foreign ? 'opacity-50' : ''}`}
                        >
                            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${genderDot(p.gender)}`} aria-hidden="true"></span>
                            <span className={`font-semibold text-gray-800 break-words min-w-0 ${p.status === 'cancelled' ? 'line-through text-gray-400' : ''}`}>{nameOf(p)}</span>
                            {block === 'board.frozen' && <i className="fa-solid fa-lock text-[10px] text-amber-500 mt-1 shrink-0" aria-hidden="true"></i>}
                            {block === 'board.moving' && <i className="fa-solid fa-spinner fa-spin text-[10px] text-indigo-400 mt-1 shrink-0" aria-hidden="true"></i>}
                            {foreign && <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 mt-0.5 shrink-0 truncate max-w-[7rem]">{locNameOf(p) || tx('board.no.location', 'Sin localidad')}</span>}
                        </li>
                    );
                })}
                {Array.from({ length: freeLines }).map((_, i) => (
                    <li key={`free-${i}`} className="flex items-center gap-2 text-xs text-gray-300 font-bold border border-dashed border-gray-200 rounded-lg px-2 py-1">
                        <i className="fa-solid fa-bed text-[10px]" aria-hidden="true"></i>{tx('explorer.room.free.bed', 'Cama libre')}
                    </li>
                ))}
                {s.free > freeLines && (
                    <li className="text-[11px] font-bold text-gray-400 px-1">{txn('explorer.room.more.free', '+{n} camas libres', '+{n} cama libre', s.free - freeLines)}</li>
                )}
                {s.overbooked && (
                    <li className="text-[11px] font-black text-rose-600 px-1"><i className="fa-solid fa-triangle-exclamation mr-1"></i>{tx('explorer.room.overbooked', 'Sobreocupada')}</li>
                )}
            </ul>
            {isOver && why && <p className="text-[11px] font-black text-rose-600">{blockText(tx, why)}</p>}
        </div>
    );
}

function RoomLevel({ hotel, room, walk, walkingAll, onOpenRoom, onMove, onUnassign, onAssign, headingRef, env }: any) {
    const { tx, txn, ctx, idx, dnd, roomLocName } = env;
    const s = roomStats(room, idx);
    const occupants = [...occupantsOf(room, idx)].sort((a, b) => env.nameOf(a).localeCompare(env.nameOf(b), 'es', { sensitivity: 'base' }));
    const locked = roomLock(room, ctx);
    const locName = roomLocName(room);
    const slots = Math.min(s.free, ROOM_FREE_SLOTS_CAP);
    const isOver = dnd.over === `room:${room.id}`;
    const why = isOver && dnd.draggedPerson ? moveBlock(dnd.draggedPerson, room, ctx, idx) : null;
    const ring = isOver && dnd.draggedPerson ? (why ? 'ring-4 ring-rose-200 bg-rose-50/30' : 'ring-4 ring-indigo-200 bg-indigo-50/30') : '';
    return (
        <div className="space-y-5">
            {/* Room header */}
            <div className="rounded-3xl border border-gray-100 bg-gray-50/40 p-5 sm:p-6 space-y-4">
                <div className="flex flex-col md:flex-row md:items-start gap-4">
                    <div className="min-w-0 flex-1">
                        <h4 ref={headingRef} tabIndex={-1} className="text-3xl sm:text-4xl font-black text-gray-900 italic tracking-tighter leading-tight break-words outline-none focus-visible:ring-4 focus-visible:ring-indigo-100 rounded-lg">
                            {tx('explorer.room.title', 'Habitación {n}', { n: room.room_number })}
                        </h4>
                        <p className="text-sm text-gray-500 font-bold mt-1 break-words"><i className="fa-solid fa-hotel mr-1.5 text-gray-300"></i>{hotel.name}</p>
                        <div className="mt-3"><RoomBadges room={room} env={env} large /></div>
                    </div>
                    <div className="md:w-72 shrink-0 space-y-2">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{tx('explorer.beds.label', 'Camas ocupadas')}</span>
                            <span className={`text-lg font-black ${s.state === 'full' ? 'text-rose-600' : 'text-gray-900'}`}>{s.occupied} / {s.capacity}</span>
                        </div>
                        <CapacityBar pct={s.pct} full={s.state === 'full'} {...bedsBar(tx, s.occupied, s.capacity)} />
                        <p className="text-xs font-bold text-emerald-600">{txn('explorer.room.free.count', '{n} camas libres', '{n} cama libre', s.free)}</p>
                    </div>
                </div>
                {room.notes && (
                    <div className="rounded-2xl bg-blue-50/60 border border-blue-100 px-4 py-3 text-sm text-blue-900 break-words">
                        <span className="text-[9px] font-black uppercase tracking-widest text-blue-400 block mb-0.5">{tx('explorer.room.notes', 'Notas')}</span>
                        {room.notes}
                    </div>
                )}
                {/* Prev / next through the hotel's rooms (respecting the filters). aria-disabled, not
                    disabled: reaching the last room must not disable — and so blur — the focused button. */}
                {walk && walk.total > 1 && (
                    <div className="flex flex-wrap items-center gap-2">
                        <button type="button" aria-disabled={!walk.prev} onClick={() => walk.prev && onOpenRoom(walk.prev.id)} className={`${btnGhost} aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:border-gray-100 aria-disabled:hover:text-gray-600`} title={walk.prev ? undefined : tx('explorer.room.first', 'Es la primera habitación')}>
                            <i className="fa-solid fa-chevron-left text-[9px]" aria-hidden="true"></i> {tx('explorer.room.prev', 'Anterior')}{walk.prev ? ` · ${walk.prev.room_number}` : ''}
                        </button>
                        <span className="text-xs font-bold text-gray-500 px-1">{tx('explorer.room.position', 'Habitación {i} de {n}', { i: walk.index + 1, n: walk.total })}</span>
                        <button type="button" aria-disabled={!walk.next} onClick={() => walk.next && onOpenRoom(walk.next.id)} className={`${btnGhost} aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:border-gray-100 aria-disabled:hover:text-gray-600`} title={walk.next ? undefined : tx('explorer.room.last', 'Es la última habitación')}>
                            {tx('explorer.room.next', 'Siguiente')}{walk.next ? ` · ${walk.next.room_number}` : ''} <i className="fa-solid fa-chevron-right text-[9px]" aria-hidden="true"></i>
                        </button>
                    </div>
                )}
                {walkingAll && (
                    <p className="text-[11px] text-gray-500 font-medium"><i className="fa-solid fa-filter mr-1 text-gray-300"></i>{tx('explorer.room.unfiltered', 'Esta habitación no coincide con los filtros activos: Anterior y Siguiente recorren todas las habitaciones del hotel.')}</p>
                )}
            </div>

            {/* State, in plain words */}
            {locked ? (
                <Notice tone="amber" icon="fa-lock">{withName(tx('explorer.room.locked', 'El hospedaje de la localidad «{name}» está en validación o validado: esta habitación no admite cambios hasta reabrirlo en Localidades.'), locName)}</Notice>
            ) : s.overbooked ? (
                <Notice tone="rose" icon="fa-triangle-exclamation">{tx('explorer.room.overbooked.notice', 'Hay más ocupantes que camas ({occ} / {cap}). Mueve o quita a alguien para corregirlo.', { occ: s.occupied, cap: s.capacity })}</Notice>
            ) : s.occupied === 0 && s.capacity > 0 ? (
                <Notice tone="gray" icon="fa-bed">{tx('explorer.room.empty', 'Nadie duerme aquí todavía. Usa «Asignar participante» en una cama libre o arrastra a alguien desde «Sin asignar».')}</Notice>
            ) : s.free === 0 ? (
                <Notice tone="gray" icon="fa-circle-check">{s.capacity === 0
                    ? tx('explorer.room.no.beds', 'Esta habitación no tiene camas (capacidad 0): no admite participantes.')
                    : tx('explorer.room.full', 'Habitación completa. Para hacer sitio, mueve o quita a alguien.')}</Notice>
            ) : null}
            {!locked && (
                <p className="text-xs text-gray-500 font-medium px-1">
                    <i className={`fa-solid ${locName ? 'fa-map-pin text-indigo-400' : 'fa-layer-group text-gray-300'} mr-1.5`}></i>
                    {locName
                        ? withName(tx('explorer.room.allotted', 'Reservada para la localidad «{name}»: solo admite participantes de esa localidad.'), locName)
                        : tx('explorer.room.pool', 'Habitación del pool: admite participantes de cualquier localidad.')}
                </p>
            )}

            {/* Occupants + free beds; the whole body is a drop target for this room. */}
            <div
                onDragOver={dnd.roomOver(room)}
                onDragLeave={dnd.leave(`room:${room.id}`)}
                onDrop={dnd.roomDrop(room)}
                className={`rounded-3xl transition-all ${ring}`}
            >
                {isOver && dnd.draggedPerson && (
                    <p className={`mb-3 text-xs font-black text-center py-2 rounded-xl border-2 border-dashed ${why ? 'text-rose-600 border-rose-200' : 'text-indigo-600 border-indigo-200'}`}>
                        {why ? blockText(tx, why) : tx('explorer.room.drop.hint', 'Suelta aquí para asignar a esta habitación')}
                    </p>
                )}
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
                    {occupants.map(p => (
                        <OccupantCard key={p.id} person={p} onMove={() => onMove(p)} onUnassign={() => onUnassign(p)} env={env} />
                    ))}
                    {Array.from({ length: slots }).map((_, i) => (
                        <div key={`slot-${i}`} className="rounded-3xl border-2 border-dashed border-gray-200 bg-gray-50/40 p-5 flex flex-col items-center justify-center text-center gap-3 min-h-[10rem]">
                            <div className="w-12 h-12 rounded-2xl bg-white border border-gray-100 flex items-center justify-center text-gray-300 text-xl"><i className="fa-solid fa-bed"></i></div>
                            <div className="text-sm font-black text-gray-400 uppercase tracking-widest">{tx('explorer.room.free.bed', 'Cama libre')}</div>
                            <button
                                type="button"
                                data-assign-bed=""
                                disabled={!!locked}
                                onClick={onAssign}
                                className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-indigo-500/20 transition-all disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none disabled:cursor-not-allowed focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200"
                            >
                                <i className="fa-solid fa-user-plus text-[9px]"></i> {tx('explorer.assign', 'Asignar participante')}
                            </button>
                            {locked && <p className="text-[11px] text-amber-700 font-medium">{blockText(tx, locked)}</p>}
                        </div>
                    ))}
                </div>
                {s.free > slots && (
                    <p className="mt-3 text-xs font-bold text-gray-400 text-center">{txn('explorer.room.more.free', '+{n} camas libres', '+{n} cama libre', s.free - slots)}</p>
                )}
            </div>
        </div>
    );
}

function Notice({ tone, icon, children }: any) {
    const cls = tone === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800'
        : tone === 'rose' ? 'bg-rose-50 border-rose-200 text-rose-800'
            : 'bg-gray-50 border-gray-100 text-gray-600';
    return (
        <div className={`rounded-2xl border px-4 py-3 text-sm font-medium flex items-start gap-3 ${cls}`}>
            <i className={`fa-solid ${icon} mt-0.5 shrink-0`} aria-hidden="true"></i>
            <span className="min-w-0 break-words">{children}</span>
        </div>
    );
}

function InfoRow({ label, children }: any) {
    return (
        <div className="min-w-0">
            <dt className="text-[9px] font-black uppercase tracking-widest text-gray-400">{label}</dt>
            <dd className="text-sm text-gray-800 font-medium break-words">{children}</dd>
        </div>
    );
}

function OccupantCard({ person: p, onMove, onUnassign, env }: any) {
    const { tx, ctx, nameOf, locNameOf, fields, dnd } = env;
    const block = dragBlock(p, ctx);
    const outBlock = unassignBlock(p, ctx);
    const loc = locNameOf(p);
    const status = STATUS_META[String(p.status || 'pending')] || null;
    const pay = PAY_META[String(p.payment_status || 'unpaid')] || null;
    // Values already shown above are not repeated in «Datos del formulario».
    const shown = new Set<string>(nameFields(p, fields).map(f => f.name));
    const fixed = { gender: p.gender, email: p.email, phone: p.phone, document_number: p.document_number, family_group: p.family_group };
    for (const [k, v] of Object.entries(fixed)) if (v !== '' && v != null) shown.add(k);
    const formRows = (fields || []).filter(f => !shown.has(f.name)).map(f => ({ f, v: fieldVal(p, f) })).filter(r => r.v !== '' && r.v != null);
    // Notices say WHY a button is disabled (a cancelled AND frozen attendee gets both).
    const frozen = outBlock === 'board.frozen';
    const moving = !!(ctx.pending && ctx.pending.has(p.id));
    return (
        <article className={`rounded-3xl border-2 bg-white p-5 shadow-sm flex flex-col gap-4 ${p.status === 'cancelled' ? 'border-rose-100' : 'border-gray-100'} ${dnd.dragging === p.id ? 'opacity-50' : ''}`}>
            <header className="flex items-start gap-3">
                <span className={`mt-2 w-3 h-3 rounded-full shrink-0 ${genderDot(p.gender)}`} aria-hidden="true"></span>
                <div className="min-w-0 flex-1">
                    <h5 className={`text-lg font-black text-gray-900 leading-tight break-words ${p.status === 'cancelled' ? 'line-through text-gray-400' : ''}`}>{nameOf(p)}</h5>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {p.gender && <span className="px-2 py-0.5 rounded-md bg-gray-50 text-gray-600 text-[10px] font-black uppercase tracking-widest">{genderLabel(tx, p.gender)}</span>}
                        {status && <span className={`px-2 py-0.5 rounded-md border text-[10px] font-black uppercase tracking-widest ${status.cls}`}>{tx(status.key, status.fallback)}</span>}
                        {pay && <span className={`px-2 py-0.5 rounded-md border text-[10px] font-black uppercase tracking-widest ${pay.cls}`}>{tx(pay.key, pay.fallback)}</span>}
                    </div>
                </div>
                {!block && (
                    <span
                        draggable
                        onDragStart={dnd.start(p)}
                        onDragEnd={dnd.end}
                        title={tx('explorer.occupant.drag', 'Arrastra para mover')}
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-300 hover:text-indigo-600 hover:bg-indigo-50 cursor-grab active:cursor-grabbing shrink-0"
                        aria-hidden="true"
                    >
                        <i className="fa-solid fa-grip-vertical"></i>
                    </span>
                )}
            </header>

            {p.status === 'cancelled' && (
                <Notice tone="rose" icon="fa-ban">{tx('explorer.occupant.cancelled', 'Inscripción cancelada: aún ocupa esta cama. Quítala de la habitación para liberarla.')}</Notice>
            )}
            {frozen && (
                <Notice tone="amber" icon="fa-lock">{withName(tx('explorer.occupant.frozen', 'El hospedaje de la localidad «{name}» está en validación o validado: reábrelo en Localidades para mover a este participante.'), loc || `#${rawLocationId(p)}`)}</Notice>
            )}
            {moving && (
                <Notice tone="gray" icon="fa-spinner fa-spin">{blockText(tx, 'board.moving')}</Notice>
            )}

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                <InfoRow label={tx('explorer.occupant.location', 'Localidad')}>{loc || <span className="text-gray-400">{tx('board.no.location', 'Sin localidad')}</span>}</InfoRow>
                {p.family_group && <InfoRow label={tx('explorer.occupant.family', 'Grupo familiar')}>{p.family_group}</InfoRow>}
                {p.document_number && <InfoRow label={tx('explorer.occupant.document', 'Documento')}>{p.document_number}</InfoRow>}
                {p.email && (
                    <InfoRow label={tx('explorer.occupant.email', 'Correo electrónico')}>
                        <a href={`mailto:${p.email}`} className="text-indigo-600 hover:underline break-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 rounded">{p.email}</a>
                    </InfoRow>
                )}
                {p.phone && (
                    <InfoRow label={tx('explorer.occupant.phone', 'Teléfono')}>
                        <a href={`tel:${String(p.phone).replace(/[^\d+]/g, '')}`} className="text-indigo-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 rounded">{p.phone}</a>
                    </InfoRow>
                )}
                <InfoRow label={tx('explorer.occupant.payment', 'Pago')}>
                    {tx('explorer.occupant.paid.of', '{paid} de {due}', { paid: money(p.amount_paid), due: money(p.total_due) })}
                </InfoRow>
                {p.reg_code && (
                    <InfoRow label={tx('explorer.occupant.code', 'Código de inscripción')}>
                        <span className="font-mono font-black tracking-widest">{p.reg_code}</span>
                    </InfoRow>
                )}
            </dl>
            {p.notes && (
                <div className="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700 break-words">
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 block mb-0.5">{tx('explorer.occupant.notes', 'Notas')}</span>
                    {p.notes}
                </div>
            )}
            {formRows.length > 0 && (
                <div>
                    <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-2">{tx('explorer.occupant.form', 'Datos del formulario')}</div>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
                        {formRows.map(({ f, v }) => <InfoRow key={f.name} label={f.label || f.name}>{String(v)}</InfoRow>)}
                    </dl>
                </div>
            )}

            <footer className="mt-auto flex flex-wrap gap-2 pt-1">
                <button type="button" disabled={!!block} onClick={onMove} className={btnGhost}>
                    <i className="fa-solid fa-right-left text-[9px]"></i> {tx('explorer.move', 'Mover a otra habitación')}
                </button>
                <button type="button" disabled={!!outBlock} onClick={onUnassign} className={`${btnGhost} hover:border-rose-300 hover:text-rose-600`}>
                    <i className="fa-solid fa-user-minus text-[9px]"></i> {tx('explorer.unassign', 'Quitar de la habitación')}
                </button>
            </footer>
        </article>
    );
}

function PersonChip({ person: p, onOptions, env }: any) {
    const { tx, ctx, nameOf, dnd } = env;
    const block = dragBlock(p, ctx);
    const isDragging = dnd.dragging === p.id;
    return (
        <div
            draggable={!block}
            onDragStart={block ? undefined : dnd.start(p)}
            onDragEnd={dnd.end}
            title={block ? blockText(tx, block) : nameOf(p)}
            className={`inline-flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-full border text-xs font-bold max-w-full transition-all select-none ${block
                ? 'bg-gray-50 border-gray-100 text-gray-400 opacity-70 cursor-not-allowed'
                : isDragging
                    ? 'bg-indigo-100 border-indigo-300 text-indigo-700 opacity-50 cursor-grabbing'
                    : 'bg-white border-gray-200 text-gray-700 cursor-grab active:cursor-grabbing hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 shadow-sm'}`}
        >
            <span className={`w-2 h-2 rounded-full shrink-0 ${genderDot(p.gender)}`} aria-hidden="true"></span>
            <span className="truncate">{nameOf(p)}</span>
            {p.family_group && (
                <span className="px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 text-[8px] font-black uppercase tracking-widest truncate max-w-[6rem]" title={p.family_group}>
                    <i className="fa-solid fa-people-roof mr-1"></i>{p.family_group}
                </span>
            )}
            {block === 'board.frozen' && <i className="fa-solid fa-lock text-[8px] text-amber-500" aria-hidden="true"></i>}
            {block === 'board.moving' && <i className="fa-solid fa-spinner fa-spin text-[8px] text-indigo-400" aria-hidden="true"></i>}
            <button
                type="button"
                onClick={e => { e.stopPropagation(); onOptions(p); }}
                title={tx('board.options', 'Opciones de habitación')}
                aria-label={`${tx('board.options', 'Opciones de habitación')}: ${nameOf(p)}`}
                className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-indigo-600 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
                <i className="fa-solid fa-ellipsis text-[10px]"></i>
            </button>
        </div>
    );
}

function UnassignedPanel({ panelRef, searchRef, groups, total, loading, spinner, search, setSearch, collapsedGroups, toggleGroup, open, setOpen, onOptions, env }: any) {
    const { tx, dnd } = env;
    const dropping = dnd.over === 'unassigned' && dnd.draggedPerson && dnd.draggedPerson.room_id != null;
    let rendered = 0; // chips drawn so far, against BOARD_CHIP_CAP
    return (
        <div
            ref={panelRef}
            onDragOver={dnd.unassignedOver}
            onDragLeave={dnd.leave('unassigned')}
            onDrop={dnd.unassignedDrop}
            className={`border-b xl:border-b-0 xl:border-r border-gray-100 p-4 sm:p-6 flex flex-col gap-4 transition-all ${dropping ? 'bg-rose-50/60 ring-4 ring-inset ring-rose-200' : 'bg-gray-50/30'}`}
        >
            {/* Below xl a collapsible section (a real toggle); at xl the panel is always open beside the
                grid, so the toggle is gone (display:none — out of the tab order and the a11y tree) and a
                plain heading takes its place. */}
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="xl:hidden flex items-center justify-between gap-3 text-left min-h-[44px] rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
                <span className="flex items-center gap-2">
                    <i className={`fa-solid fa-chevron-${open ? 'down' : 'right'} text-[9px] text-gray-400`} aria-hidden="true"></i>
                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{tx('board.unassigned', 'Sin asignar')}</span>
                </span>
                <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-black">{groups.total}</span>
            </button>
            <h4 className="hidden xl:flex items-center justify-between gap-3">
                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{tx('board.unassigned', 'Sin asignar')}</span>
                <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-black">{groups.total}</span>
            </h4>
            <div className={`${open ? 'flex' : 'hidden'} xl:flex flex-col gap-4 min-h-0`}>
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                    <input
                        ref={searchRef}
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={tx('board.search', 'Buscar participante…')}
                        aria-label={tx('board.search', 'Buscar participante…')}
                        className={`${inputCls} pl-9 min-h-[44px] text-xs`}
                    />
                </div>
                {dnd.dragging != null && dnd.draggedPerson && dnd.draggedPerson.room_id != null && (
                    <div className="text-[10px] font-bold text-rose-500 uppercase tracking-widest text-center py-2 border-2 border-dashed border-rose-200 rounded-xl">
                        <i className="fa-solid fa-arrow-down mr-1"></i>{tx('board.drop.here', 'Suelta aquí para quitar la habitación')}
                    </div>
                )}
                <div className="space-y-3 xl:max-h-[70vh] xl:overflow-y-auto modern-scrollbar pr-1">
                    {loading && total === 0 && groups.total === 0 ? spinner : groups.total === 0 ? (
                        <div className="text-center py-10 text-gray-300">
                            <i className="fa-solid fa-circle-check text-2xl mb-2 opacity-40"></i>
                            <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{total === 0 ? tx('board.no.unassigned', 'Todos tienen habitación') : tx('board.no.results', 'Sin resultados')}</p>
                        </div>
                    ) : groups.list.map(g => {
                        if (rendered >= BOARD_CHIP_CAP) return null;
                        const collapsed = collapsedGroups.has(g.key);
                        const shown = collapsed ? [] : g.people.slice(0, BOARD_CHIP_CAP - rendered);
                        rendered += shown.length;
                        return (
                            <div key={g.key || '__none'} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => toggleGroup(g.key)}
                                    aria-expanded={!collapsed}
                                    className="w-full flex items-center justify-between gap-2 px-4 py-2.5 min-h-[40px] hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-300"
                                >
                                    <span className="flex items-center gap-2 min-w-0">
                                        <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'down'} text-[8px] text-gray-300`} aria-hidden="true"></i>
                                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-600 truncate">{g.name || tx('board.no.location', 'Sin localidad')}</span>
                                        {g.frozen && <i className="fa-solid fa-lock text-[9px] text-amber-500" title={blockText(tx, 'board.frozen')}></i>}
                                    </span>
                                    <span className="text-[9px] font-black text-gray-400">{g.people.length}</span>
                                </button>
                                {!collapsed && (
                                    <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                                        {shown.map(p => <PersonChip key={p.id} person={p} onOptions={onOptions} env={env} />)}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {groups.total > BOARD_CHIP_CAP && (
                        <p className="text-[10px] text-gray-400 font-medium text-center px-2">
                            {tx('board.showing', 'Mostrando {n} de {total} — usa el buscador', { n: Math.min(BOARD_CHIP_CAP, groups.total), total: groups.total })}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------------

/**
 * Dialog chrome: Esc closes it, Tab / Shift+Tab stay inside it, a press that starts AND ends on the
 * backdrop closes it, and on close focus returns to the control that opened it — or, when that control
 * is gone (the occupant just moved, the free bed just filled), to `restoreFocus()`.
 */
function ModalShell({ title, subtitle, onClose, children, closeLabel, restoreFocus }: any) {
    // The opener is read DURING the first render: an autoFocus input inside the dialog takes focus in
    // React's layout phase (commitHostMount), before any effect could look at document.activeElement.
    const [opener] = useState<HTMLElement | null>(() => (typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null));
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef(onClose);
    const restoreRef = useRef(restoreFocus);
    useEffect(() => { closeRef.current = onClose; restoreRef.current = restoreFocus; });
    // Selecting text in the search box and releasing over the backdrop sends the click to the backdrop
    // (the nearest common ancestor): only a press that also STARTED on the backdrop closes the dialog.
    const downOnBackdrop = useRef(false);
    // What had focus inside the dialog when the effect was last cleaned up: React StrictMode (dev) runs
    // mount → cleanup → mount, and the cleanup's focus restore must not cost the search box its autoFocus.
    const lastInner = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const dialog = dialogRef.current;
        // Branches without a search box (frozen / locked notices, phones): bring focus into the dialog.
        if (dialog && !dialog.contains(document.activeElement)) {
            const again = lastInner.current && lastInner.current.isConnected && dialog.contains(lastInner.current) ? lastInner.current : dialog;
            again.focus({ preventScroll: true });
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); return; }
            const box = dialogRef.current;
            if (e.key !== 'Tab' || !box) return;
            // Focus trap: the page behind the backdrop is out of reach while the dialog is open.
            const list = focusablesIn(box);
            const active = document.activeElement as HTMLElement | null;
            if (list.length === 0) { e.preventDefault(); box.focus(); return; }
            const first = list[0];
            const last = list[list.length - 1];
            const inside = !!active && box.contains(active);
            if (e.shiftKey) {
                if (!inside || active === first || active === box) { e.preventDefault(); last.focus(); }
            } else if (!inside || active === last) {
                e.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            // `dialog` from the closure: in StrictMode's simulated unmount the ref is already detached.
            const active = document.activeElement as HTMLElement | null;
            lastInner.current = dialog && active && dialog.contains(active) ? active : null;
            const back = opener && opener !== document.body && opener.isConnected
                ? opener
                : (restoreRef.current ? restoreRef.current() : null);
            if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
        };
    }, []);
    return (
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-200"
            onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
            onClick={e => {
                const close = downOnBackdrop.current && e.target === e.currentTarget;
                downOnBackdrop.current = false;
                if (close) onClose();
            }}
        >
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden flex flex-col max-h-[92vh] outline-none animate-in zoom-in-95 duration-200">
                <div className="bg-gray-50/50 px-5 sm:px-8 py-5 border-b border-gray-100 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h3 className="font-black text-xl text-gray-900 italic tracking-tighter">{title}</h3>
                        {subtitle && <p className="text-xs text-gray-500 mt-0.5 break-words">{subtitle}</p>}
                    </div>
                    <button type="button" onClick={onClose} aria-label={closeLabel} className="text-gray-400 hover:text-gray-600 transition-colors w-10 h-10 flex items-center justify-center hover:bg-gray-100 rounded-xl shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                        <i className="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
                    </button>
                </div>
                <div className="p-5 sm:p-8 overflow-y-auto modern-scrollbar min-h-0">{children}</div>
            </div>
        </div>
    );
}

/**
 * «Mover a otra habitación» / the «…» on a chip / a chip dropped on a hotel: every hotel's rooms (or
 * one hotel's, with a way back to all), the refused ones with their reason.
 */
function RoomPickerModal({ person, hotels, scopeHotelId, onClose, onMove, restoreFocus, env }: any) {
    const { tx, ctx, idx, nameOf, locNameOf, locById, roomLabel, roomLocName } = env;
    const [busy, setBusy] = useState(false);
    const [q, setQ] = useState('');
    const [scope, setScope] = useState<number | null>(scopeHotelId ?? null);
    const [autoFocusSearch] = useState(prefersAutoFocus);
    const move = async (roomId: number | null) => {
        if (busy) return;
        setBusy(true);
        try {
            const ok = await onMove(person.id, roomId);
            if (ok) onClose();
        } finally {
            setBusy(false);
        }
    };
    const block = dragBlock(person, ctx);
    const outBlock = unassignBlock(person, ctx);
    const frozen = block === 'board.frozen';
    const loc = person.location_id != null ? locById.get(Number(person.location_id)) : null;
    const meta = lodgingStatusMeta(loc?.lodging_status);
    // Accent- and case-insensitive, like every other search of the explorer («senorial» finds «Señorial»).
    const needle = normalizeText(q);
    const scopedHotel = scope == null ? null : hotels.find(h => Number(h.id) === Number(scope)) || null;
    const blocks = (scopedHotel ? [scopedHotel] : hotels).map(h => {
        const hotelHit = !needle || normalizeText(h.name).includes(needle);
        const rooms = sortRooms(h.rooms).filter(r => hotelHit || normalizeText(r.room_number).includes(needle));
        return { h, rooms, hidden: !!needle && rooms.length === 0 };
    });
    const nothingMatches = !!needle && blocks.every(b => b.hidden);
    const subtitle = [nameOf(person), locNameOf(person), person.room_id != null ? roomLabel(person.room_id) : ''].filter(Boolean).join(' · ');
    return (
        <ModalShell title={tx('assign.room', 'Asignar habitación')} subtitle={subtitle} onClose={onClose} restoreFocus={restoreFocus} closeLabel={tx('explorer.close', 'Cerrar')}>
            {frozen ? (
                <div className="p-5 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-4">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0"><i className="fa-solid fa-lock" aria-hidden="true"></i></div>
                    <div>
                        <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest ${meta.cls}`}>{tx(meta.key, meta.fallback)}</span>
                        <p className="text-sm text-amber-800 font-medium leading-relaxed mt-1">
                            {withName(tx('lodging.frozen.notice', 'El hospedaje de la localidad «{name}» está en validación o validado. Reábrelo desde Localidades antes de cambiar la habitación de este participante.'), loc?.name || locNameOf(person))}
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    {person.room_id != null && (
                        <button
                            type="button"
                            disabled={busy || !!outBlock}
                            onClick={() => move(null)}
                            className="w-full mb-4 px-4 py-3 min-h-[44px] rounded-xl border-2 border-dashed border-rose-200 text-rose-600 font-bold text-sm hover:bg-rose-50 transition flex items-center justify-center gap-2 disabled:opacity-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-rose-100"
                        >
                            <i className="fa-solid fa-xmark" aria-hidden="true"></i> {tx('unassign.room', 'Quitar asignación actual')}
                        </button>
                    )}
                    {block === 'board.cancelled' ? (
                        <p className="text-sm text-gray-500 text-center py-4">{blockText(tx, 'board.cancelled')}</p>
                    ) : block === 'board.moving' ? (
                        <p className="text-sm text-gray-500 text-center py-4"><i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>{blockText(tx, 'board.moving')}</p>
                    ) : hotels.length === 0 ? (
                        <div className="text-center py-10 text-gray-400 bg-gray-50 rounded-xl border border-dashed">
                            <i className="fa-solid fa-hotel text-3xl mb-3 opacity-30" aria-hidden="true"></i>
                            <p className="font-medium text-sm">{tx('no.hotels', 'No hay hoteles configurados.')}</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <div className="relative">
                                <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                                <input autoFocus={autoFocusSearch} value={q} onChange={e => setQ(e.target.value)} placeholder={tx('explorer.move.search', 'Buscar hotel o habitación…')} aria-label={tx('explorer.move.search', 'Buscar hotel o habitación…')} className={`${inputCls} pl-9 min-h-[44px]`} />
                            </div>
                            {scopedHotel && hotels.length > 1 && (
                                <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-indigo-700">
                                    <span><i className="fa-solid fa-hotel mr-1.5" aria-hidden="true"></i>{withName(tx('explorer.move.scope', 'Mostrando solo «{name}»'), scopedHotel.name)}</span>
                                    <button type="button" onClick={() => setScope(null)} className="px-2.5 py-1.5 min-h-[36px] rounded-lg border-2 border-indigo-100 hover:border-indigo-300 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                                        {tx('explorer.move.scope.all', 'Ver todos los hoteles')}
                                    </button>
                                </div>
                            )}
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{tx('board.assign.modal.hint', 'Elige una habitación con camas libres')}</p>
                            {nothingMatches ? (
                                <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-2xl border border-dashed border-gray-200" role="status">
                                    <i className="fa-solid fa-magnifying-glass text-2xl mb-2 opacity-40" aria-hidden="true"></i>
                                    <p className="text-sm font-bold text-gray-500">{tx('explorer.move.no.results', 'Ningún hotel ni habitación coincide con la búsqueda.')}</p>
                                </div>
                            ) : blocks.map(({ h, rooms, hidden }) => {
                                if (hidden) return null;
                                return (
                                    <div key={h.id}>
                                        <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">{h.name}</h4>
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                            {rooms.map(r => {
                                                const current = Number(person.room_id) === Number(r.id);
                                                const why = current ? null : dropBlock(person, r, idx);
                                                const rLoc = roomLocName(r);
                                                return (
                                                    <button
                                                        key={r.id}
                                                        type="button"
                                                        disabled={!!why || current || busy}
                                                        onClick={() => move(r.id)}
                                                        className={`px-3 py-2.5 min-h-[44px] rounded-xl border-2 text-left transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-100 ${current
                                                            ? 'border-indigo-500 bg-indigo-50'
                                                            : why
                                                                ? 'border-gray-100 bg-gray-50 cursor-not-allowed'
                                                                : 'border-gray-100 hover:border-emerald-400 hover:bg-emerald-50'}`}
                                                    >
                                                        <div className={`font-black text-sm ${why ? 'text-gray-400' : 'text-gray-900'}`}>{r.room_number}{current && <span className="ml-1 text-[9px] text-indigo-600 uppercase tracking-widest">· {tx('explorer.move.current', 'Actual')}</span>}</div>
                                                        {rLoc && (
                                                            <div className={`text-[9px] font-black uppercase tracking-widest truncate ${why === 'board.room.foreign' ? 'text-rose-500' : 'text-indigo-500'}`}>
                                                                <i className="fa-solid fa-map-pin mr-1" aria-hidden="true"></i>{rLoc}
                                                            </div>
                                                        )}
                                                        <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">{roomStats(r, idx).occupied}/{r.capacity}</div>
                                                        {why && <div className="text-[10px] text-rose-500 font-bold leading-tight mt-0.5">{blockText(tx, why)}</div>}
                                                    </button>
                                                );
                                            })}
                                            {(h.rooms || []).length === 0 && (
                                                <div className="col-span-full text-xs text-gray-400 italic">{tx('no.rooms', 'Sin habitaciones')}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </ModalShell>
    );
}

/** «Asignar participante»: the attendees that can legally take a free bed of this room. */
function AssignPickerModal({ room, hotel, people, onClose, onMove, restoreFocus, env }: any) {
    const { tx, txn, ctx, idx, nameOf, locNameOf, roomLabel, roomLocName } = env;
    const [q, setQ] = useState('');
    const [includePlaced, setIncludePlaced] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [autoFocusSearch] = useState(prefersAutoFocus);
    const listRef = useRef<HTMLUListElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    // The row that was picked leaves the list (that person now sleeps here): where focus continues — the
    // row now at the same position, else the search box — so the next bed can be filled from the keyboard.
    const refocusAt = useRef<number | null>(null);
    const s = roomStats(room, idx);
    const locked = roomLock(room, ctx);
    const candidates = assignCandidates(people, room, ctx, { q, includePlaced, nameOf, extraText: locNameOf });
    const excluded = candidateExclusions(people, room, ctx, includePlaced);
    const rLoc = roomLocName(room);
    const shown = candidates.slice(0, PICKER_CAP);
    useEffect(() => {
        if (refocusAt.current == null) return;
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body || !active.isConnected) {
            const rows = listRef.current ? (Array.from(listRef.current.querySelectorAll('button[data-candidate]')) as HTMLElement[]) : [];
            const target = rows.length ? rows[Math.min(refocusAt.current, rows.length - 1)] : searchInputRef.current;
            if (target) target.focus();
        }
        if (busyId == null) refocusAt.current = null;
    });
    const pick = async (p: any) => {
        if (busyId != null || s.free <= 0) return;
        const freeBefore = s.free;
        refocusAt.current = Math.max(0, shown.findIndex(x => x.id === p.id));
        setBusyId(p.id);
        try {
            const ok = await onMove(p.id, room.id);
            // The last free bed was just taken: nothing left to pick here.
            if (ok && freeBefore - 1 <= 0) onClose();
        } finally {
            setBusyId(null);
        }
    };
    const reasons = [
        excluded.cancelled > 0 && txn('explorer.picker.excluded.cancelled', '{n} cancelados', '{n} cancelado', excluded.cancelled),
        excluded.frozen > 0 && tx('explorer.picker.excluded.frozen', '{n} de localidades en validación', { n: excluded.frozen }),
        excluded.foreign > 0 && tx('explorer.picker.excluded.foreign', '{n} de otras localidades', { n: excluded.foreign }),
        excluded.moving > 0 && tx('explorer.picker.excluded.moving', '{n} con un movimiento en curso', { n: excluded.moving }),
    ].filter(Boolean);
    return (
        <ModalShell
            title={tx('explorer.picker.title', 'Asignar participante')}
            subtitle={tx('explorer.picker.subtitle', '{hotel} · Habitación {n} · {beds}', {
                hotel: hotel.name, n: room.room_number,
                beds: txn('explorer.room.free.count', '{n} camas libres', '{n} cama libre', s.free),
            })}
            onClose={onClose}
            restoreFocus={restoreFocus}
            closeLabel={tx('explorer.close', 'Cerrar')}
        >
            {locked ? (
                <Notice tone="amber" icon="fa-lock">{withName(tx('explorer.room.locked', 'El hospedaje de la localidad «{name}» está en validación o validado: esta habitación no admite cambios hasta reabrirlo en Localidades.'), rLoc)}</Notice>
            ) : s.free <= 0 ? (
                <Notice tone="gray" icon="fa-circle-check">{tx('explorer.room.full', 'Habitación completa. Para hacer sitio, mueve o quita a alguien.')}</Notice>
            ) : (
                <div className="space-y-4">
                    {rLoc && <p className="text-xs font-bold text-indigo-600"><i className="fa-solid fa-map-pin mr-1.5" aria-hidden="true"></i>{withName(tx('explorer.picker.only.location', 'Solo participantes de «{name}»'), rLoc)}</p>}
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                        <input ref={searchInputRef} autoFocus={autoFocusSearch} value={q} onChange={e => setQ(e.target.value)} placeholder={tx('explorer.picker.search', 'Buscar por nombre, grupo familiar o localidad…')} aria-label={tx('explorer.picker.search', 'Buscar por nombre, grupo familiar o localidad…')} className={`${inputCls} pl-9 min-h-[44px]`} />
                    </div>
                    <label className="flex items-start gap-2.5 text-sm text-gray-600 font-medium cursor-pointer select-none">
                        <input type="checkbox" checked={includePlaced} onChange={e => setIncludePlaced(e.target.checked)} className="mt-0.5 w-4 h-4 accent-indigo-600" />
                        <span>{tx('explorer.picker.include.placed', 'Incluir a quienes ya tienen otra habitación (se moverán aquí)')}</span>
                    </label>
                    {shown.length === 0 ? (
                        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                            <i className="fa-solid fa-user-slash text-2xl mb-2 opacity-40" aria-hidden="true"></i>
                            <p className="text-sm font-bold text-gray-500">{q.trim() ? tx('explorer.picker.no.results', 'Nadie coincide con la búsqueda.') : tx('explorer.picker.empty', 'No hay participantes que puedan ocupar esta cama.')}</p>
                        </div>
                    ) : (
                        <ul ref={listRef} className="divide-y divide-gray-50 rounded-2xl border border-gray-100 overflow-hidden">
                            {shown.map(p => (
                                <li key={p.id}>
                                    {/* aria-disabled while a pick is in flight (not disabled: that would blur the
                                        focused row and drop the keyboard user on <body>). */}
                                    <button
                                        type="button"
                                        data-candidate=""
                                        aria-disabled={busyId != null}
                                        aria-busy={busyId === p.id}
                                        onClick={() => pick(p)}
                                        className="w-full text-left px-4 py-3 min-h-[52px] flex items-center gap-3 hover:bg-emerald-50 transition-colors aria-disabled:opacity-60 aria-disabled:cursor-wait focus:outline-none focus-visible:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300"
                                    >
                                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${genderDot(p.gender)}`} aria-hidden="true"></span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-black text-gray-900 break-words">{nameOf(p)}</span>
                                            <span className="block text-[11px] text-gray-500 font-medium break-words">
                                                {[locNameOf(p) || tx('board.no.location', 'Sin localidad'), p.family_group ? `${tx('explorer.occupant.family', 'Grupo familiar')}: ${p.family_group}` : '']
                                                    .filter(Boolean).join(' · ')}
                                            </span>
                                            {p.room_id != null && (
                                                <span className="block text-[11px] text-indigo-600 font-bold">{tx('explorer.picker.now.in', 'Ahora en {room}', { room: roomLabel(p.room_id) })}</span>
                                            )}
                                            {genderMismatch(room, p) && (
                                                <span className="block text-[11px] text-amber-700 font-bold"><i className="fa-solid fa-triangle-exclamation mr-1" aria-hidden="true"></i>
                                                    {roomGender(room) === 'F' ? tx('explorer.picker.gender.F', 'Esta habitación es de mujeres') : tx('explorer.picker.gender.M', 'Esta habitación es de hombres')}</span>
                                            )}
                                        </span>
                                        {busyId === p.id
                                            ? <i className="fa-solid fa-spinner fa-spin text-indigo-500" aria-hidden="true"></i>
                                            : <i className="fa-solid fa-plus text-emerald-500" aria-hidden="true"></i>}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {candidates.length > PICKER_CAP && (
                        <p className="text-[11px] text-gray-400 text-center">{tx('board.showing', 'Mostrando {n} de {total} — usa el buscador', { n: PICKER_CAP, total: candidates.length })}</p>
                    )}
                    {reasons.length > 0 && (
                        <p className="text-[11px] text-gray-500"><i className="fa-solid fa-circle-info mr-1 text-gray-300" aria-hidden="true"></i>{tx('explorer.picker.excluded', 'No aparecen:')} {reasons.join(' · ')}.</p>
                    )}
                </div>
            )}
        </ModalShell>
    );
}
