"use client";

/**
 * The coordinator's lodging EXPLORER: Hoteles › <Hotel> › Habitación <n>.
 *
 * Level 1 lists the hotels (derived from the rooms' `hotel_name`) as large cards with their numbers;
 * level 2 opens one hotel with filters and room cards big enough to read every occupant's full name;
 * level 3 opens one room with a full card per occupant (every conference field), one slot per free bed
 * and «Anterior / Siguiente» to walk the hotel's rooms. A breadcrumb bar sticks under the portal's
 * header so it is always in reach; «Volver» and `Esc` go one level up, `←` / `→` walk the rooms (never
 * while typing or with a modal open).
 *
 * Writes go through the tab's ONE assign call (`onAssign` = POST /portal/lodging/assign → reload), so
 * the drag & drop, the room picker, the free-bed picker and «Quitar» all share its sequencing, its
 * error toasts (the server's message) and the tab's edit gate. Nothing here talks to the network.
 *
 * Where the user was (hotel, room, occupancy filter — never the search text or gender filter) is remembered in sessionStorage — never in the history
 * (the portal runs inside the app router, which hard-reloads on foreign history states) — together
 * with the rooms it belongs to, so another location's coordinator in the same browser tab never
 * inherits it (see `restoreExplorerNav`). A position whose room or hotel disappears is forgotten.
 *
 * LAYOUT. The portal caps its page at max-w-5xl and, at xl, the «Sin habitación» panel sits beside the
 * content column — so the content is NARROWER at xl than at lg. Every inner grid is therefore sized by
 * the content column (container queries: `@container` + `@md:` …), never by the viewport.
 *
 * FOCUS. Keyboard and screen-reader users never lose their place: entering a level focuses its heading;
 * going back focuses the card of the room / hotel just left; «Anterior / Siguiente» stay focusable at
 * the ends (aria-disabled); after a picker or a confirm closes, the control that opened it gets the focus
 * back — or, when the action made it disappear, the level heading (or the panel, for the panel's own).
 *
 * Every sub-component is defined at module level: a component declared inside another is a new type
 * on every render, which remounts its subtree and steals the focus from the input being typed in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    attendeeName,
    dragDecision,
    parseDragId,
    roomLabel,
    roomsWithSpace,
    type DragRefusal,
    type LodgingAttendee,
    type LodgingField,
    type LodgingRoom,
    type LodgingSummary,
} from "./lodging";
import {
    assignCandidates,
    DEFAULT_FILTERS,
    EMPTY_NAV,
    explorerKeyAction,
    fieldEntries,
    filterAttendees,
    filterRooms,
    filtersActive,
    findAttendee,
    GENDER_FILTER_LABELS,
    GENDER_FILTERS,
    genderKey,
    genderLabel,
    groupRoomsByHotel,
    hotelStats,
    isTypingTarget,
    moveTargets,
    navOwner,
    navRecord,
    normalizeExplorerNav,
    OCCUPANCY_FILTERS,
    OCCUPANCY_LABELS,
    occupancyCounts,
    parseExplorerNav,
    plural,
    resolveExplorerNav,
    restoreExplorerNav,
    roomGender,
    roomNeighbours,
    roomOccupants,
    roomOfAttendee,
    roomPhrase,
    roomPickerView,
    roomStats,
    type AssignCandidate,
    type ExplorerNav,
    type GenderFilter,
    type HotelGroup,
    type OccupancyFilter,
    type RoomFilters,
    type RoomNeighbours,
    type RoomStats,
} from "./lodgingView";
import { Badge, Button, Card, captionCls, cx, EmptyState, headingCls, inputCls, labelCls, Modal, Notice } from "./ui";

/** What a drop target shows while a chip hovers it: `dragDecision`'s verdict flattened to one word. */
type DropVerdict = 'ok' | DragRefusal;

/** The tab's confirm modal (same shape as LodgingTab's own `Confirm`). */
export type ExplorerConfirm = {
    title: string;
    text: string;
    okLabel: string;
    danger?: boolean;
    onOk: () => void;
    /** The control that asked: a cancel gives it the focus back (the dialog itself does not). */
    returnFocus?: HTMLElement | null;
};

type Picker = { kind: 'room'; attendeeId: number } | { kind: 'candidates'; roomId: number };

type Dragging = { id: number; fromRoomId: number | null };

/** Where the focus goes once a picker / confirm is done: the control that opened it, else the fallback. */
type FocusReturn = { el: HTMLElement | null; fallback: 'heading' | 'panel' };

type WalkFrom = 'top' | 'bottom';

export type LodgingExplorerProps = {
    rooms: LodgingRoom[];
    unassigned: LodgingAttendee[];
    fields: LodgingField[];
    /** The tab's numbers (the server's audit wins over client counts). */
    summary: LodgingSummary;
    /** The tab's edit gate (draft AND can_edit): false = read-only, explained by `readOnlyReason`. */
    editable: boolean;
    readOnlyReason: string | null;
    /** A request of the tab is in flight: every write control waits. */
    busy: boolean;
    /** The tab's assign call (POST /portal/lodging/assign, then the sequenced reload); true when the server accepted it. */
    onAssign: (inscriptionId: number, roomId: number | null) => Promise<boolean>;
    /** Opens the tab's confirm modal. */
    onConfirm: (c: ExplorerConfirm) => void;
    notify: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
    /**
     * Scopes the remembered position in sessionStorage (e.g. `${conference_id}:${location_id}`). Without
     * it the position is still tied to this payload's rooms, so it is never handed to another location.
     */
    storageScope?: string;
    /** Start at this position instead of the remembered one (tests, deep links). */
    initialNav?: Partial<ExplorerNav>;
};

const STORAGE_PREFIX = 'cm.portal.lodging.explorer.v2';
const storageKeyOf = (scope?: string): string => (scope ? `${STORAGE_PREFIX}:${scope}` : STORAGE_PREFIX);

const readStoredNav = (key: string, owner: readonly number[]): ExplorerNav => {
    if (typeof window === 'undefined') return { ...EMPTY_NAV };
    try { return restoreExplorerNav(window.sessionStorage.getItem(key), owner); } catch { return { ...EMPTY_NAV }; }
};

const writeStoredNav = (key: string, nav: ExplorerNav, owner: readonly number[]): void => {
    try { window.sessionStorage.setItem(key, JSON.stringify(navRecord(nav, owner))); } catch { /* private mode / blocked storage: memory only */ }
};

/** Free-bed placeholders drawn on a level-2 room card before collapsing into «+N camas libres más». */
const CARD_FREE_SLOTS = 6;
/** Free-bed / unlisted-bed slots drawn on the room view (a dormitory of 30 would otherwise be a wall of identical slots). */
const ROOM_VIEW_SLOTS = 8;

/** Visible keyboard focus for the custom clickable surfaces (the ui.tsx buttons keep the browser's own ring). */
const focusRing = "outline-none focus-visible:ring-4 focus-visible:ring-blue-300/70";
/** A button that stays focusable while it cannot act (aria-disabled), so the focus is never dropped to <body>. */
const softDisabled = "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
/**
 * The breadcrumb bar sticks right under the portal's own sticky header (page.tsx: `py-3` around a 36px
 * row + a 1px border = 61px), so «Volver» and the crumbs stay in reach on a long room view.
 */
const stickyBar = "sticky top-[61px] z-20";
/** Anything scrolled to (level headings, the panel) clears both sticky bars. */
const scrollMargin = "scroll-mt-40";

// ---------------------------------------------------------------------------------------------------
// Focus helpers (browser only — called from effects and handlers, never while rendering)
// ---------------------------------------------------------------------------------------------------

const prefersFinePointer = (): boolean => {
    try { return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches; } catch { return false; }
};

/** Whether an element can take the focus right now: still in the page, rendered, not disabled. */
const canFocus = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && el.isConnected && !el.matches(':disabled') && el.getClientRects().length > 0;

/**
 * Focuses `el`, scrolling it into view first (`block`, or no scroll at all with null) so it lands below
 * the sticky bars (its scroll margin). False when it cannot take the focus.
 */
const focusInView = (el: Element | null | undefined, block: ScrollLogicalPosition | null = 'nearest'): boolean => {
    if (!canFocus(el)) return false;
    if (block) { try { el.scrollIntoView({ block }); } catch { /* old engines: the focus still scrolls */ } }
    el.focus({ preventScroll: true });
    return true;
};

/**
 * The «Sin habitación» panel's entry point: its search box on a fine pointer (a phone keyboard would
 * cover the list), else the collapsible header below xl, else the panel itself.
 */
const focusPanel = (aside: HTMLElement | null, search: HTMLElement | null, toggle: HTMLElement | null, block: ScrollLogicalPosition | null): void => {
    if (prefersFinePointer() && focusInView(search, block)) return;
    if (focusInView(toggle, block)) return;
    focusInView(aside, block);
};

// ---------------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------------

/** A pink / blue / grey dot; `decorative` when the gender is also written next to it (no double announcement). */
function GenderDot({ gender, className, decorative }: { gender: unknown; className?: string; decorative?: boolean }) {
    const k = genderKey(gender);
    const label = genderLabel(gender) || 'Género sin indicar';
    return (
        <span className={cx("inline-flex shrink-0 items-center", className)} title={decorative ? undefined : label} aria-hidden={decorative ? true : undefined}>
            <span className={cx("w-2.5 h-2.5 rounded-full", k === 'F' ? 'bg-pink-400' : k === 'M' ? 'bg-blue-400' : 'bg-gray-300')} aria-hidden="true"></span>
            {decorative ? null : <span className="sr-only">{label}</span>}
        </span>
    );
}

