/**
 * Resolve a sidebar instance key ("<widgetId>-<instanceId>") to its widget id.
 *
 * Mirror of parseInstanceKey in backend/src/core/widgets.ts. Neither half is delimiter-free: widget ids
 * may contain '-' (plugin widgets) and instance ids are UUIDs (four hyphens), so splitting on the first
 * or last '-' names the wrong widget. The key is matched against the REGISTERED widget ids as a prefix,
 * longest first. When none matches (the widget's plugin was removed) the text before the first '-' is
 * returned, which is only used as a label.
 */
export function widgetIdFromInstanceKey(instanceKey: string, registeredIds: readonly string[]): string {
    let best = '';
    for (const id of registeredIds) {
        if ((instanceKey === id || instanceKey.startsWith(`${id}-`)) && id.length > best.length) best = id;
    }
    return best || instanceKey.split('-')[0];
}
