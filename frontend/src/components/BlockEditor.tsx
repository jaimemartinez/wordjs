// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";
import EditorJS, { OutputData } from "@editorjs/editorjs";
// @ts-ignore
import Header from "@editorjs/header";
// @ts-ignore
import List from "@editorjs/list";
// @ts-ignore
import Quote from "@editorjs/quote";
// @ts-ignore
import Paragraph from "@editorjs/paragraph";
// @ts-ignore
import ImageTool from "@editorjs/image";
// @ts-ignore
import ColorPlugin from "editorjs-text-color-plugin";
import MediaPickerModal from "./MediaPickerModal";

// Plugin editor tools are loaded dynamically from /api/v1/plugins/registry
// See loadEditorTools() below for dynamic tool loading


interface BlockEditorProps {
    initialContent?: string; // HTML content from DB (fallback)
    initialBlocks?: OutputData; // JSON blocks from DB (primary)
    onChange: (html: string, blocks?: OutputData) => void;
}

// ... inside the file ...



// Custom Tool Class Definition
class CustomImageTool extends ImageTool {
    constructor({ data, config, api, readOnly, block }: any) {
        super({ data, config, api, readOnly, block });
        this.config = config;
        this.api = api;
        this.block = block;
    }

    render() {
        const ui = super.render();
        if (!this.readOnly) {
            const button = document.createElement('div');
            button.classList.add('cdx-button');
            button.innerHTML = '<i class="fa-solid fa-images"></i> Select from Media';
            button.style.marginTop = '10px';
            button.style.cursor = 'pointer';

            button.onclick = () => {
                if (this.config.onSelectFromMedia) {
                    this.config.onSelectFromMedia((url: string) => {
                        (this as any).onUpload({
                            success: 1,
                            file: {
                                url: url
                            }
                        });
                    });
                }
            };
            ui.appendChild(button);
        }
        return ui;
    }

    onUpload(response: any) {
        if (response.file && response.file.url) {
            // Update the block using the API to ensure UI re-renders
            this.api.blocks.update(this.block.id, {
                file: {
                    url: response.file.url
                },
                caption: '',
                withBorder: false,
                withBackground: false,
                stretched: false
            });

            // Manually trigger change to update Live Preview/Parent
            if (this.config.triggerChange) {
                this.config.triggerChange();
            }
        }
    }
}

// Custom Section Tool
class CustomSectionTool {
    data: any;
    api: any;
    config: any; // Added config
    wrapper: HTMLElement | undefined;
    settings: { name: string; label: string; icon: string; }[];

    static get toolbox() {
        return {
            title: 'Section',
            icon: '<i class="fa-solid fa-layer-group"></i>'
        };
    }

    constructor({ data, api, config }: any) {
        this.data = {
            text: data.text || '',
            style: data.style || 'default',
            anchor: data.anchor || ''
        };
        this.api = api;
        this.config = config || {}; // Store config
        this.settings = [
            { name: 'default', label: 'Default', icon: '<i class="fa-regular fa-square"></i>' },
            { name: 'highlight', label: 'Highlight (Gray)', icon: '<i class="fa-solid fa-highlighter"></i>' },
            { name: 'primary', label: 'Primary (Blue)', icon: '<i class="fa-solid fa-fill-drip"></i>' },
            { name: 'card', label: 'Card (Shadow)', icon: '<i class="fa-solid fa-id-card"></i>' },
        ];
    }

    render() {
        this.wrapper = document.createElement('div');
        this.wrapper.classList.add('cdx-section');
        this._applyStyle(this.data.style);

        const content = document.createElement('div');
        content.classList.add('cdx-section__content');
        content.contentEditable = 'true';
        content.innerHTML = this.data.text;

        content.addEventListener('input', () => {
            this.data.text = content.innerHTML;
        });

        this.wrapper.appendChild(content);
        return this.wrapper;
    }