/** Spans (not divs) so the bar is valid phrasing content inside the hotel card's <button>. */
function CapacityBar({ percent, tone, className, label }: { percent: number; tone: 'full' | 'free' | 'empty'; className?: string; label: string }) {
    return (
        <span
            className={cx("block h-2 w-full bg-gray-100 rounded-full overflow-hidden", className)}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={label}
        >
            <span className={cx("block h-full rounded-full transition-all duration-500", tone === 'full' ? 'bg-rose-500' : 'bg-blue-500')} style={{ width: `${percent}%` }}></span>
        </span>
    );
}

const occupancyTone = (st: RoomStats): 'full' | 'free' | 'empty' => (st.occupancy === 'full' ? 'full' : st.occupancy === 'empty' ? 'empty' : 'free');

const occupancyWord = (st: RoomStats): string => {
    if (st.capacity === 0) return 'Sin camas';
    if (st.occupancy === 'full') return 'Completa';
    if (st.occupancy === 'empty') return 'Vacía';
    return plural(st.free, 'cama libre', 'camas libres');
};

/** Beds the server counts but the coordinator's list does not show: another location's attendee or a cancelled inscription. */
const unlistedLine = (n: number): string =>
    (n === 1 ? '1 cama ocupada por alguien que no aparece en tu lista' : `${n} camas ocupadas por personas que no aparecen en tu lista`);

function RoomGenderBadge({ room }: { room: LodgingRoom }) {
    const g = roomGender(room);
    if (g === 'none') return null;
    if (g === 'mixed') return <Badge tone="gray" size="xs" icon="fa-venus-mars">Mixta</Badge>;
    return <Badge tone={g === 'F' ? 'rose' : 'blue'} size="xs" icon={g === 'F' ? 'fa-venus' : 'fa-mars'}>{g === 'F' ? 'Mujeres' : 'Hombres'}</Badge>;
}

function FamilyBadge({ room }: { room: LodgingRoom }) {
    if (!room.is_family) return null;
    return <Badge tone="indigo" size="xs" icon="fa-people-roof">Familiar{room.family_name ? ` · ${String(room.family_name)}` : ''}</Badge>;
}

const initials = (a: LodgingAttendee): string => {
    const parts = [a.first_name, a.last_name].map((v) => String(v ?? '').trim()).filter(Boolean);
    return (parts.map((p) => p.charAt(0)).join('').slice(0, 2) || '#').toUpperCase();
};

// ---------------------------------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------------------------------

function Breadcrumb({ hotel, room, onHome, onHotel }: { hotel: HotelGroup | null; room: LodgingRoom | null; onHome: () => void; onHotel: () => void }) {
    const crumbBtn = cx("rounded-lg px-2 py-1.5 font-black text-blue-600 hover:bg-blue-50 hover:text-blue-700 transition-colors break-words text-left", focusRing);
    const current = "px-2 py-1.5 font-black text-gray-900 break-words";
    const sep = <i className="fa-solid fa-chevron-right text-[9px] text-gray-300 shrink-0" aria-hidden="true"></i>;
    return (
        <nav aria-label="Ruta del hospedaje" className="min-w-0 flex-1" data-testid="lodging-breadcrumb">
            <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
                <li className="flex items-center gap-1 min-w-0">
                    {hotel ? (
                        <button type="button" className={crumbBtn} onClick={onHome}><i className="fa-solid fa-hotel mr-1.5 text-xs" aria-hidden="true"></i>Hoteles</button>
                    ) : (
                        <span className={current} aria-current="page"><i className="fa-solid fa-hotel mr-1.5 text-xs text-blue-500" aria-hidden="true"></i>Hoteles</span>
                    )}
                </li>
                {hotel && (
                    <li className="flex items-center gap-1 min-w-0">
                        {sep}
                        {room ? (
                            <button type="button" className={crumbBtn} onClick={onHotel}>{hotel.name}</button>
                        ) : (
                            <span className={current} aria-current="page">{hotel.name}</span>
                        )}
                    </li>
                )}
                {hotel && room && (
                    <li className="flex items-center gap-1 min-w-0">
                        {sep}
                        <span className={current} aria-current="page">Habitación {String(room.room_number ?? '')}</span>
                    </li>
                )}
            </ol>
        </nav>
    );
}

// ---------------------------------------------------------------------------------------------------
// Level 1 — hotels
// ---------------------------------------------------------------------------------------------------

function SummaryStrip({ rooms, summary, onShowUnassigned }: { rooms: LodgingRoom[]; summary: LodgingSummary; onShowUnassigned: () => void }) {
    const all = hotelStats(rooms);
    const tile = "rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm min-w-0";
    const value = cx("text-2xl leading-none mt-1.5", headingCls);
    return (
        // Five tiles only when the CONTENT column is wide enough (beside the panel at xl it is not).
        <div className="grid grid-cols-2 @3xl:grid-cols-5 gap-3" data-testid="lodging-summary">
            <div className={tile}>
                <div className={captionCls}>Habitaciones</div>
                <div className={value}>{summary.rooms}</div>
            </div>
            <div className={tile}>
                <div className={captionCls}>Camas ocupadas</div>
                <div className={value}>{all.occupied}<span className="text-gray-500 text-lg"> / {summary.beds}</span></div>
            </div>
            <div className={tile}>
                <div className={captionCls}>Camas libres</div>
                <div className={cx(value, summary.free === 0 && 'text-rose-600')}>{summary.free}</div>
            </div>
            <div className={tile}>
                <div className={captionCls}>Alojados</div>
                <div className={value}>{summary.placed}</div>
            </div>
            <button
                type="button"
                onClick={onShowUnassigned}
                className={cx(tile, "col-span-2 @3xl:col-span-1 text-left transition-all hover:border-amber-300 hover:bg-amber-50/40", focusRing)}
                data-testid="lodging-summary-unassigned"
            >
                <span className={cx(captionCls, "block")}>Sin habitación</span>
                {/* Wraps instead of overflowing when the tile is narrow (the count can be 3 digits). */}
                <span className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
                    <span className={cx(value, "block", summary.unplaced > 0 ? 'text-amber-600' : '')}>{summary.unplaced}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-blue-600">Ver lista <i className="fa-solid fa-arrow-right text-[9px]" aria-hidden="true"></i></span>
                </span>
            </button>
        </div>
    );
}

function HotelCard({ hotel, onOpen }: { hotel: HotelGroup; onOpen: () => void }) {
    const s = hotelStats(hotel.rooms);
    const full = s.beds > 0 && s.free === 0;
    const rooms = plural(s.rooms, 'habitación', 'habitaciones');
    const people = plural(s.people, 'participante alojado', 'participantes alojados');
    // The three chips are a partition of the rooms (llenas + parcialmente ocupadas + vacías = total).
    const breakdown = [plural(s.full, 'llena', 'llenas'), plural(s.partial, 'parcialmente ocupada', 'parcialmente ocupadas'), plural(s.empty, 'vacía', 'vacías')];
    return (
        <button
            type="button"
            onClick={onOpen}
            className={cx("group relative w-full text-left bg-white rounded-[32px] border-2 border-gray-50 shadow-sm hover:border-blue-500 hover:shadow-2xl transition-all duration-300 overflow-hidden p-6 sm:p-7 flex flex-col gap-5", focusRing)}
            // Starts with the visible name and carries every number the card shows (the name replaces the content).
            aria-label={`${hotel.name}: ${s.occupied} de ${s.beds} camas ocupadas; ${rooms} (${breakdown.join(', ')}); ${people}. Entrar`}
            data-nav-hotel={hotel.key}
            data-testid={`lodging-hotel-${hotel.key || 'sin-nombre'}`}
        >
            <span className="absolute top-0 right-0 w-48 h-48 bg-gradient-to-br from-blue-50 to-transparent rounded-bl-[80px] opacity-60 pointer-events-none" aria-hidden="true"></span>
            <span className="relative flex items-start gap-4">
                <span className="w-14 h-14 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl shadow-inner flex items-center justify-center text-blue-600 text-2xl shrink-0 group-hover:scale-110 transition-transform duration-300" aria-hidden="true">
                    <i className="fa-solid fa-hotel"></i>
                </span>
                <span className="min-w-0 flex-1">
                    <span className={cx("block text-2xl leading-tight break-words", headingCls)}>{hotel.name}</span>
                    <span className={cx(captionCls, "block mt-1.5")}>{rooms} · {people}</span>
                </span>
            </span>
            <span className="relative block space-y-2">
                <span className="flex items-end justify-between gap-3">
                    <span className="text-xs font-black uppercase tracking-widest text-gray-500">Camas ocupadas</span>
                    <span className={cx("text-sm font-black whitespace-nowrap", full ? 'text-rose-600' : 'text-gray-900')}>{s.occupied} / {s.beds}</span>
                </span>
                <CapacityBar percent={s.percent} tone={full ? 'full' : 'free'} label={`${s.occupied} de ${s.beds} camas ocupadas`} />
            </span>
            <span className="relative flex flex-wrap items-center gap-2 text-xs font-bold text-gray-600">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-100">{breakdown[0]}</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 border border-blue-100">{breakdown[1]}</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50 text-gray-600 border border-gray-100">{breakdown[2]}</span>
            </span>
            <span className="relative flex justify-end">
                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest shadow-lg shadow-blue-500/30 group-hover:bg-blue-700 transition-colors">
                    Entrar <i className="fa-solid fa-arrow-right text-[9px]" aria-hidden="true"></i>
                </span>
            </span>
        </button>
    );
}

// ---------------------------------------------------------------------------------------------------
// Level 2 — one hotel
// ---------------------------------------------------------------------------------------------------

type ChipDragProps = {
    draggable: boolean;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
};

type DropProps = Partial<Pick<React.HTMLAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>>;

