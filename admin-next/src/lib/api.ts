const getBaseUrl = () => {
    if (typeof window !== 'undefined') {
        // Client-side: Always use relative URL so it works behind Gateway on any port/protocol
        return '/api/v1';
    }
    // Server-side (SSR):
    try {
        // Dynamically require fs/path to avoid bundling issues on client
        // This block only runs on server
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');

        // Locate wordjs-config.json (assuming we are in admin-next root or similar)
        // process.cwd() in Next.js usually points to the project root (admin-next)
        // The config is in ../backend/wordjs-config.json
        const configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');

        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.gatewayPort) {
                return `http://localhost:${config.gatewayPort}/api/v1`;
            }
        }
    } catch (e) {
        // ignore
    }

    return "http://localhost:3000/api/v1";
};

const API_URL = getBaseUrl();

type RequestMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ApiOptions {
    method?: RequestMethod;
    body?: unknown;
    headers?: Record<string, string>;
    responseType?: "json" | "text" | "blob";
}

export async function api<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    // Note: Token is now sent via HttpOnly cookie automatically
    // We no longer read from localStorage for security

    const isFormData = options.body instanceof FormData;
    const headers: Record<string, string> = {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
    };

    const res = await fetch(`${API_URL}${endpoint}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? (isFormData ? (options.body as FormData) : JSON.stringify(options.body)) : undefined,
        cache: "no-store",
        credentials: "include", // SECURITY: Send HttpOnly cookies with requests
    });

    if (!res.ok) {
        let errorMessage = `HTTP ${res.status} ${res.statusText}`;
        try {
            const error = await res.json();

            // Handle global redirects (Installation/Migration)
            if (typeof window !== 'undefined' && error.redirect) {
                // Prevent infinite redirect loops if already on the page
                if (!window.location.pathname.startsWith(error.redirect)) {
                    window.location.href = error.redirect;
                    // Don't throw, just interrupt flow or throw specific redirect error
                    throw new Error(`Redirecting to ${error.redirect}...`);
                }
            }

            errorMessage = error.message || error.error || errorMessage;
        } catch {
            // If not JSON, try to read text (e.g. HTML 500 error)
            const text = await res.text().catch(() => "");
            if (text) errorMessage += `: ${text.slice(0, 100)}`;
        }
        throw new Error(errorMessage);
    }

    if (options.responseType === "text") {
        return res.text() as unknown as T;
    }
    if (options.responseType === "blob") {
        return res.blob() as unknown as T;
    }

    return res.json();
}

// Convenience methods
export const apiGet = <T>(endpoint: string) => api<T>(endpoint);
export const apiPost = <T>(endpoint: string, body: unknown) => api<T>(endpoint, { method: "POST", body });
export const apiPut = <T>(endpoint: string, body: unknown) => api<T>(endpoint, { method: "PUT", body });
export const apiDelete = <T>(endpoint: string) => api<T>(endpoint, { method: "DELETE" });

// Typed API calls
export interface Post {
    id: number;
    title: string;
    slug: string;
    content: string;
    excerpt: string;
    status: string;
    type: string;
    date: string;
    author: { id: number; displayName: string };
    commentStatus: string;
    meta?: Record<string, any>;
}

export interface Category {
    id: number;
    name: string;
    slug: string;
    count: number;
}

export interface User {
    id: number;
    username: string;
    email: string;
    displayName: string;
    role: string;
    capabilities: string[];
}

export interface Role {
    name: string;
    capabilities: string[];
}

export interface Plugin {
    name: string;
    slug: string;
    description: string;
    version: string;
    active: boolean;
    permissions?: {
        scope: string;
        access: string;
        reason: string;
    }[];
}

export interface Theme {
    name: string;
    slug: string;
    description: string;
    version: string;
    active: boolean;
}

export interface Stats {
    posts: number;
    pages: number;
    comments: number;
    users: number;
}

export interface Comment {
    id: number;
    postId: number;
    author: string;
    authorEmail: string;
    authorUrl: string;
    date: string;
    content: string;
    status: string;
    authorAvatarUrl?: string;
    parent?: number;
    replies?: Comment[];
}

export interface MenuItem {
    id: number;
    title: string;
    url: string;
    type?: string;
    target?: string;
    objectId?: number;
    parent_id: number | null;
    order: number;
    children?: MenuItem[];
}

export interface Menu {
    id: number;
    name: string;
    slug: string;
    items: MenuItem[];
}

// API endpoints
export const postsApi = {
    list: (type = "post", status?: string) => {
        const params = new URLSearchParams({ type });
        if (status) params.append("status", status);
        return apiGet<Post[]>(`/posts?${params.toString()}`);
    },
    get: (id: number) => apiGet<Post>(`/posts/${id}`),
    getBySlug: (slug: string) => apiGet<Post>(`/posts/slug/${slug}`), // New method
    create: (data: Partial<Post>) => apiPost<Post>("/posts", data),
    update: (id: number, data: Partial<Post>) => apiPut<Post>(`/posts/${id}`, data),
    delete: (id: number) => apiDelete(`/posts/${id}`),
};

export const categoriesApi = {
    list: () => apiGet<Category[]>("/categories"),
    create: (data: { name: string; slug?: string }) => apiPost<Category>("/categories", data),
    delete: (id: number) => apiDelete(`/categories/${id}`),
};

export const usersApi = {
    list: () => apiGet<User[]>("/users"),
    get: (id: number) => apiGet<User>(`/users/${id}`),
    create: (data: Partial<User> & { password: string }) => apiPost<User>("/users", data),
    update: (id: number, data: Partial<User>) => apiPut<User>(`/users/${id}`, data),
    delete: (id: number) => apiDelete(`/users/${id}`),
};

export const commentsApi = {
    list: (params: { post?: number; status?: string; page?: number; per_page?: number } = {}) => {
        const query = new URLSearchParams();
        if (params.post) query.append('post', String(params.post));
        if (params.status) query.append('status', params.status);
        if (params.page) query.append('page', String(params.page));
        if (params.per_page) query.append('per_page', String(params.per_page));
        return apiGet<Comment[]>(`/comments?${query.toString()}`);
    },
    get: (id: number) => apiGet<Comment>(`/comments/${id}`),
    create: (data: { post: number; content: string; author_name: string; author_email: string; author_url?: string; parent?: number }) => apiPost<Comment>("/comments", data),
    update: (id: number, data: Partial<Comment>) => apiPut<Comment>(`/comments/${id}`, data),
    delete: (id: number, force = false) => apiDelete<{ deleted: boolean }>(`/comments/${id}?force=${force}`),
    approve: (id: number) => apiPost<Comment>(`/comments/${id}/approve`, {}),
    spam: (id: number) => apiPost<Comment>(`/comments/${id}/spam`, {}),
};

export const pluginsApi = {
    list: () => apiGet<Plugin[]>("/plugins"),
    activate: (slug: string) => apiPost(`/plugins/${slug}/activate`, {}),
    deactivate: (slug: string) => apiPost(`/plugins/${slug}/deactivate`, {}),
    delete: (slug: string, password?: string) => api<{ success: boolean; message: string }>(`/plugins/${slug}`, {
        method: "DELETE",
        body: { password }
    }),
    download: (slug: string) => {
        // Direct window location change for file download
        // Cookies are sent automatically if SameSite is Lax/None
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/plugins/${slug}/download`;
    },
    upload: (formData: FormData) => api<{ success: boolean; message: string }>("/plugins/upload", {
        method: "POST",
        body: formData,
        headers: {} // Let browser set boundary
    }),
};