    save(blockContent: HTMLElement) {
        const content = blockContent.querySelector('.cdx-section__content');
        return {
            text: content ? content.innerHTML : '',
            style: this.data.style,
            anchor: this.data.anchor
        };
    }

    renderSettings() {
        const wrapper = document.createElement('div');

        // Style Buttons
        const buttonsWrapper = document.createElement('div');
        buttonsWrapper.style.marginBottom = '10px';

        this.settings.forEach(tune => {
            const button = document.createElement('div');
            button.classList.add('cdx-settings-button');
            button.innerHTML = tune.icon;
            button.title = tune.label;

            if (this.data.style === tune.name) {
                button.classList.add('cdx-settings-button--active');
            }

            button.onclick = () => {
                this._toggleTune(tune.name);

                // Reset buttons state
                const buttons = buttonsWrapper.querySelectorAll('.cdx-settings-button');
                buttons.forEach(b => b.classList.remove('cdx-settings-button--active'));
                button.classList.add('cdx-settings-button--active');
            };

            buttonsWrapper.appendChild(button);
        });
        wrapper.appendChild(buttonsWrapper);

        // Anchor Input
        const inputWrapper = document.createElement('div');
        inputWrapper.style.paddingTop = '10px';
        inputWrapper.style.borderTop = '1px solid #eee';

        const input = document.createElement('input');
        input.placeholder = 'Anchor ID (e.g. contact)';
        input.value = this.data.anchor || '';
        input.style.width = '100%';
        input.style.padding = '5px';
        input.style.fontSize = '12px';
        input.style.border = '1px solid #ddd';
        input.style.borderRadius = '4px';

        input.oninput = (e: any) => {
            this.data.anchor = e.target.value;
            // Trigger change
            if (this.config.triggerChange) {
                this.config.triggerChange();
            }
        };

        inputWrapper.appendChild(input);
        wrapper.appendChild(inputWrapper);

        return wrapper;
    }

    _toggleTune(tuneName: string) {
        this.data.style = tuneName;
        this._applyStyle(tuneName);
    }

    _applyStyle(styleName: string) {
        if (!this.wrapper) return;

        // Reset valid classes
        this.wrapper.className = 'cdx-section p-6 rounded-lg my-4'; // Base classes

        switch (styleName) {
            case 'highlight':
                this.wrapper.classList.add('bg-gray-100', 'border-l-4', 'border-gray-500');
                break;
            case 'primary':
                this.wrapper.classList.add('bg-blue-600', 'text-white');
                break;
            case 'card':
                this.wrapper.classList.add('bg-white', 'shadow-lg', 'border', 'border-gray-100');
                break;
            default: // default
                this.wrapper.classList.add('bg-transparent', 'border', 'border-dashed', 'border-gray-300');
                break;
        }
    }
}