function RoomCard({ room, canDrag, draggingId, chipDragProps, dropProps, ring, onOpen }: {
    room: LodgingRoom;
    canDrag: boolean;
    draggingId: number | null;
    chipDragProps: (attendeeId: number, fromRoomId: number | null) => ChipDragProps;
    dropProps: DropProps;
    ring: string;
    onOpen: () => void;
}) {
    const st = roomStats(room);
    const occ = roomOccupants(room);
    const shownFree = Math.min(st.free, CARD_FREE_SLOTS);
    const num = String(room.room_number ?? '');
    return (
        // The whole card opens the room on click (the occupant rows inside stay draggable); the title
        // button is the keyboard path, carries the accessible name, and takes the focus back when the
        // user returns from this room.
        <div
            className={cx("relative flex flex-col gap-4 p-5 rounded-3xl border-2 bg-white shadow-sm cursor-pointer transition-all duration-300 hover:shadow-xl", st.occupancy === 'full' ? 'border-rose-100 hover:border-rose-300' : 'border-gray-100 hover:border-blue-400', ring)}
            onClick={onOpen}
            data-testid={`lodging-drop-room-${room.id}`}
            {...dropProps}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpen(); }}
                        className={cx("text-left rounded-lg", focusRing)}
                        aria-label={`Hab. ${num}, ${st.occupied} de ${st.capacity} camas ocupadas`}
                        data-nav-room={String(room.id)}
                    >
                        <span className={cx("text-2xl leading-none", headingCls)}>Hab. {num}</span>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <FamilyBadge room={room} />
                        <RoomGenderBadge room={room} />
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={cx("text-sm font-black", st.occupancy === 'full' ? 'text-rose-600' : 'text-gray-900')}>{st.occupied}<span className="text-gray-400">/</span>{st.capacity}</span>
                    <i className="fa-solid fa-chevron-right text-xs text-gray-300" aria-hidden="true"></i>
                </div>
            </div>
            <div className="space-y-1.5">
                <span className={cx("block text-[10px] font-black uppercase tracking-widest", st.occupancy === 'full' ? 'text-rose-600' : 'text-gray-500')}>{occupancyWord(st)}</span>
                <CapacityBar percent={st.percent} tone={occupancyTone(st)} label={`${st.occupied} de ${st.capacity} camas ocupadas`} />
            </div>
            <ul className="space-y-1.5" aria-label={`Ocupantes de la habitación ${num}`}>
                {occ.map((a) => (
                    <li
                        key={a.id}
                        className={cx("flex items-center gap-2 rounded-xl px-2.5 py-2 bg-gray-50 border border-gray-100 min-w-0", canDrag && 'pointer-fine:cursor-grab pointer-fine:select-none', draggingId === Number(a.id) && 'opacity-50')}
                        data-testid={`lodging-chip-${a.id}`}
                        {...chipDragProps(Number(a.id), Number(room.id))}
                    >
                        {canDrag && <i className="fa-solid fa-grip-vertical text-[10px] text-gray-300 shrink-0 pointer-coarse:hidden" aria-hidden="true"></i>}
                        <GenderDot gender={a.gender} />
                        {/* The family group under the name, not beside it: a narrow card keeps the whole name readable. */}
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-bold text-gray-900 break-words">{attendeeName(a)}</span>
                            {a.family_group ? <span className="block text-[11px] font-bold text-amber-700 break-words mt-0.5">Grupo familiar: {String(a.family_group)}</span> : null}
                        </span>
                    </li>
                ))}
                {st.unlisted > 0 && (
                    <li className="flex items-center gap-2 rounded-xl px-2.5 py-2 bg-gray-50 border border-gray-100 text-xs font-bold text-gray-500">
                        <i className="fa-solid fa-user-lock text-gray-400" aria-hidden="true"></i>
                        {unlistedLine(st.unlisted)}
                    </li>
                )}
                {Array.from({ length: shownFree }, (_, i) => (
                    <li key={`free-${i}`} className="flex items-center gap-2 rounded-xl px-2.5 py-2 border-2 border-dashed border-gray-200 text-xs font-bold text-gray-500">
                        <i className="fa-solid fa-bed text-gray-400" aria-hidden="true"></i> Cama libre
                    </li>
                ))}
                {st.free > shownFree && (
                    <li className="text-xs font-bold text-gray-500 px-2.5">+{plural(st.free - shownFree, 'cama libre más', 'camas libres más')}</li>
                )}
                {st.capacity === 0 && st.occupied === 0 && (
                    <li className="text-xs font-bold text-gray-500 italic px-2.5">Esta habitación no tiene camas.</li>
                )}
            </ul>
        </div>
    );
}

