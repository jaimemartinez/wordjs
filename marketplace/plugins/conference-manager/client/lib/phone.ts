// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
/**
 * Phone numbers with their country (conference-manager 2.33.2) — the client's copy of server/phone.js (same
 * list, same rules; a test keeps them equal), plus what the country selector needs: names in the screen's
 * language (Intl.DisplayNames) and flags.
 *
 * A phone field stores E.164, «+<country code><national digits>». A stored number without «+» (older rows, typed
 * before 2.33.2) is read as national in the conference's default country — never rewritten.
 */

export const COUNTRY_CODES = 'US1 CA1 AF93 AX358 AL355 DZ213 AS1 AD376 AO244 AI1 AG1 AR54 AM374 AW297 AU61 AT43 AZ994 BS1 BH973 BD880 BB1 BY375 BE32 BZ501 BJ229 BM1 BT975 BO591 BQ599 BA387 BW267 BR55 IO246 VG1 BN673 BG359 BF226 BI257 KH855 CM237 CV238 KY1 CF236 TD235 CL56 CN86 CX61 CC61 CO57 KM269 CG242 CD243 CK682 CR506 CI225 HR385 CU53 CW599 CY357 CZ420 DK45 DJ253 DM1 DO1 EC593 EG20 SV503 GQ240 ER291 EE372 SZ268 ET251 FK500 FO298 FJ679 FI358 FR33 GF594 PF689 GA241 GM220 GE995 DE49 GH233 GI350 GR30 GL299 GD1 GP590 GU1 GT502 GG44 GN224 GW245 GY592 HT509 HN504 HK852 HU36 IS354 IN91 ID62 IR98 IQ964 IE353 IM44 IL972 IT39 JM1 JP81 JE44 JO962 KZ7 KE254 KI686 XK383 KW965 KG996 LA856 LV371 LB961 LS266 LR231 LY218 LI423 LT370 LU352 MO853 MG261 MW265 MY60 MV960 ML223 MT356 MH692 MQ596 MR222 MU230 YT262 MX52 FM691 MD373 MC377 MN976 ME382 MS1 MA212 MZ258 MM95 NA264 NR674 NP977 NL31 NC687 NZ64 NI505 NE227 NG234 NU683 NF672 KP850 MK389 MP1 NO47 OM968 PK92 PW680 PS970 PA507 PG675 PY595 PE51 PH63 PL48 PT351 PR1 QA974 RE262 RO40 RU7 RW250 BL590 SH290 KN1 LC1 MF590 PM508 VC1 WS685 SM378 ST239 SA966 SN221 RS381 SC248 SL232 SG65 SX1 SK421 SI386 SB677 SO252 ZA27 KR82 SS211 ES34 LK94 SD249 SR597 SJ47 SE46 CH41 SY963 TW886 TJ992 TZ255 TH66 TL670 TG228 TK690 TO676 TT1 TN216 TR90 TM993 TC1 TV688 UG256 UA380 AE971 GB44 UY598 VI1 UZ998 VU678 VA39 VE58 VN84 WF681 EH212 YE967 ZM260 ZW263';
export const COUNTRIES: { iso: string; dial: string }[] = COUNTRY_CODES.split(' ').map(s => ({ iso: s.slice(0, 2), dial: s.slice(2) }));
const DIAL_OF = new Map(COUNTRIES.map(c => [c.iso, c.dial]));
export const PRIMARY: Record<string, string> = { 1: 'US', 7: 'RU', 39: 'IT', 44: 'GB', 47: 'NO', 61: 'AU', 212: 'MA', 262: 'RE', 290: 'SH', 358: 'FI', 590: 'GP', 599: 'CW' };
export const DEFAULT_COUNTRY = 'CO';
export const isCountry = (iso: unknown) => DIAL_OF.has(String(iso || '').toUpperCase());
export const dialOf = (iso: unknown) => DIAL_OF.get(String(iso || '').toUpperCase()) || DIAL_OF.get(DEFAULT_COUNTRY);