export interface Theme {
    slug: string;
    name: string;
    version: string;
    description: string;
    author: string;
    screenshot?: string;
    active: boolean;
}

export const themesApi = {
    list: () => apiGet<Theme[]>("/themes"),
    activate: (slug: string) => apiPost(`/themes/${slug}/activate`, {}),
    upload: (file: File, onProgress?: (percent: number) => void) => {
        return new Promise<{ success: boolean; message: string; slug: string }>((resolve, reject) => {
            const token = localStorage.getItem("wordjs_token");
            const formData = new FormData();
            formData.append("theme", file);

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_URL}/themes/upload`);
            xhr.withCredentials = true; // Use HttpOnly cookies

            if (onProgress) {
                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        onProgress((event.loaded / event.total) * 100);
                    }
                };
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    try {
                        const err = JSON.parse(xhr.responseText);
                        reject(new Error(err.error || err.message || "Upload failed"));
                    } catch {
                        reject(new Error("Upload failed"));
                    }
                }
            };

            xhr.onerror = () => reject(new Error("Network error"));
            xhr.send(formData);
        });
    },
    delete: (slug: string) => apiDelete(`/themes/${slug}`),
    download: (slug: string) => {
        const baseUrl = getBaseUrl();
        window.location.href = `${baseUrl}/themes/${slug}/download`;
    },
};

export const settingsApi = {
    get: () => apiGet<Record<string, string>>("/settings"),
    update: (data: Record<string, string>) => apiPut("/settings", data),
};

export const rolesApi = {
    list: () => apiGet<Record<string, Role>>("/roles"),
    getCapabilities: () => apiGet<string[]>("/roles/capabilities"),
    save: (slug: string, data: { name: string; capabilities: string[] }) => apiPost<Role>("/roles", { slug, ...data }),
    delete: (slug: string) => apiDelete(`/roles/${slug}`),
};

// Media API
export interface MediaItem {
    id: number;
    title: string;
    guid: string;
    sourceUrl: string;
    mimeType: string;
    date: string;
}

export const mediaApi = {
    list: () => apiGet<MediaItem[]>("/media"),
    upload: (formData: FormData) => api<MediaItem>("/media", {
        method: "POST",
        body: formData,
        headers: {}
    }),
    uploadWithProgress: (formData: FormData, onProgress: (progress: number) => void): Promise<MediaItem> => {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_URL}/media`);
            xhr.withCredentials = true; // Use HttpOnly cookies

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percentComplete = (event.loaded / event.total) * 100;
                    onProgress(percentComplete);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const response = JSON.parse(xhr.responseText);
                        resolve(response);
                    } catch (e) {
                        reject(new Error("Invalid JSON response"));
                    }
                } else {
                    reject(new Error(`Upload failed: ${xhr.statusText}`));
                }
            };

            xhr.onerror = () => reject(new Error("Network error"));

            xhr.send(formData);
        });
    },
    delete: (id: number) => apiDelete(`/media/${id}`),
};