function HotelFilters({ filters, counts, total, shown, onChange }: {
    filters: RoomFilters;
    counts: Record<OccupancyFilter, number>;
    total: number;
    shown: number;
    onChange: (patch: Partial<RoomFilters>) => void;
}) {
    const searchId = React.useId();
    const genderId = React.useId();
    const active = filtersActive(filters);
    return (
        <Card className="p-4 sm:p-5 space-y-4" data-testid="lodging-filters">
            <div className="grid grid-cols-1 @xl:grid-cols-[minmax(0,1fr)_14rem] gap-3">
                <div className="space-y-1.5 min-w-0">
                    <label htmlFor={searchId} className={labelCls}>Buscar</label>
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                        <input
                            id={searchId}
                            type="search"
                            className={cx(inputCls, "pl-10")}
                            placeholder="Nombre del participante o número de habitación"
                            value={filters.query}
                            maxLength={100}
                            onChange={(e) => onChange({ query: e.target.value })}
                        />
                    </div>
                </div>
                <div className="space-y-1.5">
                    <label htmlFor={genderId} className={labelCls}>Ocupantes</label>
                    <select id={genderId} className={inputCls} value={filters.gender} onChange={(e) => onChange({ gender: e.target.value as GenderFilter })}>
                        {GENDER_FILTERS.map((g) => <option key={g} value={g}>{GENDER_FILTER_LABELS[g]}</option>)}
                    </select>
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por ocupación">
                {OCCUPANCY_FILTERS.map((o) => (
                    <button
                        key={o}
                        type="button"
                        aria-pressed={filters.occupancy === o}
                        onClick={() => onChange({ occupancy: o })}
                        className={cx(
                            "inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl border-2 text-xs font-black transition-all",
                            filters.occupancy === o ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/30' : 'bg-white border-gray-100 text-gray-600 hover:border-blue-300',
                            focusRing,
                        )}
                    >
                        {OCCUPANCY_LABELS[o]}
                        <span className={cx("px-1.5 py-0.5 rounded-md text-[10px]", filters.occupancy === o ? 'bg-white/20' : 'bg-gray-100 text-gray-500')}>{counts[o]}</span>
                    </button>
                ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-gray-500" aria-live="polite">
                    {active ? `Mostrando ${shown} de ${plural(total, 'habitación', 'habitaciones')}` : plural(total, 'habitación', 'habitaciones')}
                </p>
                {active && (
                    <Button variant="ghost" size="sm" icon="fa-filter-circle-xmark" onClick={() => onChange({ ...DEFAULT_FILTERS })}>Quitar filtros</Button>
                )}
            </div>
        </Card>
    );
}

// ---------------------------------------------------------------------------------------------------
// Level 3 — one room
// ---------------------------------------------------------------------------------------------------

function OccupantCard({ attendee, fields, editable, busy, canDrag, dragging, chipDragProps, roomId, onMove, onRemove }: {
    attendee: LodgingAttendee;
    fields: LodgingField[];
    editable: boolean;
    busy: boolean;
    canDrag: boolean;
    dragging: boolean;
    chipDragProps: (attendeeId: number, fromRoomId: number | null) => ChipDragProps;
    roomId: number;
    onMove: (trigger: HTMLElement) => void;
    onRemove: (trigger: HTMLElement) => void;
}) {
    const name = attendeeName(attendee);
    const k = genderKey(attendee.gender);
    const gender = genderLabel(attendee.gender);
    const entries = fieldEntries(attendee, fields);
    return (
        // A container of its own: the field grid gets more columns as the CARD (not the window) widens.
        <li className={cx("@container bg-white rounded-3xl border border-gray-100 shadow-sm flex flex-col", dragging && 'opacity-50')} data-testid={`lodging-occupant-${attendee.id}`}>
            {/* The header is the drag handle (links and buttons below keep their own pointer). */}
            <div
                className={cx("flex items-start gap-4 p-5 border-b border-gray-50", canDrag && 'pointer-fine:cursor-grab pointer-fine:select-none')}
                data-testid={`lodging-chip-${attendee.id}`}
                {...chipDragProps(Number(attendee.id), roomId)}
            >
                <span className={cx("w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black shrink-0", k === 'F' ? 'bg-pink-50 text-pink-600' : k === 'M' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500')} aria-hidden="true">
                    {initials(attendee)}
                </span>
                <div className="min-w-0 flex-1">
                    <h4 className={cx("text-lg leading-tight break-words", headingCls)}>{name}</h4>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-50 border border-gray-100 text-xs font-bold text-gray-600">
                            <GenderDot gender={attendee.gender} decorative />{gender || 'Género sin indicar'}
                        </span>
                        {attendee.family_group ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-100 text-xs font-bold text-amber-700 max-w-full">
                                <i className="fa-solid fa-people-roof text-[10px]" aria-hidden="true"></i>
                                <span className="break-words min-w-0">Grupo familiar: {String(attendee.family_group)}</span>
                            </span>
                        ) : null}
                    </div>
                </div>
                {canDrag && <i className="fa-solid fa-grip-vertical text-gray-300 shrink-0 mt-1 pointer-coarse:hidden" aria-hidden="true"></i>}
            </div>
            <div className="p-5 flex-1">
                {entries.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">El formulario no tiene más datos de este participante.</p>
                ) : (
                    <dl className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-x-4 gap-y-3">
                        {entries.map((f) => (
                            <div key={f.name} className="min-w-0">
                                <dt className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{f.label}</dt>
                                <dd className="text-sm font-medium text-gray-800 break-words mt-0.5">
                                    {f.href ? (
                                        <a href={f.href} className="text-blue-600 hover:underline font-bold" draggable={false}>
                                            <i className={cx("fa-solid mr-1.5 text-[11px]", f.kind === 'email' ? 'fa-envelope' : 'fa-phone')} aria-hidden="true"></i>{f.value}
                                        </a>
                                    ) : f.value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                )}
            </div>
            {editable && (
                <div className="px-5 pb-5 flex flex-col @md:flex-row gap-2">
                    {/* The accessible names START with the visible text (voice control: «clic Mover a otra habitación»). */}
                    <Button variant="outline" size="md" icon="fa-right-left" onClick={(e) => onMove(e.currentTarget)} disabled={busy} className="flex-1" aria-label={`Mover a otra habitación: ${name}`}>
                        Mover a otra habitación
                    </Button>
                    <Button variant="dangerGhost" size="md" icon="fa-user-minus" onClick={(e) => onRemove(e.currentTarget)} disabled={busy} className="flex-1" aria-label={`Quitar de la habitación: ${name}`}>
                        Quitar de la habitación
                    </Button>
                </div>
            )}
        </li>
    );
}

/**
 * «Anterior / Siguiente». At either end the button is aria-disabled, not disabled: a disabled button
 * that holds the focus drops it to <body> (the walk keeps the focus on the pressed button).
 */
function WalkButtons({ neighbours, from, onWalk, middle }: { neighbours: RoomNeighbours; from: WalkFrom; onWalk: (roomId: number, from: WalkFrom) => void; middle?: React.ReactNode }) {
    const { prev, next } = neighbours;
    return (
        <div className="flex items-center justify-between gap-2" data-walk="">
            <Button
                variant="outline"
                size="md"
                icon="fa-chevron-left"
                aria-disabled={prev ? undefined : true}
                onClick={() => { if (prev) onWalk(Number(prev.id), from); }}
                className={cx("flex-1 sm:flex-none", softDisabled)}
                aria-label={prev ? `Anterior: habitación ${String(prev.room_number ?? '')}` : 'Anterior: no hay más habitaciones'}
            >
                Anterior
            </Button>
            {middle}
            <Button
                variant="outline"
                size="md"
                aria-disabled={next ? undefined : true}
                onClick={() => { if (next) onWalk(Number(next.id), from); }}
                className={cx("flex-1 sm:flex-none", softDisabled)}
                aria-label={next ? `Siguiente: habitación ${String(next.room_number ?? '')}` : 'Siguiente: no hay más habitaciones'}
            >
                Siguiente <i className="fa-solid fa-chevron-right text-[9px]" aria-hidden="true"></i>
            </Button>
        </div>
    );
}

function RoomView({ hotel, room, fields, editable, busy, canDrag, draggingId, chipDragProps, dropProps, ring, neighbours, filtered, headingRef, onWalk, onAssignBed, onMove, onRemove }: {
    hotel: HotelGroup;
    room: LodgingRoom;
    fields: LodgingField[];
    editable: boolean;
    busy: boolean;
    canDrag: boolean;
    draggingId: number | null;
    chipDragProps: (attendeeId: number, fromRoomId: number | null) => ChipDragProps;
    dropProps: DropProps;
    ring: string;
    neighbours: RoomNeighbours;
    filtered: boolean;
    headingRef: React.RefObject<HTMLHeadingElement | null>;
    onWalk: (roomId: number, from: WalkFrom) => void;
    onAssignBed: (trigger: HTMLElement) => void;
    onMove: (attendeeId: number, trigger: HTMLElement) => void;
    onRemove: (attendee: LodgingAttendee, trigger: HTMLElement) => void;
}) {
    const st = roomStats(room);
    const occ = roomOccupants(room);
    const num = String(room.room_number ?? '');
    const shownFree = Math.min(st.free, ROOM_VIEW_SLOTS);
    const shownUnlisted = Math.min(st.unlisted, ROOM_VIEW_SLOTS);
    const position = neighbours.index >= 0 ? `${neighbours.index + 1} de ${neighbours.total}${filtered ? ' (con filtros)' : ''}` : '';
    let state: React.ReactNode = null;
    if (st.capacity === 0) {
        state = <Notice tone="amber" icon="fa-bed">Esta habitación no tiene camas configuradas. Pide al administrador que revise su capacidad.</Notice>;
    } else if (st.occupied > st.capacity) {
        state = <Notice tone="rose" icon="fa-triangle-exclamation">Hay más personas que camas en esta habitación ({st.occupied} para {st.capacity}). Mueve o quita a alguien, o pide al administrador que revise la capacidad.</Notice>;
    } else if (editable && st.occupancy === 'full') {
        state = <Notice tone="blue" icon="fa-circle-info">Habitación completa. Para asignar a otra persona aquí, primero mueve o quita a uno de sus ocupantes.</Notice>;
    } else if (editable && st.occupancy === 'empty') {
        // Touch screens cannot drag (native DnD never starts from a touch): the drag hint is for fine pointers only.
        state = <Notice tone="blue" icon="fa-circle-info">Habitación vacía. Usa «Asignar participante» en una cama libre<span className="hidden pointer-fine:inline"> o arrastra a alguien desde «Sin habitación»</span>.</Notice>;
    }
    return (
        <Card className={cx("transition-all duration-300", ring)} data-testid="lodging-room-view" data-room-view="" {...dropProps}>
            <div className="p-6 sm:p-8 border-b border-gray-50 space-y-5">
                <div className="flex flex-col @3xl:flex-row @3xl:items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h3 ref={headingRef} tabIndex={-1} className={cx("text-3xl sm:text-4xl leading-none outline-none", scrollMargin, headingCls)}>Habitación {num}</h3>
                        <p className="text-sm font-bold text-gray-500 mt-2"><i className="fa-solid fa-hotel mr-1.5 text-xs text-blue-500" aria-hidden="true"></i>{hotel.name}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-3">
                            <FamilyBadge room={room} />
                            <RoomGenderBadge room={room} />
                            {!editable && <Badge tone="amber" size="xs" icon="fa-lock">Solo lectura</Badge>}
                        </div>
                    </div>
                    <div className="flex flex-col items-stretch @3xl:items-end gap-2 shrink-0">
                        <WalkButtons neighbours={neighbours} from="top" onWalk={onWalk} />
                        <p className={cx(captionCls, "text-center @3xl:text-right")}>
                            <span aria-live="polite"><span className="sr-only">Habitación {num}: </span>{position}</span>
                            <span className="hidden pointer-fine:inline"> · ← → para cambiar · Esc para volver</span>
                        </p>
                    </div>
                </div>
                <div className="space-y-2">
                    <div className="flex items-end justify-between gap-3">
                        <span className={cx("text-xs font-black uppercase tracking-widest", st.occupancy === 'full' ? 'text-rose-600' : 'text-gray-500')}>{occupancyWord(st)}</span>
                        <span className="text-sm font-black text-gray-900">{st.occupied} / {st.capacity} camas ocupadas</span>
                    </div>
                    <CapacityBar percent={st.percent} tone={occupancyTone(st)} label={`${st.occupied} de ${st.capacity} camas ocupadas`} />
                </div>
                {state}
                {st.unlisted > 0 && (
                    // The server counts every inscription in the room; the coordinator's list holds only the
                    // location's own active ones — the payload cannot say which of the two the bed is.
                    <Notice tone="amber" icon="fa-user-lock">
                        {st.unlisted === 1
                            ? 'Una cama la ocupa alguien que no aparece en tu lista (de otra localidad o con la inscripción cancelada); solo el administrador puede liberarla.'
                            : `${st.unlisted} camas las ocupan personas que no aparecen en tu lista (de otra localidad o con la inscripción cancelada); solo el administrador puede liberarlas.`}
                    </Notice>
                )}
            </div>
            <div className="p-5 sm:p-8 space-y-6 bg-gray-50/30">
                {occ.length > 0 && (
                    // One occupant per row: the card has room for every field (the grid inside adapts to it).
                    <ul className="space-y-4" aria-label={`Ocupantes de la habitación ${num}`}>
                        {occ.map((a) => (
                            <OccupantCard
                                key={a.id}
                                attendee={a}
                                fields={fields}
                                editable={editable}
                                busy={busy}
                                canDrag={canDrag}
                                dragging={draggingId === Number(a.id)}
                                chipDragProps={chipDragProps}
                                roomId={Number(room.id)}
                                onMove={(trigger) => onMove(Number(a.id), trigger)}
                                onRemove={(trigger) => onRemove(a, trigger)}
                            />
                        ))}
                    </ul>
                )}
                {(shownUnlisted > 0 || shownFree > 0) && (
                    <ul className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-3" aria-label={`Otras camas de la habitación ${num}`}>
                        {Array.from({ length: shownUnlisted }, (_, i) => (
                            <li key={`unlisted-${i}`} className="rounded-2xl border-2 border-gray-100 bg-gray-50 p-4 flex items-center gap-3">
                                <span className="w-10 h-10 rounded-xl bg-white text-gray-400 flex items-center justify-center shrink-0" aria-hidden="true"><i className="fa-solid fa-user-lock"></i></span>
                                <span className="text-sm font-bold text-gray-500">Cama ocupada por alguien que no aparece en tu lista</span>
                            </li>
                        ))}
                        {Array.from({ length: shownFree }, (_, i) => (
                            <li key={`free-${i}`} className="rounded-2xl border-2 border-dashed border-gray-200 bg-white/60 p-4 flex flex-col gap-3" data-testid="lodging-free-bed">
                                <span className="flex items-center gap-3">
                                    <span className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 flex items-center justify-center shrink-0" aria-hidden="true"><i className="fa-solid fa-bed"></i></span>
                                    <span className="text-sm font-black text-gray-500 uppercase tracking-widest">Cama libre</span>
                                </span>
                                {editable && (
                                    <Button size="sm" icon="fa-user-plus" block onClick={(e) => onAssignBed(e.currentTarget)} disabled={busy} aria-label={`Asignar participante a una cama libre de la habitación ${num}`}>
                                        Asignar participante
                                    </Button>
                                )}
                            </li>
                        ))}
                        {st.free > shownFree && (
                            <li className="col-span-full text-sm font-bold text-gray-500 text-center" data-testid="lodging-free-bed-more">
                                y {plural(st.free - shownFree, 'cama libre más', 'camas libres más')}
                            </li>
                        )}
                    </ul>
                )}
            </div>
            {(neighbours.prev || neighbours.next) && (
                // The walk again at the bottom: after reading the last occupant, the next room is right here.
                <div className="px-5 sm:px-8 py-4 border-t border-gray-50" data-testid="lodging-walk-bottom">
                    <WalkButtons
                        neighbours={neighbours}
                        from="bottom"
                        onWalk={onWalk}
                        middle={<span className={cx(captionCls, "hidden sm:inline text-center")} aria-hidden="true">{position}</span>}
                    />
                </div>
            )}
        </Card>
    );
}

// ---------------------------------------------------------------------------------------------------
// Pickers (modals)
// ---------------------------------------------------------------------------------------------------

function CandidateButton({ candidate, busy, onPick }: { candidate: AssignCandidate; busy: boolean; onPick: (c: AssignCandidate) => void }) {
    const a = candidate.attendee;
    const gender = genderLabel(a.gender);
    return (
        <li>
            {/* aria-disabled while a request runs: the pressed button keeps the focus if the server refuses. */}
            <button
                type="button"
                aria-disabled={busy || undefined}
                onClick={() => { if (!busy) onPick(candidate); }}
                className={cx("w-full flex items-center gap-3 px-4 py-3 rounded-2xl border-2 border-gray-100 bg-white text-left hover:border-emerald-400 hover:bg-emerald-50/50 transition-all", softDisabled, focusRing)}
                data-candidate=""
            >
                <GenderDot gender={a.gender} decorative={!!gender} />
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-gray-900 break-words">{attendeeName(a)}</span>
                    <span className="block text-xs font-medium text-gray-500 mt-0.5">
                        {[gender, a.family_group ? `Grupo familiar: ${String(a.family_group)}` : '', candidate.fromRoom ? `Ahora en la ${roomPhrase(candidate.fromRoom)}` : 'Sin habitación'].filter(Boolean).join(' · ')}
                    </span>
                </span>
                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-700 whitespace-nowrap">{candidate.fromRoom ? 'Mover aquí' : 'Asignar'}</span>
            </button>
        </li>
    );
}

/** «Asignar participante» on a free bed: who may take it, searchable; stays open while beds remain. */
function CandidatePicker({ room, hotelName, rooms, unassigned, busy, onPick, onClose }: {
    room: LodgingRoom;
    hotelName: string;
    rooms: LodgingRoom[];
    unassigned: LodgingAttendee[];
    busy: boolean;
    onPick: (attendeeId: number) => Promise<boolean>;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [showElsewhere, setShowElsewhere] = useState(false);
    const [lastPlaced, setLastPlaced] = useState<string | null>(null);
    /** Bumped after a placement: once the reload has landed, the focus moves on to the next thing to do. */
    const [placedTick, setPlacedTick] = useState(0);
    const focusAfterPlace = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    // The Modal focuses its panel on mount (its effect runs before this parent's): move the focus on
    // to the search box afterwards — on a fine pointer only, a phone keyboard would hide the list.
    useEffect(() => { if (prefersFinePointer()) inputRef.current?.focus(); }, []);
    const st = roomStats(room);
    const c = assignCandidates({ roomId: Number(room.id), rooms, unassigned, query });
    const blocked = c.blocked;
    // The candidate just placed has left the list (its button with it): the search box on a fine
    // pointer, else the next candidate — or «Listo» once the room is full.
    useEffect(() => {
        if (!focusAfterPlace.current || busy) return;
        focusAfterPlace.current = false;
        const body = bodyRef.current;
        const done = body?.closest('[role="dialog"]')?.querySelector('[data-picker-done]') ?? null;
        if (blocked !== null) { focusInView(done); return; }
        if (prefersFinePointer() && focusInView(inputRef.current)) return;
        if (!focusInView(body?.querySelector('[data-candidate]'))) focusInView(done);
    }, [placedTick, busy, blocked]);
    const searching = query.trim() !== '';
    const elsewhereOpen = showElsewhere || searching || c.unassigned.length === 0;
    const pick = async (cand: AssignCandidate) => {
        const ok = await onPick(Number(cand.attendee.id));
        if (!ok) return;
        setLastPlaced(attendeeName(cand.attendee));
        focusAfterPlace.current = true;
        setPlacedTick((t) => t + 1);
    };
    const num = String(room.room_number ?? '');
    return (
        <Modal
            size="lg"
            title={`Asignar a la habitación ${num}`}
            subtitle={`${hotelName} · ${plural(st.free, 'cama libre', 'camas libres')}`}
            onClose={onClose}
            testId="lodging-candidate-picker"
            footer={<Button variant="ghost" onClick={onClose} data-picker-done="">Listo</Button>}
        >
            <div ref={bodyRef} className="space-y-6">
                {lastPlaced && (
                    <Notice tone="emerald" icon="fa-circle-check" align="center" role="status">
                        <span className="font-bold">{lastPlaced}</span> ya está en la habitación {num}.{blocked === null ? ' Elige a otra persona para la siguiente cama.' : ''}
                    </Notice>
                )}
                {blocked === 'full' ? (
                    <Notice tone="blue" icon="fa-bed" align="center">La habitación {num} está completa: no quedan camas libres.</Notice>
                ) : blocked === 'unknown' ? (
                    <Notice tone="rose" icon="fa-triangle-exclamation" align="center">Esta habitación ya no está en tu cupo. Cierra y vuelve a la lista de hoteles.</Notice>
                ) : (
                    <>
                        <div className="relative">
                            <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                            <input
                                ref={inputRef}
                                type="search"
                                className={cx(inputCls, "pl-10")}
                                placeholder="Buscar por nombre o grupo familiar"
                                aria-label="Buscar participante"
                                value={query}
                                maxLength={100}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>
                        <section className="space-y-3">
                            <h4 className={labelCls}>Sin habitación ({c.unassigned.length})</h4>
                            {c.unassigned.length === 0 ? (
                                <p className="text-sm text-gray-500">{searching ? 'Nadie sin habitación coincide con la búsqueda.' : 'Todos los participantes de tu localidad tienen habitación.'}</p>
                            ) : (
                                <ul className="space-y-2">
                                    {c.unassigned.map((cand) => <CandidateButton key={cand.attendee.id} candidate={cand} busy={busy} onPick={pick} />)}
                                </ul>
                            )}
                        </section>
                        <section className="space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className={labelCls}>En otras habitaciones ({c.elsewhere.length})</h4>
                                {!elsewhereOpen && c.elsewhere.length > 0 && (
                                    <Button variant="ghost" size="sm" icon="fa-chevron-down" onClick={() => setShowElsewhere(true)}>Mostrar</Button>
                                )}
                            </div>
                            {elsewhereOpen && (c.elsewhere.length === 0 ? (
                                <p className="text-sm text-gray-500">{searching ? 'Nadie de otras habitaciones coincide con la búsqueda.' : 'No hay participantes en otras habitaciones.'}</p>
                            ) : (
                                <ul className="space-y-2">
                                    {c.elsewhere.map((cand) => <CandidateButton key={cand.attendee.id} candidate={cand} busy={busy} onPick={pick} />)}
                                </ul>
                            ))}
                        </section>
                    </>
                )}
            </div>
        </Modal>
    );
}

/**
 * «Mover a otra habitación» / «Elegir habitación»: the rooms that can take the attendee (and the one
 * they are in), searchable; the full ones behind «Mostrar las llenas», each with why it cannot.
 */
function RoomPicker({ attendeeId, hotels, rooms, unassigned, busy, onPick, onClose }: {
    attendeeId: number;
    hotels: HotelGroup[];
    rooms: LodgingRoom[];
    unassigned: LodgingAttendee[];
    busy: boolean;
    onPick: (roomId: number | null) => Promise<boolean>;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [showFull, setShowFull] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (prefersFinePointer()) inputRef.current?.focus(); }, []);
    const attendee = findAttendee(rooms, unassigned, attendeeId);
    const fromRoom = roomOfAttendee(rooms, attendeeId);
    const view = roomPickerView({
        hotels,
        targets: moveTargets({ attendeeId, fromRoomId: fromRoom ? Number(fromRoom.id) : null, rooms, unassigned }),
        query,
        showFull,
    });
    const searching = query.trim() !== '';
    const pick = async (roomId: number | null) => {
        if (busy) return;
        const ok = await onPick(roomId);
        if (ok) onClose();
    };
    return (
        <Modal
            size="lg"
            title={fromRoom ? 'Mover a otra habitación' : 'Elegir habitación'}
            subtitle={attendee ? `${attendeeName(attendee)} · ${fromRoom ? `ahora en la ${roomPhrase(fromRoom)}` : 'sin habitación'}` : undefined}
            onClose={onClose}
            testId="lodging-room-picker"
            footer={<Button variant="ghost" onClick={onClose}>Cancelar</Button>}
        >
            {!attendee ? (
                <Notice tone="amber" icon="fa-circle-info" align="center">Este participante ya no está en la lista de tu localidad.</Notice>
            ) : (
                <>
                    {fromRoom && (
                        <button
                            type="button"
                            aria-disabled={busy || undefined}
                            onClick={() => pick(null)}
                            className={cx("w-full px-4 py-3 rounded-2xl border-2 border-dashed border-rose-200 text-rose-600 font-bold text-sm hover:bg-rose-50 transition flex items-center justify-center gap-2", softDisabled, focusRing)}
                        >
                            <i className="fa-solid fa-user-minus" aria-hidden="true"></i> Quitar de la habitación (queda sin habitación)
                        </button>
                    )}
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                        <input
                            ref={inputRef}
                            type="search"
                            className={cx(inputCls, "pl-10")}
                            placeholder="Número de habitación u hotel"
                            aria-label="Buscar habitación"
                            value={query}
                            maxLength={100}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={captionCls}>{showFull ? 'Todas las habitaciones' : 'Habitaciones con camas libres'}</p>
                        {(showFull || view.hidden > 0) && (
                            <Button variant="ghost" size="sm" icon={showFull ? 'fa-eye-slash' : 'fa-eye'} onClick={() => setShowFull((v) => !v)}>
                                {showFull ? 'Ocultar las llenas' : `Mostrar las llenas (${view.hidden})`}
                            </Button>
                        )}
                    </div>
                    {view.hotels.length === 0 ? (
                        <p className="text-sm text-gray-500">{searching ? 'Ninguna habitación coincide con la búsqueda.' : 'No quedan habitaciones con camas libres.'}</p>
                    ) : (
                        <div className="space-y-6">
                            {view.hotels.map((h) => (
                                <section key={h.key} className="space-y-2">
                                    <h4 className="text-sm font-black text-gray-700 break-words">{h.name} <span className="text-xs font-bold text-gray-500">· {plural(h.free, 'cama libre', 'camas libres')}</span></h4>
                                    <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {h.rooms.map(({ room: r, verdict }) => {
                                            const st = roomStats(r);
                                            const current = verdict === 'same';
                                            const note = verdict === 'ok' ? plural(st.free, 'libre', 'libres') : current ? 'Está aquí' : verdict === 'full' ? 'Llena' : 'No disponible';
                                            const num = String(r.room_number ?? '');
                                            return (
                                                <li key={r.id}>
                                                    <button
                                                        type="button"
                                                        disabled={verdict !== 'ok'}
                                                        aria-disabled={verdict === 'ok' && busy ? true : undefined}
                                                        onClick={() => pick(Number(r.id))}
                                                        className={cx(
                                                            "w-full px-3 py-2.5 rounded-2xl border-2 text-left transition-all disabled:cursor-not-allowed",
                                                            current ? 'border-blue-500 bg-blue-50' : verdict === 'ok' ? 'border-gray-100 bg-white hover:border-emerald-400 hover:bg-emerald-50' : 'border-gray-100 bg-gray-50 opacity-60',
                                                            softDisabled,
                                                            focusRing,
                                                        )}
                                                        aria-label={`Hab. ${num}, ${st.occupied} de ${st.capacity} camas ocupadas, ${note}`}
                                                    >
                                                        <span className="block text-sm font-black text-gray-900">Hab. {num}</span>
                                                        <span className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mt-0.5">{st.occupied}/{st.capacity} · <span className={verdict === 'full' ? 'text-rose-600' : current ? 'text-blue-700' : 'text-emerald-700'}>{note}</span></span>
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            ))}
                        </div>
                    )}
                </>
            )}
        </Modal>
    );
}

// ---------------------------------------------------------------------------------------------------
// The explorer
// ---------------------------------------------------------------------------------------------------

/** The card of the room / hotel the user just left (it takes the focus back on the level above). */
type ReturnTo = { kind: 'room'; id: number } | { kind: 'hotel'; key: string };

export default function LodgingExplorer({
    rooms, unassigned, fields, summary, editable, readOnlyReason, busy, onAssign, onConfirm, notify, storageScope, initialNav,
}: LodgingExplorerProps) {
    const storageKey = storageKeyOf(storageScope);
    const hotels = useMemo(() => groupRoomsByHotel(rooms), [rooms]);
    const owner = useMemo(() => navOwner(rooms), [rooms]);
    // The first position is checked against the payload before anything renders: a stale one never
    // shows, and never counts as a fallback (which would move the focus on page load).
    const [nav, setNav] = useState<ExplorerNav>(() => normalizeExplorerNav(
        initialNav ? parseExplorerNav({ ...EMPTY_NAV, ...initialNav }) : readStoredNav(storageKey, owner),
        hotels,
    ));
    /** Bumped when a reload took the open room or hotel away: the position is forgotten and the focus rescued. */
    const [fallbacks, setFallbacks] = useState(0);
    // Adjusted during render (React's "state from props" pattern): `normalizeExplorerNav` returns the
    // same object when nothing is stale, so this settles in one extra pass.
    const view = normalizeExplorerNav(nav, hotels);
    if (view !== nav) {
        setNav(view);
        setFallbacks((n) => n + 1);
    }
    const [picker, setPicker] = useState<Picker | null>(null);
    /** Below xl the «Sin habitación» panel is a collapsible section above the content (always open at ≥ xl). */
    const [panelOpen, setPanelOpen] = useState(false);
    const [panelQuery, setPanelQuery] = useState('');
    /** Bumped by the «Ver lista» shortcut: the effect below scrolls to and focuses the panel. */
    const [panelFocusTick, setPanelFocusTick] = useState(0);
    const [dragging, setDragging] = useState<Dragging | null>(null);
    const [dropHover, setDropHover] = useState<{ key: string; reason: DropVerdict } | null>(null);
    /** Bumped when a picker / confirm is done: the effect below gives the focus back once the reload has landed. */
    const [focusTick, setFocusTick] = useState(0);
    /** dragenter/dragleave depth per drop target (dragleave fires for every child crossed; WebKit gives no relatedTarget). */
    const dragDepth = useRef(new Map<string, number>());
    /** Adds `delta` to a drop target's depth and returns the new depth (0 removes the entry). */
    const bumpDragDepth = useCallback((key: string, delta: number): number => {
        const depth = (dragDepth.current.get(key) ?? 0) + delta;
        if (depth > 0) dragDepth.current.set(key, depth);
        else dragDepth.current.delete(key);
        return depth;
    }, []);
    const clearDragDepth = useCallback(() => dragDepth.current.clear(), []);
    const rootRef = useRef<HTMLDivElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    const panelSearchRef = useRef<HTMLInputElement>(null);
    const panelToggleRef = useRef<HTMLButtonElement>(null);
    /** Set by a user navigation: the next render's level heading (or `returnTo`'s card) takes the focus. */
    const focusHeading = useRef(false);
    const returnTo = useRef<ReturnTo | null>(null);
    /** The control that opened the current picker, and where the focus goes if it is gone by the end. */
    const pickerReturn = useRef<FocusReturn | null>(null);
    const pendingFocus = useRef<FocusReturn | null>(null);

    const { level, hotel, room } = resolveExplorerNav(view, hotels);
    const filters: RoomFilters = { query: view.query, occupancy: view.occupancy, gender: view.gender };
    const neighbours: RoomNeighbours = hotel && room ? roomNeighbours(hotel.rooms, Number(room.id), filters) : { prev: null, next: null, index: -1, total: 0 };
    const prevId = neighbours.prev ? Number(neighbours.prev.id) : null;
    const nextId = neighbours.next ? Number(neighbours.next.id) : null;
    const hotelKey = hotel ? hotel.key : null;
    const roomId = room ? Number(room.id) : null;
    const canDrag = editable && !busy;

    // A picker only makes sense while the arrangement is editable and its room still exists: a reload
    // that froze the arrangement (deadline, submitted elsewhere) or took the room away closes it —
    // adjusted during render (React's "state from props" pattern), never left dangling to pop up later.
    const pickerValid = picker !== null && editable
        && (picker.kind === 'room' || rooms.some((r) => Number(r.id) === picker.roomId));
    if (picker !== null && !pickerValid) setPicker(null);

    // Remember the position for this tab (a reload or a trip to «Participantes» comes back here), with
    // the rooms it belongs to (another location's coordinator in this tab will not inherit it).
    useEffect(() => { writeStoredNav(storageKey, nav, owner); }, [storageKey, nav, owner]);

    const viewKey = `${level}|${hotelKey ?? ''}|${roomId ?? ''}`;
    useEffect(() => {
        if (!focusHeading.current) return;
        focusHeading.current = false;
        const back = returnTo.current;
        returnTo.current = null;
        if (back && rootRef.current) {
            // Back on the level above: the card of the room / hotel just left, centred in the window.
            const attr = back.kind === 'room' ? 'data-nav-room' : 'data-nav-hotel';
            const want = back.kind === 'room' ? String(back.id) : back.key;
            const card = Array.from(rootRef.current.querySelectorAll(`[${attr}]`)).find((el) => el.getAttribute(attr) === want);
            if (focusInView(card, 'center')) return;
        }
        focusInView(headingRef.current);
    }, [viewKey]);

    // The open room or hotel vanished in a reload: if the focus went down with it, give it to the heading.
    useEffect(() => {
        if (fallbacks === 0) return;
        const active = document.activeElement;
        if (!active || active === document.body) focusInView(headingRef.current);
    }, [fallbacks]);

    // A picker or a confirm is done and its request has landed: the control that opened it gets the
    // focus back, or — when the action made it disappear (the attendee moved away) — the fallback.
    useEffect(() => {
        const ret = pendingFocus.current;
        if (!ret || busy || picker !== null) return;
        pendingFocus.current = null;
        const active = document.activeElement;
        // The user has already moved on to something outside the explorer: leave the focus there.
        if (active && active !== document.body && rootRef.current && !rootRef.current.contains(active)) return;
        if (focusInView(ret.el)) return;
        if (ret.fallback === 'panel') focusPanel(panelRef.current, panelSearchRef.current, panelToggleRef.current, 'nearest');
        else focusInView(headingRef.current);
    }, [focusTick, busy, picker]);

    useEffect(() => {
        if (panelFocusTick === 0) return;
        const aside = panelRef.current;
        if (!aside) return;
        aside.scrollIntoView({ block: 'start', behavior: 'smooth' });
        focusPanel(aside, panelSearchRef.current, panelToggleRef.current, null);
    }, [panelFocusTick]);

    // Keyboard: Esc one level up, ← / → walk the rooms. Capture phase on window, so it runs BEFORE the
    // ui.tsx Modal's own Escape listener (document, bubble) can unmount the dialog — an open dialog
    // (the explorer's pickers or the tab's confirm / rule editor) is therefore always seen and the key
    // is left to it. Typing in a field or choosing in a select never navigates.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target instanceof HTMLElement ? e.target : null;
            const action = explorerKeyAction({
                key: e.key,
                level,
                typing: isTypingTarget(target),
                modalOpen: pickerValid || !!document.querySelector('[aria-modal="true"]') || !!target?.closest('[role="dialog"]'),
                modified: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
                defaultPrevented: e.defaultPrevented,
                composing: e.isComposing,
            });
            if (action === 'up') {
                e.preventDefault();
                focusHeading.current = true;
                returnTo.current = level === 3 && roomId !== null ? { kind: 'room', id: roomId } : hotelKey !== null ? { kind: 'hotel', key: hotelKey } : null;
                setNav((n) => (level === 3 ? { ...n, room: null } : { ...n, hotel: null, room: null }));
                return;
            }
            const to = action === 'prev' ? prevId : action === 'next' ? nextId : null;
            if (to === null) return;
            e.preventDefault();
            // A focused «Anterior / Siguiente» keeps the focus (the live caption announces the room); any
            // other control of the room view (an occupant's button or link) is about to disappear, so
            // the new room's heading takes it.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active.closest('[data-room-view]') && !active.closest('[data-walk]')) focusHeading.current = true;
            setNav((n) => ({ ...n, room: to }));
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [level, prevId, nextId, pickerValid, roomId, hotelKey]);

    const openPicker = (p: Picker, trigger: HTMLElement | null, fallback: FocusReturn['fallback']) => {
        pickerReturn.current = { el: trigger, fallback };
        setPicker(p);
    };
    // Stable: ui.tsx's Modal re-runs its focus effect whenever `onClose` changes identity.
    const closePicker = useCallback(() => {
        setPicker(null);
        pendingFocus.current = pickerReturn.current ?? { el: null, fallback: 'heading' };
        pickerReturn.current = null;
        setFocusTick((t) => t + 1);
    }, []);
    const requestFocusBack = (ret: FocusReturn) => {
        pendingFocus.current = ret;
        setFocusTick((t) => t + 1);
    };

    const go = (patch: Partial<ExplorerNav>) => {
        focusHeading.current = true;
        setNav((n) => ({ ...n, ...patch }));
    };
    const goHome = () => {
        if (hotelKey !== null) returnTo.current = { kind: 'hotel', key: hotelKey };
        go({ hotel: null, room: null });
    };
    const goHotel = () => {
        if (roomId !== null) returnTo.current = { kind: 'room', id: roomId };
        go({ room: null });
    };
    /** Entering ANOTHER hotel clears the search (a name typed for one hotel would hide the next one's rooms); the chips stay. */
    const openHotel = (key: string) => {
        focusHeading.current = true;
        setNav((n) => ({ ...n, hotel: key, room: null, query: n.hotel === key ? n.query : '' }));
    };
    const goUp = () => (level === 3 ? goHotel() : goHome());
    /**
     * «Anterior / Siguiente»: the top buttons keep the focus (same level, the live caption announces the
     * room); from the bottom bar the new room starts at its heading, scrolled into view.
     */
    const walkTo = (to: number, from: WalkFrom) => {
        if (from === 'bottom') focusHeading.current = true;
        setNav((n) => ({ ...n, room: to }));
    };
    const setFilters = (patch: Partial<RoomFilters>) => setNav((n) => ({ ...n, ...patch }));
    const showUnassigned = () => { setPanelOpen(true); setPanelFocusTick((t) => t + 1); };

    // ── Drag & drop (native HTML5; touch devices use the pickers — Android Chrome never starts a drag) ──
    // A drop ends in the same single `onAssign` call as every other control; `dragDecision` only paints
    // the hover ring and refuses the obvious client-side, the server re-validates every move.
    const dropKey = (toRoomId: number | null) => (toRoomId == null ? 'unassigned' : `room:${toRoomId}`);
    const decide = (attendeeId: number, fromRoomId: number | null, toRoomId: number | null) =>
        dragDecision({ attendeeId, fromRoomId, toRoomId, rooms, unassigned });

    const chipDragProps = (attendeeId: number, fromRoomId: number | null): ChipDragProps => ({
        draggable: canDrag,
        onDragStart: (e) => {
            if (!canDrag) { e.preventDefault(); return; }
            e.stopPropagation();
            e.dataTransfer.setData('text/plain', String(attendeeId));
            e.dataTransfer.effectAllowed = 'move';
            setDragging({ id: attendeeId, fromRoomId });
        },
        onDragEnd: () => { clearDragDepth(); setDragging(null); setDropHover(null); },
    });

    const dropTargetProps = (toRoomId: number | null): DropProps => (!editable ? {} : {
        onDragEnter: (e) => {
            // Foreign drags (text or a file from outside the tab) are never counted: no dragend would reset them.
            if (!dragging || !canDrag) return;
            e.preventDefault();
            bumpDragDepth(dropKey(toRoomId), 1);
        },
        onDragOver: (e) => {
            if (!dragging || !canDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const key = dropKey(toRoomId);
            const verdict = decide(dragging.id, dragging.fromRoomId, toRoomId);
            const reason: DropVerdict = verdict.ok ? 'ok' : verdict.reason;
            setDropHover((h) => (h && h.key === key && h.reason === reason ? h : { key, reason }));
        },
        onDragLeave: () => {
            const key = dropKey(toRoomId);
            if (bumpDragDepth(key, -1) > 0) return;
            setDropHover((h) => (h && h.key === key ? null : h));
        },
        onDrop: (e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = dragging;
            clearDragDepth();
            setDragging(null);
            setDropHover(null);
            if (!from || !canDrag) return;
            // The state that drove the hover ring is the source of truth; the dataTransfer only
            // cross-checks that the browser delivered OUR chip (not a stale one from another window).
            const id = parseDragId(e.dataTransfer.getData('text/plain'));
            if (id == null || id !== Number(from.id)) return;
            const verdict = decide(from.id, from.fromRoomId, toRoomId);
            if (!verdict.ok) {
                if (verdict.reason === 'full') notify('La habitación está llena.', 'error');
                else if (verdict.reason === 'unknown') notify('No se pudo identificar al participante; vuelve a intentarlo.', 'error');
                return; // `same`: dropped where it already was — nothing to do.
            }
            void onAssign(from.id, toRoomId);
        },
    });

    const hoverOn = (toRoomId: number | null): DropVerdict | null =>
        dropHover && dropHover.key === dropKey(toRoomId) ? dropHover.reason : null;
    /** Blue when the target can take the chip, rose when it refuses, a neutral grey over the chip's own room ('same' is a silent no-op). */
    const dropRing = (toRoomId: number | null): string => {
        const v = hoverOn(toRoomId);
        if (v === null) return '';
        if (v === 'ok') return 'ring-4 ring-blue-400/60';
        if (v === 'same') return 'ring-4 ring-gray-200';
        return 'ring-4 ring-rose-400/60';
    };

    // ── Actions ──
    const askRemove = (a: LodgingAttendee, from: LodgingRoom, trigger: HTMLElement) => onConfirm({
        title: 'Quitar de la habitación',
        text: `${attendeeName(a)} dejará la ${roomPhrase(from)} y quedará en «Sin habitación». ¿Continuar?`,
        okLabel: 'Sí, quitar',
        danger: true,
        returnFocus: trigger,
        // The «Quitar» button leaves with the attendee: once the reload lands, the room's heading takes the focus.
        onOk: () => { void onAssign(Number(a.id), null).then(() => requestFocusBack({ el: trigger, fallback: 'heading' })); },
    });

    // ── «Sin habitación» panel ──
    const panelList = filterAttendees(unassigned, panelQuery);
    const noSpace = roomsWithSpace(rooms).length === 0;
    const draggingFromRoom = !!dragging && dragging.fromRoomId !== null;
    const unassignedHover = hoverOn(null);
    const panel = (
        <aside
            ref={panelRef}
            tabIndex={-1}
            className={cx("bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 overflow-hidden xl:sticky xl:top-36 transition-all duration-300", scrollMargin, editable && 'outline-2 outline-dashed -outline-offset-2', editable && (unassignedHover === 'ok' ? 'outline-blue-500' : unassignedHover === null || unassignedHover === 'same' ? 'outline-gray-200' : 'outline-rose-400'))}
            aria-label="Participantes sin habitación"
            data-testid="lodging-drop-unassigned"
            {...dropTargetProps(null)}
        >
            {/* Below xl: a toggle; at xl the panel is always open and the header is static. */}
            <button
                ref={panelToggleRef}
                type="button"
                onClick={() => setPanelOpen((o) => !o)}
                aria-expanded={panelOpen}
                className={cx("xl:hidden w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors", focusRing)}
            >
                <span className="flex items-center gap-3 min-w-0">
                    <span className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-lg shadow-amber-100 shrink-0" aria-hidden="true"><i className="fa-solid fa-user-clock"></i></span>
                    <span className={cx("text-lg", headingCls)}>Sin habitación</span>
                    <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-black">{unassigned.length}</span>
                </span>
                <i className={cx("fa-solid text-gray-400 text-xs", panelOpen ? 'fa-chevron-up' : 'fa-chevron-down')} aria-hidden="true"></i>
            </button>
            <div className="hidden xl:flex items-center gap-3 px-5 py-4 border-b border-gray-50">
                <span className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-lg shadow-amber-100 shrink-0" aria-hidden="true"><i className="fa-solid fa-user-clock"></i></span>
                <span className={cx("text-lg", headingCls)}>Sin habitación</span>
                <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-black">{unassigned.length}</span>
            </div>
            <div className={cx(panelOpen ? 'block' : 'hidden', "xl:block p-4 space-y-3")}>
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                    <input
                        ref={panelSearchRef}
                        type="search"
                        className={cx(inputCls, "pl-10")}
                        placeholder="Buscar participante…"
                        aria-label="Buscar participante sin habitación"
                        value={panelQuery}
                        maxLength={100}
                        onChange={(e) => setPanelQuery(e.target.value)}
                    />
                </div>
                {draggingFromRoom && (
                    <div className="text-[10px] font-black text-rose-600 uppercase tracking-widest text-center py-2 border-2 border-dashed border-rose-200 rounded-xl">
                        <i className="fa-solid fa-arrow-down mr-1" aria-hidden="true"></i>Suelta aquí para liberar la cama
                    </div>
                )}
                {unassigned.length === 0 ? (
                    <p className="text-sm font-bold text-gray-500 text-center py-6"><i className="fa-solid fa-circle-check text-emerald-500 mr-1.5" aria-hidden="true"></i>Todos los participantes tienen habitación.</p>
                ) : panelList.length === 0 ? (
                    <p className="text-sm font-bold text-gray-500 text-center py-6">Nadie coincide con la búsqueda.</p>
                ) : (
                    // At xl the panel sticks at top-36 (below both sticky bars): the list scrolls inside so the
                    // whole panel, its «Suelta aquí» strip included, stays within the window.
                    <ul className="space-y-2 xl:max-h-[calc(100vh-22rem)] xl:overflow-y-auto pr-1" data-testid="lodging-unassigned">
                        {panelList.map((a) => {
                            const gender = genderLabel(a.gender);
                            return (
                                <li key={a.id} className="rounded-2xl border border-gray-100 bg-gray-50/50 p-3 space-y-2">
                                    {/* The draggable chip is the name block, not the row: the button keeps its own pointer. */}
                                    <div
                                        className={cx("flex items-center gap-2 min-w-0", canDrag && 'pointer-fine:cursor-grab pointer-fine:select-none', dragging?.id === Number(a.id) && 'opacity-50')}
                                        data-testid={`lodging-chip-${a.id}`}
                                        {...chipDragProps(Number(a.id), null)}
                                    >
                                        {canDrag && <i className="fa-solid fa-grip-vertical text-[10px] text-gray-300 shrink-0 pointer-coarse:hidden" aria-hidden="true"></i>}
                                        <GenderDot gender={a.gender} decorative={!!gender} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-black text-gray-900 break-words">{attendeeName(a)}</span>
                                            {(gender || a.family_group) ? (
                                                <span className="block text-xs text-gray-500 mt-0.5">{[gender, a.family_group ? String(a.family_group) : ''].filter(Boolean).join(' · ')}</span>
                                            ) : null}
                                        </span>
                                    </div>
                                    {editable && (
                                        <Button size="sm" variant="outline" icon="fa-bed" block disabled={busy || noSpace} onClick={(e) => openPicker({ kind: 'room', attendeeId: Number(a.id) }, e.currentTarget, 'panel')} aria-label={`Elegir habitación para ${attendeeName(a)}`}>
                                            Elegir habitación
                                        </Button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {editable && unassigned.length > 0 && noSpace && (
                    <Notice tone="rose" icon="fa-bed" className="text-xs">No quedan camas libres en tus habitaciones; pide al administrador más habitaciones.</Notice>
                )}
            </div>
        </aside>
    );

    // ── Levels ── (every grid below is sized by the content column: `@container` on its wrapper)
    let content: React.ReactNode;
    if (level === 1 || !hotel) {
        content = (
            <div className="space-y-6">
                <h3 ref={headingRef} tabIndex={-1} className={cx("text-2xl outline-none", scrollMargin, headingCls)}>Hoteles</h3>
                <SummaryStrip rooms={rooms} summary={summary} onShowUnassigned={showUnassigned} />
                <div className="grid grid-cols-1 @2xl:grid-cols-2 gap-5" data-testid="lodging-rooms">
                    {hotels.map((h) => <HotelCard key={h.key} hotel={h} onOpen={() => openHotel(h.key)} />)}
                </div>
            </div>
        );
    } else if (level === 2 || !room) {
        const s = hotelStats(hotel.rooms);
        const shown = filterRooms(hotel.rooms, filters);
        const full = s.beds > 0 && s.free === 0;
        content = (
            <div className="space-y-6">
                <Card className="p-6 sm:p-8 space-y-5">
                    <div className="flex items-start gap-4">
                        <span className="w-14 h-14 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl shadow-inner flex items-center justify-center text-blue-600 text-2xl shrink-0" aria-hidden="true"><i className="fa-solid fa-hotel"></i></span>
                        <div className="min-w-0">
                            <h3 ref={headingRef} tabIndex={-1} className={cx("text-3xl leading-tight break-words outline-none", scrollMargin, headingCls)}>{hotel.name}</h3>
                            <div className="flex flex-wrap gap-2 mt-3 text-xs font-bold">
                                <span className="px-2.5 py-1 rounded-lg bg-gray-50 border border-gray-100 text-gray-600">{plural(s.rooms, 'habitación', 'habitaciones')}</span>
                                <span className="px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-100 text-blue-700">{plural(s.free, 'cama libre', 'camas libres')}</span>
                                <span className="px-2.5 py-1 rounded-lg bg-gray-50 border border-gray-100 text-gray-600">{plural(s.people, 'participante alojado', 'participantes alojados')}</span>
                            </div>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-end justify-between gap-3">
                            <span className="text-xs font-black uppercase tracking-widest text-gray-500">Camas ocupadas</span>
                            <span className={cx("text-sm font-black", full ? 'text-rose-600' : 'text-gray-900')}>{s.occupied} / {s.beds}</span>
                        </div>
                        <CapacityBar percent={s.percent} tone={full ? 'full' : 'free'} label={`${s.occupied} de ${s.beds} camas ocupadas`} />
                    </div>
                </Card>
                <HotelFilters filters={filters} counts={occupancyCounts(hotel.rooms, filters)} total={hotel.rooms.length} shown={shown.length} onChange={setFilters} />
                {shown.length === 0 ? (
                    <EmptyState
                        icon="fa-filter"
                        title="Ninguna habitación coincide con los filtros."
                        action={<Button variant="outline" icon="fa-filter-circle-xmark" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>Quitar filtros</Button>}
                    />
                ) : (
                    <div className="grid grid-cols-1 @xl:grid-cols-2 gap-4" data-testid="lodging-rooms">
                        {shown.map((r) => (
                            <RoomCard
                                key={r.id}
                                room={r}
                                canDrag={canDrag}
                                draggingId={dragging ? dragging.id : null}
                                chipDragProps={chipDragProps}
                                dropProps={dropTargetProps(Number(r.id))}
                                ring={dropRing(Number(r.id))}
                                onOpen={() => go({ room: Number(r.id) })}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    } else {
        const current = Number(room.id);
        content = (
            <RoomView
                hotel={hotel}
                room={room}
                fields={fields}
                editable={editable}
                busy={busy}
                canDrag={canDrag}
                draggingId={dragging ? dragging.id : null}
                chipDragProps={chipDragProps}
                dropProps={dropTargetProps(current)}
                ring={dropRing(current)}
                neighbours={neighbours}
                filtered={filtersActive(filters)}
                headingRef={headingRef}
                onWalk={walkTo}
                onAssignBed={(trigger) => openPicker({ kind: 'candidates', roomId: current }, trigger, 'heading')}
                onMove={(attendeeId, trigger) => openPicker({ kind: 'room', attendeeId }, trigger, 'heading')}
                onRemove={(a, trigger) => askRemove(a, room, trigger)}
            />
        );
    }

    // The picker reads the CURRENT payload on every render (a reload after an assign updates it in place).
    let pickerNode: React.ReactNode = null;
    if (picker && pickerValid) {
        if (picker.kind === 'candidates') {
            const target = rooms.find((r) => Number(r.id) === picker.roomId) || null;
            const targetHotel = target ? hotels.find((h) => h.key === String(target.hotel_name ?? '').trim()) : null;
            pickerNode = target ? (
                <CandidatePicker
                    key={`c-${picker.roomId}`}
                    room={target}
                    hotelName={targetHotel ? targetHotel.name : roomLabel(target)}
                    rooms={rooms}
                    unassigned={unassigned}
                    busy={busy}
                    onPick={(attendeeId) => onAssign(attendeeId, picker.roomId)}
                    onClose={closePicker}
                />
            ) : null;
        } else {
            const attendeeId = picker.attendeeId;
            pickerNode = (
                <RoomPicker
                    key={`r-${attendeeId}`}
                    attendeeId={attendeeId}
                    hotels={hotels}
                    rooms={rooms}
                    unassigned={unassigned}
                    busy={busy}
                    onPick={(to) => onAssign(attendeeId, to)}
                    onClose={closePicker}
                />
            );
        }
    }

    return (
        <div ref={rootRef} className="space-y-5" data-testid="lodging-explorer" data-level={level}>
            <Card className={cx(stickyBar, "px-3 py-2 sm:px-5 sm:py-3 flex flex-wrap items-center gap-2 sm:gap-3")} data-testid="lodging-bar">
                {level > 1 && (
                    <Button variant="outline" icon="fa-arrow-left" onClick={goUp} aria-label={level === 3 && hotel ? `Volver a ${hotel.name}` : 'Volver a los hoteles'} data-testid="lodging-back">
                        Volver
                    </Button>
                )}
                <Breadcrumb hotel={level > 1 ? hotel : null} room={level === 3 ? room : null} onHome={goHome} onHotel={goHotel} />
                {busy && (
                    <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-blue-600" role="status">
                        <span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>Guardando…
                    </span>
                )}
            </Card>
            {!editable && readOnlyReason && (
                <Notice tone="amber" icon="fa-lock" data-testid="lodging-readonly">{readOnlyReason}</Notice>
            )}
            <div className="grid grid-cols-1 xl:grid-cols-[17.5rem_minmax(0,1fr)] gap-5 items-start">
                {panel}
                <div className="@container min-w-0">{content}</div>
            </div>
            {pickerNode}
        </div>
    );
}
