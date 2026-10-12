/**
 * THE ADMIN'S STACKING SCALE (z-index), in one place.
 *
 * The admin shell (app/admin/DashboardLayoutClient.tsx + components/Sidebar.tsx) sits at 5000-5003: the
 * phone header bar, the phone menu's backdrop, the sidebar, and the desktop collapse toggle. Core dialogs
 * used to be `fixed inset-0 z-50` (or z-[100]) rendered INSIDE the page: below all of that. On a phone the
 * «Nuevo usuario» dialog opened under the header, its title and close button cut off; on a desktop the
 * sidebar was never dimmed and its collapse toggle was drawn over the dialog's corner. The global
 * confirm/alert dialog (useModal) sat under any plugin overlay too.
 *
 * Every core dialog now renders through components/DialogLayer.tsx: portalled to <body> (no page
 * ancestor's stacking context or transform can trap it) at one of the layers below. The 6000 band is the
 * one conference-manager's own overlays already use (marketplace/plugins/conference-manager/client/lib/
 * overlay.ts: 6010-6090), so a core dialog, a plugin overlay and the dropdowns opened from either stack
 * in a predictable order:
 *
 *   shell 5000-5003  <  dialog 6000  <  plugin overlays 6010-6090  <  dialogOver 6100  <  popover 6500  <  toast 9999
 *
 * Toasts stay above every dialog (a save error must never hide behind the dialog that caused it).
 * components/__tests__/dialogLayer.test.tsx reads the shell's and the toasts' classes and fails if this order
 * stops holding.
 */
export const ADMIN_Z = {
    /** Phone header bar (DashboardLayoutClient: `z-[5000]`). */
    mobileHeader: 5000,
    /** Phone menu backdrop (Sidebar: `z-[5001]`). */
    sidebarBackdrop: 5001,
    /** The sidebar / phone menu (Sidebar: `z-[5002]`). */
    sidebar: 5002,
    /** Desktop collapse toggle (DashboardLayoutClient: `z-[5003]`). */
    sidebarToggle: 5003,
    /** A dialog, drawer or full-screen blocker opened from a page. */
    dialog: 6000,
    /** A dialog that opens OVER another dialog or a plugin overlay: confirm/alert (useModal), a secret shown once, the media picker. */
    dialogOver: 6100,
    /** A list portalled out of a field (ModernSelect, ui/Select): above whatever dialog it was opened from. */
    popover: 6500,
    /** Toasts (ToastContext: `z-[9999]`). */
    toast: 9999,
} as const;

export type DialogLayerName = "dialog" | "dialogOver";