export const menusApi = {
    list: () => apiGet<Menu[]>("/menus"),
    get: (id: number) => apiGet<Menu>(`/menus/${id}`),
    getByLocation: (location: string) => apiGet<Menu>(`/menus/location/${location}`),
    getLocations: () => apiGet<Record<string, number>>("/menus/locations"),
    create: (data: { name: string; slug?: string; description?: string }) => apiPost<Menu>("/menus", data),
    update: (id: number, data: Partial<Menu>) => apiPut<Menu>(`/menus/${id}`, data),
    delete: (id: number) => apiDelete(`/menus/${id}`),
    // Locations
    setLocation: (id: number, location: string) => apiPost(`/menus/${id}/location`, { location }),
    // Items
    addItem: (menuId: number, data: Partial<MenuItem>) => apiPost<MenuItem>(`/menus/${menuId}/items`, data),
    updateItem: (itemId: number, data: Partial<MenuItem>) => apiPut<MenuItem>(`/menus/items/${itemId}`, data),
    deleteItem: (itemId: number) => apiDelete(`/menus/items/${itemId}`),
};

export interface Widget {
    id: string;
    name: string;
    description: string;
}

export interface Sidebar {
    id: string;
    name: string;
    description: string;
    widgets: string[]; // List of instance keys like "text-k12345"
}

export const widgetsApi = {
    listWidgets: () => apiGet<Widget[]>("/widgets"),
    listSidebars: () => apiGet<Sidebar[]>("/widgets/sidebars"),
    addToSidebar: (sidebarId: string, widgetId: string, settings: any = {}) => apiPost<{ success: boolean; instanceKey: string }>(`/widgets/sidebars/${sidebarId}`, { widgetId, settings }),
    updateInstance: (widgetId: string, instanceId: string, settings: any) => apiPut<{ success: boolean }>(`/widgets/${widgetId}/instances/${instanceId}`, { settings }),
    removeFromSidebar: (sidebarId: string, instanceKey: string) => apiDelete<{ success: boolean }>(`/widgets/sidebars/${sidebarId}/${instanceKey}`),
    reorderSidebar: (sidebarId: string, widgets: string[]) => apiPost<{ success: boolean }>(`/widgets/sidebars/${sidebarId}/reorder`, { widgets }),
    renderSidebar: (sidebarId: string) => api<string>(`/widgets/sidebars/${sidebarId}/render`, { headers: { Accept: "text/html" }, responseType: "text" }),
};

// =============================================================================
// PLUGIN APIs
// =============================================================================
// Plugin-specific types and APIs have been moved to their respective plugins.
// Each plugin now defines its own types and API helpers locally.
// See: plugins/<plugin-name>/client/components/*.tsx
// =============================================================================