/** Is this form field a phone? (role 'phone', or type 'tel'.) */
export const isPhoneField = (f: { role?: unknown; type?: unknown } | null | undefined) => !!f && (f.role === 'phone' || f.type === 'tel');

export function parseE164(value: unknown, prefer?: string | null): { iso: string; dial: string; national: string } | null {
    const m = /^\+(\d{8,15})$/.exec(String(value || '').replace(/[\s().-]/g, ''));
    if (!m) return null;
    const digits = m[1];
    for (const len of [3, 2, 1]) {
        const dial = digits.slice(0, len);
        const all = COUNTRIES.filter(c => c.dial === dial);
        if (!all.length) continue;
        const pref = String(prefer || '').toUpperCase();
        const iso = all.some(c => c.iso === pref) ? pref : (PRIMARY[dial] || all[0].iso);
        return { iso, dial, national: digits.slice(len) };
    }
    return null;
}

export function toE164(raw: unknown, defaultIso?: string | null): string | null {
    const first = String(raw == null ? '' : raw).split(/[/,;|]|\s+y\s+|\s+o\s+/i)[0].trim();
    if (!first) return null;
    if (/[^\d\s().+-]/.test(first)) return null;
    let digits = first.replace(/\D/g, '');
    let dial;
    if (first.startsWith('+')) dial = '';
    else if (digits.startsWith('00')) { digits = digits.slice(2); dial = ''; }
    else {
        digits = digits.replace(/^0+/, '');
        dial = dialOf(defaultIso);
        // Already carrying the default country's code without «+» («573001234567»): not prefixed twice.
        if (digits.startsWith(dial) && digits.length >= dial.length + 9) dial = '';
    }
    const full = `${dial}${digits}`;
    if (full.length > 15 || full.length < 8) return null;
    const parsed = parseE164(`+${full}`);
    if (!parsed || parsed.national.length < 4) return null;
    return `+${full}`;
}

/** The digits wa.me wants (country code + national number), or null: `https://wa.me/<digits>`. */
export const waDigits = (raw: unknown, defaultIso?: string | null) => { const e = toE164(raw, defaultIso); return e ? e.slice(1) : null; };

/** A stored value split for the selector: { iso, national } — a value without «+» is national in `defaultIso`. */
export function splitPhone(value: unknown, defaultIso?: string | null): { iso: string; national: string } {
    const iso0 = isCountry(defaultIso) ? String(defaultIso).toUpperCase() : DEFAULT_COUNTRY;
    const s = String(value == null ? '' : value).trim();
    const p = s.startsWith('+') || s.startsWith('00') ? parseE164(`+${s.replace(/\D/g, '').replace(/^00/, '')}`, iso0) : null;
    return p ? { iso: p.iso, national: p.national } : { iso: iso0, national: s };
}
/** The value a selector sends: E.164 from the country and the national number, '' when the number is empty. */
export function joinPhone(iso: string, national: string): string {
    const digits = String(national || '').replace(/\D/g, '').replace(/^0+/, '');
    return digits ? `+${dialOf(iso)}${digits}` : '';
}

/** «🇨🇴» for «CO» (regional indicator letters). */
export const flagOf = (iso: string) => String(iso || '').toUpperCase().replace(/[A-Z]/g, ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65));

/** The selector's options in the screen's language, sorted by name: { iso, dial, name, label }. */
export function countryOptions(lang = 'es') {
    let names: any = null;
    try { names = new Intl.DisplayNames([lang], { type: 'region' }); } catch { names = null; }
    const nameOf = (iso: string) => { try { return (names && names.of(iso)) || iso; } catch { return iso; } };
    return COUNTRIES.map(c => ({ ...c, name: nameOf(c.iso) }))
        .map(c => ({ ...c, label: `${c.name} (+${c.dial})` }))
        .sort((a, b) => a.name.localeCompare(b.name, lang));
}