export default function BlockEditor({ initialContent, initialBlocks, onChange }: BlockEditorProps) {
    const editorRef = useRef<EditorJS | null>(null);
    const holderId = "editorjs-holder";
    const [isMounted, setIsMounted] = useState(false);

    // Media Picker State
    const [isMediaPickerOpen, setIsMediaPickerOpen] = useState(false);
    const [mediaPickerCallback, setMediaPickerCallback] = useState<((url: string) => void) | null>(null);

    const handleSelectFromMedia = (callback: (url: string) => void) => {
        setMediaPickerCallback(() => callback);
        setIsMediaPickerOpen(true);
    };

    // Helper to parser HTML to Blocks (Basic)
    // Real implementation would use a robust parser.
    // Here we use a trick: If content is HTML, we wrap it in a single paragraph or attempt basic import.
    // EditorJS doesn't support HTML import natively well without robust tools.
    // STRATEGY: For now, we only treat content as blocks if it looks like JSON.
    // If it is HTML, we leave it as a "Raw HTML" block or just Paragraph.

    useEffect(() => {
        setIsMounted(true);
    }, []);

    useEffect(() => {
        if (!isMounted) return;

        if (editorRef.current) {
            return;
        }

        let data: OutputData | undefined = initialBlocks;

        // Fallback: Try to parse initialContent as JSON if initialBlocks is missing
        if (!data && initialContent && initialContent.trim().startsWith("{")) {
            try {
                data = JSON.parse(initialContent);
            } catch (e) {
                console.error("Failed to parse initial content", e);
            }
        }

        let editor: EditorJS;
        editor = new EditorJS({
            holder: holderId,
            data: data,
            placeholder: "Start writing your story...",
            tools: {
                header: Header,
                list: List,
                quote: Quote,
                paragraph: {
                    class: Paragraph,
                    inlineToolbar: true,
                },
                section: {
                    class: CustomSectionTool,
                    config: {
                        triggerChange: async () => {
                            if (editor && typeof editor.save === "function") {
                                const savedData = await editor.save();
                                const html = parseBlocksToHtml(savedData);
                                onChange(html, savedData);
                            }
                        }
                    }
                },
                // Plugin editor tools would be loaded dynamically here
                // TODO: Implement dynamic tool loading from /api/v1/plugins/registry
                Color: {
                    class: ColorPlugin,
                    config: {
                        colorCollections: ['#EC7878', '#9c27b0', '#673ab7', '#3f51b5', '#0070FF', '#03a9f4', '#00bcd4', '#4CAF50', '#8BC34A', '#CDDC39', '#FFF'],
                        defaultColor: '#FF1300',
                        type: 'text',
                        customPicker: true
                    }
                },
                Marker: {
                    class: ColorPlugin,
                    config: {
                        colorCollections: ['#EC7878', '#9c27b0', '#673ab7', '#3f51b5', '#0070FF', '#03a9f4', '#00bcd4', '#4CAF50', '#8BC34A', '#CDDC39', '#FFF'],
                        defaultColor: '#FFBF00',
                        type: 'marker',
                        icon: `<svg fill="#000000" height="200px" width="200px" version="1.1" id="Icons" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32" xml:space="preserve"><g><path d="M17.6,6L6.9,16.7c-0.2,0.2-0.3,0.4-0.3,0.6L6,23.9c0,0.3,0.1,0.6,0.3,0.8C6.5,24.9,6.7,25,7,25c0.1,0,0.2,0,0.3-0.1l6.6-0.6c0.2,0,0.4-0.1,0.6-0.3L25.2,13.4L17.6,6z"/><path d="M26.4,12l1.4-1.4c1.2-1.2,1.1-3.1-0.1-4.3l-3-3c-0.6-0.6-1.3-0.9-2.2-0.9c-0.8,0-1.6,0.3-2.2,0.9L19,4.6L26.4,12z"/></g><g><path d="M28,29H4c-0.6,0-1-0.4-1-1s0.4-1,1-1h24c0.6,0,1,0.4,1,1S28.6,29,28,29z"/></g></svg>`
                    }
                },
                image: {
                    class: CustomImageTool,
                    config: {
                        onSelectFromMedia: handleSelectFromMedia,
                        triggerChange: async () => {
                            if (editor && typeof editor.save === "function") {
                                const savedData = await editor.save();
                                const html = parseBlocksToHtml(savedData);
                                onChange(html, savedData);
                            }
                        },
                        uploader: {
                            uploadByFile(file: File) {
                                const formData = new FormData();
                                formData.append("file", file);
                                return mediaApi.upload(formData).then((media) => {
                                    return {
                                        success: 1,
                                        file: {
                                            url: media.guid,
                                        }
                                    };
                                });
                            }
                        }
                    }
                }
            },
            onChange: async () => {
                if (editor && typeof editor.save === "function") {
                    const savedData = await editor.save();
                    const html = parseBlocksToHtml(savedData);
                    onChange(html, savedData);
                }
            },
        });

        editorRef.current = editor;

        return () => {
            if (editorRef.current && typeof editorRef.current.destroy === "function") {
                editorRef.current.destroy();
                editorRef.current = null;
            }
        };
    }, [isMounted]);

    return (
        <>
            <div className="prose max-w-none border rounded-lg p-4 min-h-[400px] bg-white">
                <style jsx global>{`
                    .cdx-section {
                        margin: 1em 0;
                        padding: 1em;
                        border-radius: 8px;
                    }
                    .cdx-settings-button {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        width: 30px;
                        height: 30px;
                        border-radius: 4px;
                        cursor: pointer;
                        margin-right: 5px;
                    }
                    .cdx-settings-button:hover, .cdx-settings-button--active {
                        background-color: #eff2f5;
                        color: #388ae5;
                    }
                    /* Styling Preview inside Editor */
                    .cdx-section.bg-gray-100 { background-color: #f3f4f6; border-left: 4px solid #6b7280; }
                    .cdx-section.bg-blue-600 { background-color: #2563eb; color: white; }
                    .cdx-section.shadow-lg { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); border: 1px solid #f3f4f6; }
                    .cdx-section.border-dashed { border: 2px dashed #d1d5db; }
                `}</style>
                <div id={holderId} className="min-h-[300px]"></div>
            </div>

            <MediaPickerModal
                isOpen={isMediaPickerOpen}
                onClose={() => setIsMediaPickerOpen(false)}
                onSelect={(item) => {
                    if (mediaPickerCallback) {
                        mediaPickerCallback(item.guid);
                        setMediaPickerCallback(null);
                    }
                }}
            />
        </>
    );
}

import sanitizeHtml from "sanitize-html";

// Basic Parser for Demo
function parseBlocksToHtml(data: OutputData): string {
    let html = "";
    data.blocks.forEach((block) => {
        switch (block.type) {
            case "header":
                html += `<h${block.data.level}>${block.data.text}</h${block.data.level}>`;
                break;
            case "paragraph":
                // Preserve empty lines
                if (!block.data.text || block.data.text.trim() === '') {
                    html += `<p><br></p>`;
                } else {
                    html += `<p>${block.data.text}</p>`;
                }
                break;
            case "section": // PARSER FOR SECTION
                let classes = "p-6 rounded-lg my-8";
                switch (block.data.style) {
                    case 'highlight': classes += " bg-gray-100 border-l-4 border-gray-500"; break;
                    case 'primary': classes += " bg-blue-600 text-white"; break;
                    case 'card': classes += " bg-white shadow-lg border border-gray-100"; break;
                    default: classes += " bg-gray-50 border border-transparent"; break;
                }
                const idAttr = block.data.anchor ? ` id="${block.data.anchor}"` : '';
                html += `<div class="${classes}"${idAttr}>${block.data.text}</div>`;
                break;
            case "list":
                const tag = block.data.style === "ordered" ? "ol" : "ul";
                const items = block.data.items.map((i: any) => {
                    const content = typeof i === 'string' ? i : i.content;
                    return `<li>${content.replace(/\n/g, "<br>")}</li>`;
                }).join("");
                html += `<${tag}>${items}</${tag}>`;
                break;
            case "quote":
                html += `<blockquote>${block.data.text}<br><cite>${block.data.caption}</cite></blockquote>`;
                break;
            case "image":
                html += `<figure><img src="${block.data.file.url}" alt="${block.data.caption || ''}" /><figcaption>${block.data.caption || ''}</figcaption></figure>`;
                break;
            case "card-gallery":
                html += `<div class="gallery-block">[cards]</div>`;
                break;
            case "video-gallery":
                html += `<div class="video-block">[vgallery]</div>`;
                break;
            default:
                break;
        }
    });

    return sanitizeHtml(html, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'figure', 'figcaption', 'div']),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'img': ['src', 'alt'],
            'div': ['class', 'id']
        }
    });
}
